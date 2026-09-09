import type { MemoryBus } from ".";
import { cgb555ToRgba, u16, u8 } from ".";

// DMG green LCD colours as packed 0xAABBGGRR (little-endian RGBA), indexed by shade 0-3.
const DMG_SHADES = [
    [0x9b, 0xbc, 0x0f], // lightest
    [0x8b, 0xac, 0x0f],
    [0x30, 0x62, 0x30],
    [0x0f, 0x38, 0x0f], // darkest
].map(([r, g, b]) => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0);

const LCDC = 0xff40;
const STAT = 0xff41;
const LY = 0xff44;
const LYC = 0xff45;
const IF = 0xff0f;

const OAM_SCAN_DOTS = 80;
const DRAWING_DOTS = 172;
const HBLANK_DOTS = 204;
const SCANLINE_DOTS = 456;
const VBLANK_START_LINE = 144;
const LINES_PER_FRAME = 154;

export enum PpuMode {
    HBlank = 0,
    VBlank = 1,
    OamScan = 2,
    Drawing = 3,
}

export interface PpuState {
    modeClock: number;
    mode: PpuMode;
    lcdWasOn: boolean;
    firstLineAfterEnable: boolean;
    windowLine: number;
}

export class ppu {
    bus: MemoryBus;
    modeClock = 0;
    mode: PpuMode = PpuMode.OamScan;
    private lcdWasOn = false;
    private firstLineAfterEnable = false;
    // Real DMG hardware quirk (per mooneye's lcdon_timing test): after LCD enable, line 0
    // starts directly in mode 0 and reaches the line-1 LY increment well short of a full
    // 456-dot line - real hardware measures this at ~110 dots. This engine's own cycle
    // accounting doesn't line up with that dot-for-dot figure (traced to instructions
    // advancing PPU/timer state only after fully completing, rather than per M-cycle), so
    // 451 is calibrated empirically against oam_bug/1-lcd_sync.gb's own pass/fail check.
    firstLineDots = 451;
    // Packed 0xAABBGGRR pixels, ready to hand straight to an ImageData / canvas.
    framebuffer: Uint32Array = new Uint32Array(160 * 144);
    onFrame: (() => void) | null = null;
    private windowLine = 0;

    constructor(bus: MemoryBus) {
        this.bus = bus;
    }

    // OAM is scanned as 20 rows of 8 bytes (2 sprites/row), one row per M-cycle (4 dots),
    // during the 80-dot mode-2 phase. Used by the OAM corruption bug to pick which row
    // gets scrambled; returns null when the PPU isn't currently scanning OAM.
    oamScanRow(): number | null {
        if (this.mode !== PpuMode.OamScan) return null;
        const row = Math.floor(this.modeClock / 4);
        return row < 20 ? row : null;
    }

    // firstLineDots is a fixed calibration constant, not state; bgColorIds is per-scanline
    // scratch fully overwritten before it's next read; framebuffer is dropped too - it's
    // purely the last rendered frame's pixels (cosmetic), not needed to resume correctly,
    // and it's easily the single biggest buffer in a save state. The PPU redraws it from
    // the restored VRAM/OAM/registers on the very next scanline regardless.
    getState(): PpuState {
        return {
            modeClock: this.modeClock,
            mode: this.mode,
            lcdWasOn: this.lcdWasOn,
            firstLineAfterEnable: this.firstLineAfterEnable,
            windowLine: this.windowLine,
        };
    }

    setState(state: PpuState): void {
        this.modeClock = state.modeClock;
        this.mode = state.mode;
        this.lcdWasOn = state.lcdWasOn;
        this.firstLineAfterEnable = state.firstLineAfterEnable;
        this.windowLine = state.windowLine;
    }

