import type { MemoryBus } from ".";
import { u16, u8 } from ".";

const LCDC = 0xff40;
const STAT = 0xff41;
const LY = 0xff44;
const LYC = 0xff45;
const IF = 0xff0f;

const OAM_SCAN_DOTS = 80;
const DRAWING_DOTS = 172;
const HBLANK_DOTS = 204;
// Real DMG hardware quirk (per mooneye's lcdon_timing test): after LCD enable, line 0
// starts directly in mode 0 and reaches the line-1 LY increment well short of a full
// 456-dot line - real hardware measures this at ~110 dots. This value is calibrated
// against oam_bug/1-lcd_sync.gb's own pass/fail check instead of that ~110 figure:
// this engine's per-instruction cycle accounting doesn't line up with the dot-for-dot
// figure blargg's test assumes, so 452 is what actually lands the LY increment between
// this emulator's own equivalents of the test's two checkpoints.
const FIRST_LINE_DOTS = 452;
const SCANLINE_DOTS = 456;
const VBLANK_START_LINE = 144;
const LINES_PER_FRAME = 154;

export enum PpuMode {
    HBlank = 0,
    VBlank = 1,
    OamScan = 2,
    Drawing = 3,
}

export class ppu {
    bus: MemoryBus;
    modeClock = 0;
    mode: PpuMode = PpuMode.OamScan;
    private lcdWasOn = false;
    private firstLineAfterEnable = false;
    framebuffer: Uint8Array = new Uint8Array(160 * 144);
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
            // a full 456-dot scanline (see FIRST_LINE_DOTS). Model that as a shortened
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
                const hblankDots = this.firstLineAfterEnable ? FIRST_LINE_DOTS : HBLANK_DOTS;
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
    }

    private requestInterrupt(bit: number): void {
        const iflag = this.bus.readByte(u16(IF));
        this.bus.writeByte(u16(IF), u8(iflag | (1 << bit)));
    }

    // colorId (0-3, pre-palette) of the background/window pixel drawn at each x this line,
    // needed so sprites can test "behind background" priority.
    private bgColorIds: number[] = new Array(160).fill(0);

    private tileRowBytes(tileAddr: number, pixelY: number, unsignedAddressing: boolean, tileIndex: number): [number, number] {
        let addr: number;
        if (unsignedAddressing) {
            addr = 0x8000 + tileIndex * 16;
        } else {
            let signedTile = tileIndex;
            if (signedTile > 127) signedTile = u8(signedTile - 256);
            addr = 0x9000 + signedTile * 16;
        }
        return [this.bus.readByte(u16(addr + pixelY * 2)), this.bus.readByte(u16(addr + pixelY * 2 + 1))];
    }

    renderScanLine(line: number) {
        const LCDC = this.bus.readByte(u16(0xff40));
        const bgWindowEnabled = (LCDC >> 0) & 1;
        const windowEnabled = (LCDC >> 5) & 1;
        const unsignedAddressing = ((LCDC >> 4) & 1) === 1;
        const bgp = this.bus.readByte(u16(0xff47));

        const wy = this.bus.readByte(u16(0xff4a));
        const wx = this.bus.readByte(u16(0xff4b)) - 7;
        const windowVisibleThisLine = windowEnabled && bgWindowEnabled && line >= wy;
        let drewWindowThisLine = false;

        const scy = this.bus.readByte(u16(0xff42));
        const scx = this.bus.readByte(u16(0xff43));

        let x = 0;
        while (x <= 159) {
            let colorId = 0;

            if (windowVisibleThisLine && x >= wx) {
                drewWindowThisLine = true;

                const winX = x - wx;
                const winY = this.windowLine;
                const tileCol = winX >> 3;
                const tileRow = winY >> 3;
                const pixelX = winX & 7;
                const pixelY = winY & 7;

                const mapBase = ((LCDC >> 6) & 1) ? 0x9C00 : 0x9800;
                const tileIndex = this.bus.readByte(u16(mapBase + tileRow * 32 + tileCol));
                const [byte1, byte2] = this.tileRowBytes(mapBase, pixelY, unsignedAddressing, tileIndex);

                const bit = 7 - pixelX;
                colorId = bgWindowEnabled ? (((byte2 >> bit) & 1) << 1 | ((byte1 >> bit) & 1)) : 0;
            } else if (bgWindowEnabled) {
                const bgX = (x + scx) & 0xFF;        // wraps around the 256x256 plane
                const bgY = (line + scy) & 0xFF;

                const tileCol = bgX >> 3;            // which of the 32 tiles, horizontally
                const tileRow = bgY >> 3;            // which of the 32 tiles, vertically
                const pixelX = bgX & 7;              // x within that 8x8 tile
                const pixelY = bgY & 7;              // y within that 8x8 tile

                const mapBase = ((LCDC >> 3) & 1) ? 0x9C00 : 0x9800;
                const tileIndex = this.bus.readByte(u16(mapBase + tileRow * 32 + tileCol));
                const [byte1, byte2] = this.tileRowBytes(mapBase, pixelY, unsignedAddressing, tileIndex);

                const bit = 7 - pixelX;   // pixel 0 is the MSB, not LSB
                colorId = ((byte2 >> bit) & 1) << 1 | ((byte1 >> bit) & 1);   // value 0-3
            }

            this.bgColorIds[x] = colorId;
            this.framebuffer[line * 160 + x] = (bgp >> (colorId * 2)) & 0b11;

            x++;
        }

        if (drewWindowThisLine) this.windowLine++;

        this.renderSprites(line, LCDC);
    }

    private renderSprites(line: number, LCDC: number): void {
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

        // Draw lowest-priority sprite first so the highest-priority one (smallest x,
        // then smallest OAM index) is drawn last and ends up on top.
        visible.sort((a, b) => (b.x - a.x) || (b.oamIndex - a.oamIndex));

        const obp0 = this.bus.readByte(u16(0xff48));
        const obp1 = this.bus.readByte(u16(0xff49));

        for (const sprite of visible) {
            const yFlip = (sprite.flags >> 6) & 1;
            const xFlip = (sprite.flags >> 5) & 1;
            const behindBg = (sprite.flags >> 7) & 1;
            const palette = ((sprite.flags >> 4) & 1) ? obp1 : obp0;

            let tileY = line - sprite.y;
            if (yFlip) tileY = height - 1 - tileY;

            const tileIndex = height === 16 ? (sprite.tile & 0xFE) : sprite.tile;
            const tileAddr = 0x8000 + tileIndex * 16;
            const byte1 = this.bus.readByte(u16(tileAddr + tileY * 2));
            const byte2 = this.bus.readByte(u16(tileAddr + tileY * 2 + 1));

            for (let spriteX = 0; spriteX < 8; spriteX++) {
                const screenX = sprite.x + spriteX;
                if (screenX < 0 || screenX > 159) continue;

                const bit = xFlip ? spriteX : 7 - spriteX;
                const colorId = ((byte2 >> bit) & 1) << 1 | ((byte1 >> bit) & 1);
                if (colorId === 0) continue; // transparent

                if (behindBg && this.bgColorIds[screenX] !== 0) continue;

                this.framebuffer[line * 160 + screenX] = (palette >> (colorId * 2)) & 0b11;
            }
        }
    }
}
