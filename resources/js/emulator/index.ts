import { ppu, type PpuState } from './ppu';
import { createMbc, Mbc0, type Mbc } from './mbc';
import { Joypad, type JoypadState } from './joypad';
import { Apu, type ApuState } from './apu';

export * from '@/types/auth';

export type u8 = number & { readonly __brand: 'u8' };
export type u16 = number & { readonly __brand: 'u16' };

// Base64 (4 chars per 3 bytes) instead of a JSON number array (2-4 chars per byte) for the
// raw buffers in a save state (VRAM/WRAM/OAM/cartridge RAM). Chunked so
// String.fromCharCode(...bytes) doesn't blow the call stack on the larger buffers.
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

// Converts a 15-bit CGB RGB555 colour to a packed 0xAABBGGRR value ready for a canvas
// Uint32 framebuffer (little-endian: R in the low byte). Uses the gambatte "true colour"
// correction curve - a straight 5->8 bit scale looks badly oversaturated on an sRGB
// display because the CGB's LCD was far less vivid.
export function cgb555ToRgba(color: number): number {
    const r = color & 0x1f;
    const g = (color >> 5) & 0x1f;
    const b = (color >> 10) & 0x1f;

    const rr = (r * 13 + g * 2 + b) >> 1;
    const gg = (g * 3 + b) << 1;
    const bb = (r * 3 + g * 2 + b * 11) >> 1;

    return (0xff << 24) | (bb << 16) | (gg << 8) | rr;
}

export type InstructionType = 'ADC'|'ADD'|'AND'|'BIT'|'CALL'|'CCF'|'CP'|'CPL'|'DAA'|'DEC'|'DI'|'EI'|'HALT'|'INC'|'JP'|'JR'|'LD'|'NOP'|'OR'|'POP'|'PUSH'|'RES'|'RET'|'RETI'|'RL'|'RLA'|'RLC'|'RLCA'|'RR'|'RRA'|'RRC'|'RRCA'|'RST'|'SBC'|'SCF'|'SET'|'SLA'|'SRA'|'SRL'|'STOP'|'SUB'|'SWAP'|'XOR';

export enum JumpConditions {
  NotZero,
  Zero,
  NotCarry,
  Carry,
  Always
}

export function u8(value: number): u8 {
    return (value & 0xff) as u8;
}

export function u16(value: number): u16 {
    return (value & 0xffff) as u16;
}

export interface FlagsRegister {
    zero: boolean,
    subtract: boolean,
    half_carry: boolean,
    carry: boolean
}

const ZERO_FLAG_BYTE_POSITION = 7;
const SUBTRACT_FLAG_BYTE_POSITION = 6;
const HALF_CARRY_FLAG_BYTE_POSITION = 5;
const CARRY_FLAG_BYTE_POSITION = 4;

export function flagsRegisterFromByte(byte: u8): FlagsRegister {
    return {
        zero: (byte >> ZERO_FLAG_BYTE_POSITION & 0b1) != 0,
        subtract: (byte >> SUBTRACT_FLAG_BYTE_POSITION & 0b1) != 0,
        half_carry: (byte >> HALF_CARRY_FLAG_BYTE_POSITION & 0b1) != 0,
        carry: (byte >> CARRY_FLAG_BYTE_POSITION & 0b1) != 0,
    };
}

export function byteFromFlagsRegister(register: FlagsRegister): u8 {
    return u8(
        (register.zero ? 1 : 0) << ZERO_FLAG_BYTE_POSITION |
        (register.subtract ? 1 : 0) << SUBTRACT_FLAG_BYTE_POSITION |
        (register.half_carry ? 1 : 0) << HALF_CARRY_FLAG_BYTE_POSITION |
        (register.carry ? 1 : 0) << CARRY_FLAG_BYTE_POSITION
    );
}

export class rom {
    memory: Uint8Array = new Uint8Array(0);