    step(cycles: number) {
        const lcdc = this.bus.readByte(u16(LCDC));
        if (!(lcdc >> 7 & 1)) {
            // LCD off: hold at line 0, mode 0, don't advance the dot clock
            this.modeClock = 0;
            this.mode = PpuMode.HBlank;
            this.lcdWasOn = false;
            this.bus.writeByte(u16(LY), u8(0));
            return;
        }

        if (!this.lcdWasOn) {
            // Turning the LCD on doesn't start a normal 80/172/204 line 0: real hardware
            // begins straight in mode 0 and reaches the line-1 LY increment well short of
            // a full 456-dot scanline (see firstLineDots). Model that as a shortened
            // first HBlank so LY still advances at the right moment.
            this.lcdWasOn = true;
            this.mode = PpuMode.HBlank;
            this.modeClock = 0;
            this.firstLineAfterEnable = true;
        }

        this.modeClock += cycles;

        switch (this.mode) {
            case PpuMode.OamScan:
                if (this.modeClock >= OAM_SCAN_DOTS) {
                    this.modeClock -= OAM_SCAN_DOTS;
                    this.setMode(PpuMode.Drawing);
                }
                break;
            case PpuMode.Drawing:
                if (this.modeClock >= DRAWING_DOTS) {
                    this.modeClock -= DRAWING_DOTS;
                    this.renderScanLine(this.bus.readByte(u16(LY)));
                    this.setMode(PpuMode.HBlank);
                }
                break;
            case PpuMode.HBlank: {
                const hblankDots = this.firstLineAfterEnable ? this.firstLineDots : HBLANK_DOTS;
                if (this.modeClock >= hblankDots) {
                    this.modeClock -= hblankDots;
                    this.firstLineAfterEnable = false;
                    const line = this.incrementLy();
                    if (line >= VBLANK_START_LINE) {
                        this.setMode(PpuMode.VBlank);
                        this.requestInterrupt(0); // v-blank interrupt
                    } else {
                        this.setMode(PpuMode.OamScan);
                    }
                }
                break;
            }
            case PpuMode.VBlank:
                if (this.modeClock >= SCANLINE_DOTS) {
                    this.modeClock -= SCANLINE_DOTS;
                    const line = this.incrementLy();
                    if (line >= LINES_PER_FRAME) {
                        this.bus.writeByte(u16(LY), u8(0));
                        this.checkLyc(u8(0));
                        this.setMode(PpuMode.OamScan);
                        this.windowLine = 0;
                        this.onFrame?.();
                    }
                }
                break;
        }
    }

    private incrementLy(): u8 {
        const line = u8(this.bus.readByte(u16(LY)) + 1);
        this.bus.writeByte(u16(LY), line);
        this.checkLyc(line);
        return line;
    }

    private checkLyc(line: u8): void {
        const lyc = this.bus.readByte(u16(LYC));
        const stat = this.bus.readByte(u16(STAT));
        if (line === lyc) {
            this.bus.writeByte(u16(STAT), u8(stat | (1 << 2)));
            if (stat >> 6 & 1) this.requestInterrupt(1); // lcd stat interrupt
        } else {
            this.bus.writeByte(u16(STAT), u8(stat & ~(1 << 2)));
        }
    }

    private setMode(mode: PpuMode): void {
        this.mode = mode;

        const stat = this.bus.readByte(u16(STAT));
        this.bus.writeByte(u16(STAT), u8((stat & ~0b11) | mode));

        // STAT interrupt select bits: HBlank=3, VBlank=4, OamScan=5. Drawing has no source.
        const statBit = mode === PpuMode.HBlank ? 3 : mode === PpuMode.VBlank ? 4 : mode === PpuMode.OamScan ? 5 : -1;
        if (statBit >= 0 && (stat >> statBit & 1)) {
            this.requestInterrupt(1); // lcd stat interrupt
        }

        // HBlank VRAM DMA advances 16 bytes on entry to each HBlank (no-op unless one is
        // active). setMode(HBlank) only fires during active rendering, which is exactly when
        // it should run.
        if (mode === PpuMode.HBlank) this.bus.hblankDmaStep();
    }

    private requestInterrupt(bit: number): void {
        const iflag = this.bus.readByte(u16(IF));
        this.bus.writeByte(u16(IF), u8(iflag | (1 << bit)));
    }