    async loadRom(path: string): Promise<void> {
        const response = await fetch(path);
        if (!response.ok) {
            throw new Error(`Failed to load ROM: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        this.memory = new Uint8Array(buffer);
    }
}

export class registers {
    // Values below match the real DMG hardware state left behind by the boot ROM
    // right before it hands off to the cartridge at pc=0x100. Since this emulator
    // skips running the boot ROM, these have to be set explicitly here instead -
    // several games branch on A/F at startup for hardware detection and misbehave
    // (e.g. never enabling the LCD) if they see zeros instead.
    a: u8 = u8(0x01);
    b: u8 = u8(0x00);
    c: u8 = u8(0x13);
    d: u8 = u8(0x00);
    e: u8 = u8(0xd8);
    f: FlagsRegister = { zero: true, subtract: false, half_carry: true, carry: true };
    h: u8 = u8(0x01);
    l: u8 = u8(0x4d);
    pc = u16(0x100);
    sp = u16(0xfffe);

    af(): u16 {
        return u16((this.a) << 8 | byteFromFlagsRegister(this.f));
    }

    bc(): u16 {
        return u16((this.b) << 8 | this.c);
    }

    de(): u16 {
        return u16((this.d) << 8 | this.e);
    }

    hl(): u16 {
        return u16((this.h) << 8 | this.l);
    }

    setAf(value: u16): void
    {
        this.a = u8((value & 0xff00) >> 8);
        this.f = flagsRegisterFromByte(u8(value & 0xff));
    }

    setBc(value: u16): void
    {
        this.b = u8((value & 0xff00) >> 8);
        this.c = u8(value & 0xff);
    }

    setDe(value: u16): void
    {
        this.d = u8((value & 0xff00) >> 8);
        this.e = u8(value & 0xff);
    }

    setHl(value: u16): void
    {
        this.h = u8((value & 0xff00) >> 8);
        this.l = u8(value & 0xff);
    }
}

export interface MemoryBusState {
    cgb: boolean;
    vram: string;
    vramBank: number;
    wram: string;
    wramBank: number;
    oam: string;
    io: string;
    hram: string;
    ie: u8;
    bgPaletteRam: string;
    objPaletteRam: string;
    bcps: number;
    ocps: number;
    opri: number;
    hdmaSource: number;
    hdmaDest: number;
    hdmaLength: number;
    hdmaHBlank: boolean;
    mbc: unknown;
    ppu: PpuState;
    joypad: JoypadState;
    apu: ApuState;
}

export class MemoryBus {
    rom: rom = new rom();
    mbc: Mbc = new Mbc0(new Uint8Array(0));
    ppu: ppu = new ppu(this);
    joypad: Joypad = new Joypad(() => this.requestJoypadInterrupt());
    apu: Apu = new Apu();

    // True when running as CGB hardware (see CPU.configureForRom). Gates VRAM/WRAM banking,
    // the double-speed switch, and disables the DMG-only OAM corruption bug.
    cgb = false;

    // CGB has 2 switchable 8KB VRAM banks and 8 4KB WRAM banks ($D000-$DFFF region); on DMG
    // the bank registers are inert and only bank 0 / bank 1 are ever used.
    private vram: Uint8Array = new Uint8Array(0x4000);
    private vramBank = 0;
    private wram: Uint8Array = new Uint8Array(0x8000);
    // SVBK as written (0-7); 0 selects bank 1 for addressing but still reads back as 0.
    private wramBank = 1;
    private oam: Uint8Array = new Uint8Array(0xa0);
    private io: Uint8Array = new Uint8Array(0x180);
    private hram: Uint8Array = new Uint8Array(0x7f);
    private ie: u8 = u8(0);

    // CGB palette RAM: 8 palettes x 4 colours x 2 bytes (little-endian RGB555), for BG and
    // OBJ. BCPS/OCPS ($FF68/$FF6A) hold a 6-bit write index into the respective block plus
    // an auto-increment flag; BCPD/OCPD ($FF69/$FF6B) read/write at that index. OPRI ($FF6C)
    // selects sprite priority ordering (0 = OAM index, 1 = X coordinate).
    private bgPaletteRam = new Uint8Array(64);
    private objPaletteRam = new Uint8Array(64);
    private bcpsIndex = 0;
    private bcpsAutoInc = false;
    private ocpsIndex = 0;
    private ocpsAutoInc = false;
    private opri = 0;

    // VRAM DMA ($FF51-$FF55), CGB only. hdmaLength is bytes still to copy (multiple of 16);
    // 0 means no transfer in progress. hdmaHBlank distinguishes a general-purpose transfer
    // (done in one shot) from an HBlank transfer (16 bytes per HBlank). hdmaStallCycles is
    // handed to the CPU to freeze it for the duration of a general-purpose transfer.
    private hdmaSource = 0;
    private hdmaDest = 0; // offset within VRAM, 0x0000-0x1FF0
    private hdmaLength = 0;
    private hdmaHBlank = false;
    private hdmaStallCycles = 0;

    async init(romPath: string): Promise<void> {
        await this.rom.loadRom(romPath);
        this.mbc = createMbc(this.rom.memory);
    }

    // The boot ROM leaves the I/O registers in a specific state before handing off to the
    // cartridge. This engine skips the boot ROM, so games that assume that state - e.g.
    // Pokémon Gold/Silver, which waits for LY to hit $91 without ever enabling the LCD
    // itself, relying on the boot ROM having left it on - hang without this.
    applyBootState(): void {
        const set = (addr: number, value: number) => { this.io[addr - 0xfe00] = value; };
        set(0xff00, 0xcf); // P1
        set(0xff02, 0x7e); // SC
        set(0xff07, 0xf8); // TAC
        set(0xff0f, 0xe1); // IF
        set(0xff40, 0x91); // LCDC - LCD on, BG on, tile data $8000
        set(0xff41, 0x81); // STAT
        set(0xff46, 0xff); // DMA
        set(0xff47, 0xfc); // BGP
        set(0xff48, 0xff); // OBP0
        set(0xff49, 0xff); // OBP1
        // Sound registers are serviced by the APU, not `io`; its own reset state stands in.
    }

    requestJoypadInterrupt(): void {
        this.writeByte(u16(0xff0f), u8(this.readByte(u16(0xff0f)) | (1 << 4)));
    }

    // Index into `wram` for an address in $C000-$DFFF (callers map echo RAM down first).
    // $C000-$CFFF is always bank 0; $D000-$DFFF is the switchable bank (1-7 on CGB, always 1
    // on DMG).
    private wramIndex(address: number): number {
        if (address < 0xd000) return address - 0xc000;
        return (this.wramBank || 1) * 0x1000 + (address - 0xd000);
    }

    // Direct VRAM access for the PPU, bypassing bank selection so it can read whichever bank
    // a tile / attribute lives in regardless of what the CPU last selected.
    readVram(offset: number, bank: number): u8 {
        return u8(this.vram[bank * 0x2000 + offset]);
    }

    // Raw 15-bit RGB555 for a CGB palette entry. palette 0-7, colorId 0-3.
    bgColor555(palette: number, colorId: number): number {
        const i = palette * 8 + colorId * 2;
        return this.bgPaletteRam[i] | (this.bgPaletteRam[i + 1] << 8);
    }

    objColor555(palette: number, colorId: number): number {
        const i = palette * 8 + colorId * 2;
        return this.objPaletteRam[i] | (this.objPaletteRam[i + 1] << 8);
    }

    // True when sprites should be prioritised by X coordinate (DMG behaviour) rather than
    // OAM index (CGB default). Always true on DMG hardware.
    get objCoordinatePriority(): boolean {
        return !this.cgb || (this.opri & 1) === 1;
    }

    // Number of extra T-cycles the CPU should burn for a just-completed general-purpose VRAM
    // DMA, consumed once.
    takeHdmaStall(): number {
        const c = this.hdmaStallCycles;
        this.hdmaStallCycles = 0;
        return c;
    }

    // Copies `bytes` from the current HDMA source to VRAM (current bank), advancing both
    // pointers. Dest wraps within the 8KB bank.
    private hdmaCopy(bytes: number): void {
        for (let i = 0; i < bytes; i++) {
            this.vram[this.vramBank * 0x2000 + this.hdmaDest] = this.readByte(u16(this.hdmaSource));
            this.hdmaSource = (this.hdmaSource + 1) & 0xffff;
            this.hdmaDest = (this.hdmaDest + 1) & 0x1fff;
        }
    }

    private startHdma(value: number): void {
        const hblank = (value & 0x80) !== 0;
        const length = ((value & 0x7f) + 1) * 16;

        // Writing bit 7 = 0 during an active HBlank transfer aborts it.
        if (this.hdmaLength > 0 && this.hdmaHBlank && !hblank) {
            this.hdmaLength = 0;
            return;
        }

        this.hdmaLength = length;
        this.hdmaHBlank = hblank;

        if (!hblank) {
            this.hdmaCopy(length);
            this.hdmaLength = 0;
            this.hdmaStallCycles += length * 2; // ~2 T-cycles/byte at single speed
        }
    }

    // Called by the PPU on entry to each HBlank. Transfers the next 16 bytes of an active
    // HBlank VRAM DMA.
    hblankDmaStep(): void {
        if (this.hdmaLength === 0 || !this.hdmaHBlank) return;
        const chunk = Math.min(16, this.hdmaLength);
        this.hdmaCopy(chunk);
        this.hdmaLength -= chunk;
        this.hdmaStallCycles += chunk * 2;
    }

    readByte(address: u16): u8 {
        if(address <= 0x7fff) return this.mbc.readRom(address);
        if(address <= 0x9fff) return u8(this.vram[this.vramBank * 0x2000 + (address - 0x8000)]);
        if(address <= 0xbfff) return this.mbc.readRam(address);
        if(address <= 0xdfff) return u8(this.wram[this.wramIndex(address)]);
        if(address <= 0xfdff) return u8(this.wram[this.wramIndex(address - 0x2000)]); // echo RAM mirrors wram
        if(address <= 0xfe9f) return u8(this.oam[address - 0xfe00]);
        if(address === 0xff00) return this.joypad.readRegister();
        if((address >= 0xff10 && address <= 0xff2f) || (address >= 0xff30 && address <= 0xff3f)) return u8(this.apu.readRegister(address));
        if(address === 0xff4f) return u8(this.cgb ? 0xfe | this.vramBank : 0xff);
        if(address === 0xff4d) return u8(this.cgb ? 0x7e | (this.io[0xff4d - 0xfe00] & 0x81) : 0xff);
        if(address === 0xff70) return u8(this.cgb ? 0xf8 | (this.wramBank & 7) : 0xff);
        if(address === 0xff68) return u8(this.cgb ? 0x40 | this.bcpsIndex | (this.bcpsAutoInc ? 0x80 : 0) : 0xff);
        if(address === 0xff69) return u8(this.cgb ? this.bgPaletteRam[this.bcpsIndex] : 0xff);
        if(address === 0xff6a) return u8(this.cgb ? 0x40 | this.ocpsIndex | (this.ocpsAutoInc ? 0x80 : 0) : 0xff);
        if(address === 0xff6b) return u8(this.cgb ? this.objPaletteRam[this.ocpsIndex] : 0xff);
        if(address === 0xff6c) return u8(this.cgb ? 0xfe | (this.opri & 1) : 0xff);
        if(address >= 0xff51 && address <= 0xff54) return u8(0xff); // HDMA1-4 are write-only
        if(address === 0xff55) return u8(this.cgb && this.hdmaLength > 0 ? (this.hdmaLength / 16 - 1) & 0x7f : 0xff);
        if(address <= 0xff7f) return u8(this.io[address - 0xfe00]);
        if(address <= 0xfffe) return u8(this.hram[address - 0xff80]);
        return this.ie;
    }

    // Fired whenever the CPU writes to DIV ($FF04). Real hardware resets the whole
    // internal 16-bit system counter (of which DIV is just the upper byte) to 0 on any
    // write, regardless of the value written - callers should ignore `byte` and reset
    // their own counter state instead of storing it.
    onDivWrite: (() => void) | null = null;

    // For the owner of the system counter (CPU) to publish DIV's current visible byte
    // each step, without going through writeByte's "any write resets to 0" game-facing
    // semantics above (which only applies to writes originating from executed game code).
    syncDivByte(byte: u8): void {
        this.io[0xff04 - 0xfe00] = byte;
    }

    writeByte(address: u16, byte: u8): u8 {
        if(address <= 0x7fff) { this.mbc.writeRom(address, byte); return byte; }
        if(address <= 0x9fff) return this.vram[this.vramBank * 0x2000 + (address - 0x8000)] = byte;
        if(address <= 0xbfff) { this.mbc.writeRam(address, byte); return byte; }
        if(address <= 0xdfff) return this.wram[this.wramIndex(address)] = byte;
        if(address <= 0xfdff) return this.wram[this.wramIndex(address - 0x2000)] = byte; // echo RAM mirrors wram
        if(address <= 0xfe9f) return this.oam[address - 0xfe00] = byte;
        if(address === 0xff00) { this.joypad.writeRegister(byte); return byte; }
        if((address >= 0xff10 && address <= 0xff2f) || (address >= 0xff30 && address <= 0xff3f)) { this.apu.writeRegister(address, byte); return byte; }
        if(address === 0xff04) { this.onDivWrite?.(); return this.io[address - 0xfe00] = u8(0); }
        if(address === 0xff46) { this.startOamDma(byte); return this.io[address - 0xfe00] = byte; }
        if(address === 0xff4f) { if (this.cgb) this.vramBank = byte & 1; return this.io[address - 0xfe00] = byte; }
        if(address === 0xff70) { if (this.cgb) this.wramBank = byte & 7; return this.io[address - 0xfe00] = byte; }
        if(address === 0xff68) { if (this.cgb) { this.bcpsIndex = byte & 0x3f; this.bcpsAutoInc = (byte & 0x80) !== 0; } return this.io[address - 0xfe00] = byte; }
        if(address === 0xff69) { if (this.cgb) { this.bgPaletteRam[this.bcpsIndex] = byte; if (this.bcpsAutoInc) this.bcpsIndex = (this.bcpsIndex + 1) & 0x3f; } return this.io[address - 0xfe00] = byte; }
        if(address === 0xff6a) { if (this.cgb) { this.ocpsIndex = byte & 0x3f; this.ocpsAutoInc = (byte & 0x80) !== 0; } return this.io[address - 0xfe00] = byte; }
        if(address === 0xff6b) { if (this.cgb) { this.objPaletteRam[this.ocpsIndex] = byte; if (this.ocpsAutoInc) this.ocpsIndex = (this.ocpsIndex + 1) & 0x3f; } return this.io[address - 0xfe00] = byte; }
        if(address === 0xff6c) { if (this.cgb) this.opri = byte & 1; return this.io[address - 0xfe00] = byte; }
        if(address === 0xff51) { this.hdmaSource = (this.hdmaSource & 0x00ff) | (byte << 8); return byte; }
        if(address === 0xff52) { this.hdmaSource = (this.hdmaSource & 0xff00) | (byte & 0xf0); return byte; }
        if(address === 0xff53) { this.hdmaDest = (this.hdmaDest & 0x00ff) | ((byte & 0x1f) << 8); return byte; }
        if(address === 0xff54) { this.hdmaDest = (this.hdmaDest & 0xff00) | (byte & 0xf0); return byte; }
        if(address === 0xff55) { if (this.cgb) this.startHdma(byte); return byte; }
        if(address <= 0xff7f) return this.io[address - 0xfe00] = byte;
        if(address <= 0xfffe) return this.hram[address - 0xff80] = byte;
        return this.ie = byte;
    }

    // OAM DMA ($FF46): almost every commercial game uses this to refresh all 40 sprites
    // each frame (writing to OAM directly via the CPU is both too slow and, during
    // rendering, blocked). Real hardware spreads this over 160 M-cycles and blocks
    // non-HRAM access meanwhile; we do it instantly, which is inaccurate but sufficient
    // for correct sprite contents (the timing nuance mainly matters for a handful of
    // trickier titles, not for getting sprites to appear at all).
    private startOamDma(sourceHigh: u8): void {
        const base = u16(sourceHigh << 8);
        for (let i = 0; i < 0xa0; i++) {
            this.oam[i] = this.readByte(u16(base + i));
        }
    }

    // --- OAM corruption bug (DMG hardware quirk) ---
    // A 16-bit register inc/dec, or an actual OAM read/write, whose address points into
    // $FE00-$FEFF while the PPU is mid mode-2 OAM scan, scrambles whichever OAM row the
    // scan is currently on - regardless of the actual address/value involved. Ported
    // directly from SameBoy's Core/memory.c (GB_trigger_oam_bug / GB_trigger_oam_bug_read),
    // the cycle-accurate reference this ROM suite's exact expected CRCs were computed
    // against - Pan Docs' prose summary undersells how row-dependent reads actually are.
    private oamWordAt(byteOffset: number): number {
        if (byteOffset < 0 || byteOffset >= 160) return 0;
        return this.oam[byteOffset] | (this.oam[byteOffset + 1] << 8);
    }

    private setOamWordAt(byteOffset: number, value: number): void {
        if (byteOffset < 0 || byteOffset >= 160) return;
        this.oam[byteOffset] = value & 0xff;
        this.oam[byteOffset + 1] = (value >> 8) & 0xff;
    }

    private static glitchWrite(a: number, b: number, c: number): number {
        return ((a ^ c) & (b ^ c)) ^ c;
    }

    private static glitchRead(a: number, b: number, c: number): number {
        return b | (a & c);
    }

    private static glitchReadSecondary(a: number, b: number, c: number, d: number): number {
        return (b & (a | c | d)) | (a & c & d);
    }

    private static glitchReadTertiary1(a: number, b: number, c: number, d: number, e: number): number {
        return c | (a & b & d & e);
    }

    private static glitchReadTertiary2(a: number, b: number, c: number, d: number, e: number): number {
        return (c & (a | b | d | e)) | (a & b & d & e);
    }

    private static glitchReadTertiary3(a: number, b: number, c: number, d: number, e: number): number {
        return (c & (a | b | d | e)) | (b & d & e);
    }

    private static glitchReadQuaternary(
        a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number
    ): number {
        return (e & (h | g | (~d & f & 0xffff) | c | b)) | (c & g & h);
    }

    // Row 0 (objects 0 & 1) is exempt from the whole bug.
    private oamWriteCorruption(row: number): void {
        if (row <= 0) return;
        const base = row * 8;
        const a = this.oamWordAt(base);
        const b = this.oamWordAt(base - 8);
        const c = this.oamWordAt(base - 4);
        this.setOamWordAt(base, MemoryBus.glitchWrite(a, b, c));
        for (let i = 2; i < 8; i++) this.oam[base + i] = this.oam[base - 8 + i];
    }

    private oamSecondaryReadCorruption(base: number): void {
        if (base >= 0x98) return;
        const a = this.oamWordAt(base - 16);
        const b = this.oamWordAt(base - 8);
        const c = this.oamWordAt(base);
        const d = this.oamWordAt(base - 4);
        this.setOamWordAt(base - 8, MemoryBus.glitchReadSecondary(a, b, c, d));
        for (let i = 0; i < 8; i++) this.oam[base - 16 + i] = this.oam[base - 8 + i];
    }

    private oamTertiaryReadCorruption(
        base: number, op: (a: number, b: number, c: number, d: number, e: number) => number
    ): void {
        if (base >= 0x98) return;
        const a = this.oamWordAt(base);
        const b = this.oamWordAt(base - 4);
        const c = this.oamWordAt(base - 8);
        const d = this.oamWordAt(base - 16);
        const e = this.oamWordAt(base - 32);
        this.setOamWordAt(base - 8, op(a, b, c, d, e));
        for (let i = 0; i < 8; i++) {
            const val = this.oam[base - 8 + i];
            this.oam[base - 16 + i] = val;
            this.oam[base - 32 + i] = val;
        }
    }

    private oamQuaternaryReadCorruption(base: number): void {
        if (base >= 0x98) return;
        const a = this.oamWordAt(0);
        const b = this.oamWordAt(base);
        const c = this.oamWordAt(base - 4);
        const d = this.oamWordAt(base - 6);
        const e = this.oamWordAt(base - 8);
        const f = this.oamWordAt(base - 14);
        const g = this.oamWordAt(base - 16);
        const h = this.oamWordAt(base - 32);
        this.setOamWordAt(base - 8, MemoryBus.glitchReadQuaternary(a, b, c, d, e, f, g, h));
        for (let i = 0; i < 8; i++) {
            const val = this.oam[base - 8 + i];
            this.oam[base - 16 + i] = val;
            this.oam[base - 32 + i] = val;
        }
    }

    private oamReadCorruption(row: number): void {
        if (row <= 0) return;
        const base = row * 8;
        const group = row & 3;
        if (group === 2) {
            this.oamSecondaryReadCorruption(base);
        } else if (group === 0) {
            if (row === 8) this.oamQuaternaryReadCorruption(base);
            else if (row === 4) this.oamTertiaryReadCorruption(base, MemoryBus.glitchReadTertiary2);
            else if (row === 12) this.oamTertiaryReadCorruption(base, MemoryBus.glitchReadTertiary3);
            else this.oamTertiaryReadCorruption(base, MemoryBus.glitchReadTertiary1);
        } else {
            const a = this.oamWordAt(base);
            const b = this.oamWordAt(base - 8);
            const c = this.oamWordAt(base - 4);
            const value = MemoryBus.glitchRead(a, b, c);
            this.setOamWordAt(base - 8, value);
            this.setOamWordAt(base, value);
        }
        // Unconditional: whichever branch ran, the (possibly just-corrected) preceding row
        // is copied forward into the accessed row.
        for (let i = 0; i < 8; i++) this.oam[base + i] = this.oam[base - 8 + i];
        if (row === 16) for (let i = 0; i < 8; i++) this.oam[i] = this.oam[base + i];
    }

    // Call whenever a 16-bit address in $FE00-$FEFF is asserted on the bus (via IDU
    // inc/dec, or an actual OAM read/write) while the PPU may be mid OAM-scan. No-ops
    // outside mode 2.
    triggerOamCorruption(kind: 'write' | 'read'): void {
        if (this.cgb) return; // CGB hardware doesn't have the OAM bug
        const row = this.ppu.oamScanRow();
        if (row === null) return;
        if (kind === 'write') this.oamWriteCorruption(row);
        else this.oamReadCorruption(row);
    }

    // rom is intentionally excluded - a save state assumes the same cartridge is already
    // loaded, not that it re-embeds the ROM image itself.
    getState(): MemoryBusState {
        return {
            cgb: this.cgb,
            vram: bytesToBase64(this.vram),
            vramBank: this.vramBank,
            wram: bytesToBase64(this.wram),
            wramBank: this.wramBank,
            oam: bytesToBase64(this.oam),
            io: bytesToBase64(this.io),
            hram: bytesToBase64(this.hram),
            ie: this.ie,
            bgPaletteRam: bytesToBase64(this.bgPaletteRam),
            objPaletteRam: bytesToBase64(this.objPaletteRam),
            bcps: this.bcpsIndex | (this.bcpsAutoInc ? 0x80 : 0),
            ocps: this.ocpsIndex | (this.ocpsAutoInc ? 0x80 : 0),
            opri: this.opri,
            hdmaSource: this.hdmaSource,
            hdmaDest: this.hdmaDest,
            hdmaLength: this.hdmaLength,
            hdmaHBlank: this.hdmaHBlank,
            mbc: this.mbc.getState(),
            ppu: this.ppu.getState(),
            joypad: this.joypad.getState(),
            apu: this.apu.getState(),
        };
    }

    setState(state: MemoryBusState): void {
        this.cgb = state.cgb;
        this.vram.set(base64ToBytes(state.vram));
        this.vramBank = state.vramBank;
        this.wram.set(base64ToBytes(state.wram));
        this.wramBank = state.wramBank;
        this.oam.set(base64ToBytes(state.oam));
        this.io.set(base64ToBytes(state.io));
        this.hram.set(base64ToBytes(state.hram));
        this.ie = u8(state.ie);
        this.bgPaletteRam.set(base64ToBytes(state.bgPaletteRam));
        this.objPaletteRam.set(base64ToBytes(state.objPaletteRam));
        this.bcpsIndex = state.bcps & 0x3f;
        this.bcpsAutoInc = (state.bcps & 0x80) !== 0;
        this.ocpsIndex = state.ocps & 0x3f;
        this.ocpsAutoInc = (state.ocps & 0x80) !== 0;
        this.opri = state.opri;
        this.hdmaSource = state.hdmaSource;
        this.hdmaDest = state.hdmaDest;
        this.hdmaLength = state.hdmaLength;
        this.hdmaHBlank = state.hdmaHBlank;
        this.hdmaStallCycles = 0;
        this.mbc.setState(state.mbc);
        this.ppu.setState(state.ppu);
        this.joypad.setState(state.joypad);
        this.apu.setState(state.apu);
    }
}