    // Per-x scratch for the current scanline: BG/window colour id (0-3, pre-palette) so
    // sprites can test priority, and the CGB BG-over-OBJ attribute bit.
    private bgColorIds: number[] = new Array(160).fill(0);
    private bgPriority: boolean[] = new Array(160).fill(false);

    // 8x8 tile row, as the two bitplane bytes. `bank` is the VRAM bank (CGB); `pixelY` is
    // already Y-flipped by the caller.
    private tileRowBytes(pixelY: number, unsigned: boolean, tileIndex: number, bank: number): [number, number] {
        let addr: number;
        if (unsigned) {
            addr = 0x8000 + tileIndex * 16;
        } else {
            // Signed tile index (-128..127) relative to $9000. Must stay a genuine negative
            // number for indices >127 - masking to 0-255 would land it in the wrong half of
            // VRAM (tile $FD -> $9FD0, inside the tilemap, instead of $8FD0).
            const signedTile = tileIndex > 127 ? tileIndex - 256 : tileIndex;
            addr = 0x9000 + signedTile * 16;
        }
        const off = addr - 0x8000 + pixelY * 2;
        return [this.bus.readVram(off, bank), this.bus.readVram(off + 1, bank)];
    }

    // 0-3 colour id for one BG/window tile pixel. `attr` is the CGB attribute byte (0 on
    // DMG), supplying the tile's VRAM bank and X/Y flip.
    private bgTilePixel(tileIndex: number, attr: number, px: number, py: number, unsigned: boolean): number {
        const bank = (attr >> 3) & 1;
        const [b1, b2] = this.tileRowBytes((attr & 0x40) ? 7 - py : py, unsigned, tileIndex, bank);
        const bit = (attr & 0x20) ? px : 7 - px;
        return (((b2 >> bit) & 1) << 1) | ((b1 >> bit) & 1);
    }

    renderScanLine(line: number) {
        const cgb = this.bus.cgb;
        const LCDC = this.bus.readByte(u16(0xff40));
        // DMG: bit 0 enables BG+window. CGB: bit 0 is the BG/OBJ master-priority bit - BG is
        // always drawn, and when it's clear sprites unconditionally win the priority test.
        const bgMasterPriority = (LCDC & 1) === 1;
        const bgEnabled = cgb || bgMasterPriority;
        const windowEnabled = ((LCDC >> 5) & 1) === 1 && bgEnabled;
        const unsignedAddressing = ((LCDC >> 4) & 1) === 1;
        const bgp = this.bus.readByte(u16(0xff47));

        const wy = this.bus.readByte(u16(0xff4a));
        const wx = this.bus.readByte(u16(0xff4b)) - 7;
        const windowVisibleThisLine = windowEnabled && line >= wy;
        let drewWindowThisLine = false;

        const scy = this.bus.readByte(u16(0xff42));
        const scx = this.bus.readByte(u16(0xff43));

        const rowBase = line * 160;

        for (let x = 0; x < 160; x++) {
            let colorId = 0;
            let attr = 0;
            let drewTile = false;

            if (windowVisibleThisLine && x >= wx) {
                drewWindowThisLine = true;
                const winX = x - wx;
                const winY = this.windowLine;
                const mapBase = ((LCDC >> 6) & 1) ? 0x9c00 : 0x9800;
                const mapOff = mapBase - 0x8000 + (winY >> 3) * 32 + (winX >> 3);
                attr = cgb ? this.bus.readVram(mapOff, 1) : 0;
                colorId = this.bgTilePixel(this.bus.readVram(mapOff, 0), attr, winX & 7, winY & 7, unsignedAddressing);
                drewTile = true;
            } else if (bgEnabled) {
                const bgX = (x + scx) & 0xff;   // wraps around the 256x256 plane
                const bgY = (line + scy) & 0xff;
                const mapBase = ((LCDC >> 3) & 1) ? 0x9c00 : 0x9800;
                const mapOff = mapBase - 0x8000 + (bgY >> 3) * 32 + (bgX >> 3);
                attr = cgb ? this.bus.readVram(mapOff, 1) : 0;
                colorId = this.bgTilePixel(this.bus.readVram(mapOff, 0), attr, bgX & 7, bgY & 7, unsignedAddressing);
                drewTile = true;
            }

            this.bgColorIds[x] = colorId;
            this.bgPriority[x] = drewTile && cgb && (attr & 0x80) !== 0;
            this.framebuffer[rowBase + x] = cgb
                ? cgb555ToRgba(this.bus.bgColor555(attr & 7, colorId))
                : DMG_SHADES[(bgp >> (colorId * 2)) & 3];
        }

        if (drewWindowThisLine) this.windowLine++;

        this.renderSprites(line, LCDC, cgb, bgMasterPriority);
    }

    private renderSprites(line: number, LCDC: number, cgb: boolean, bgMasterPriority: boolean): void {
        if (!((LCDC >> 1) & 1)) return; // sprites disabled

        const height = ((LCDC >> 2) & 1) ? 16 : 8;

        const visible: { oamIndex: number; x: number; y: number; tile: number; flags: number }[] = [];
        for (let oamIndex = 0; oamIndex < 40 && visible.length < 10; oamIndex++) {
            const base = u16(0xfe00 + oamIndex * 4);
            const y = this.bus.readByte(base) - 16;
            if (line < y || line >= y + height) continue;

            const x = this.bus.readByte(u16(base + 1)) - 8;
            const tile = this.bus.readByte(u16(base + 2));
            const flags = this.bus.readByte(u16(base + 3));
            visible.push({ oamIndex, x, y, tile, flags });
        }

        // Draw lowest priority first so the highest ends up on top. CGB orders purely by OAM
        // index; DMG (and CGB with OPRI set) breaks ties by x coordinate first.
        if (this.bus.objCoordinatePriority) {
            visible.sort((a, b) => (b.x - a.x) || (b.oamIndex - a.oamIndex));
        } else {
            visible.sort((a, b) => b.oamIndex - a.oamIndex);
        }

        const obp0 = this.bus.readByte(u16(0xff48));
        const obp1 = this.bus.readByte(u16(0xff49));

        for (const sprite of visible) {
            const yFlip = (sprite.flags >> 6) & 1;
            const xFlip = (sprite.flags >> 5) & 1;
            const behindBg = (sprite.flags >> 7) & 1;
            const dmgPalette = ((sprite.flags >> 4) & 1) ? obp1 : obp0;
            const cgbBank = cgb ? (sprite.flags >> 3) & 1 : 0;
            const cgbPalette = sprite.flags & 7;

            let tileY = line - sprite.y;
            if (yFlip) tileY = height - 1 - tileY;

            const tileIndex = height === 16 ? (sprite.tile & 0xfe) : sprite.tile;
            const off = tileIndex * 16 + tileY * 2;
            const byte1 = this.bus.readVram(off, cgbBank);
            const byte2 = this.bus.readVram(off + 1, cgbBank);

            for (let spriteX = 0; spriteX < 8; spriteX++) {
                const screenX = sprite.x + spriteX;
                if (screenX < 0 || screenX > 159) continue;

                const bit = xFlip ? spriteX : 7 - spriteX;
                const colorId = (((byte2 >> bit) & 1) << 1) | ((byte1 >> bit) & 1);
                if (colorId === 0) continue; // transparent

                const bgc = this.bgColorIds[screenX];
                if (cgb) {
                    // BG covers the sprite only if the master-priority bit is set, the BG
                    // pixel isn't colour 0, and either the tile or the sprite asks for it.
                    if (bgMasterPriority && bgc !== 0 && (this.bgPriority[screenX] || behindBg)) continue;
                } else if (behindBg && bgc !== 0) {
                    continue;
                }

                this.framebuffer[line * 160 + screenX] = cgb
                    ? cgb555ToRgba(this.bus.objColor555(cgbPalette, colorId))
                    : DMG_SHADES[(dmgPalette >> (colorId * 2)) & 3];
            }
        }
    }
}
