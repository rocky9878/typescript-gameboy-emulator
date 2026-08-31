import { ppu } from './ppu';
import { createMbc, Mbc0, type Mbc } from './mbc';
import { Joypad } from './joypad';
import { Apu } from './apu';

export * from './auth';

export type u8 = number & { readonly __brand: 'u8' };
export type u16 = number & { readonly __brand: 'u16' };

export type InstructionType = 'ADC'|'ADD'|'AND'|'BIT'|'CALL'|'CCF'|'CP'|'CPL'|'DAA'|'DEC'|'DI'|'EI'|'HALT'|'INC'|'JP'|'JR'|'LD'|'NOP'|'OR'|'POP'|'PUSH'|'RES'|'RET'|'RETI'|'RL'|'RLA'|'RLC'|'RLCA'|'RR'|'RRA'|'RRC'|'RRCA'|'RST'|'SBC'|'SCF'|'SET'|'SLA'|'SRA'|'SRL'|'SUB'|'SWAP'|'XOR';

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

export class MemoryBus {
    rom: rom = new rom();
    mbc: Mbc = new Mbc0(new Uint8Array(0));
    ppu: ppu = new ppu(this);
    joypad: Joypad = new Joypad(() => this.requestJoypadInterrupt());
    apu: Apu = new Apu();
    private vram: Uint8Array = new Uint8Array(0x2000);
    private wram: Uint8Array = new Uint8Array(0x2000);
    private oam: Uint8Array = new Uint8Array(0xa0);
    private io: Uint8Array = new Uint8Array(0x180);
    private hram: Uint8Array = new Uint8Array(0x7f);
    private ie: u8 = u8(0);

    async init(romPath: string): Promise<void> {
        await this.rom.loadRom(romPath);
        this.mbc = createMbc(this.rom.memory);
    }

    requestJoypadInterrupt(): void {
        this.writeByte(u16(0xff0f), u8(this.readByte(u16(0xff0f)) | (1 << 4)));
    }

    readByte(address: u16): u8 {
        if(address <= 0x7fff) return this.mbc.readRom(address);
        if(address <= 0x9fff) return u8(this.vram[address - 0x8000]);
        if(address <= 0xbfff) return this.mbc.readRam(address);
        if(address <= 0xdfff) return u8(this.wram[address - 0xc000]);
        if(address <= 0xfdff) return u8(this.wram[address - 0xe000]); // echo RAM mirrors wram
        if(address <= 0xfe9f) return u8(this.oam[address - 0xfe00]);
        if(address === 0xff00) return this.joypad.readRegister();
        if((address >= 0xff10 && address <= 0xff2f) || (address >= 0xff30 && address <= 0xff3f)) return u8(this.apu.readRegister(address));
        if(address <= 0xff7f) return u8(this.io[address - 0xfe00]);
        if(address <= 0xfffe) return u8(this.hram[address - 0xff80]);
        return this.ie;
    }

    writeByte(address: u16, byte: u8): u8 {
        if(address <= 0x7fff) { this.mbc.writeRom(address, byte); return byte; }
        if(address <= 0x9fff) return this.vram[address - 0x8000] = byte;
        if(address <= 0xbfff) { this.mbc.writeRam(address, byte); return byte; }
        if(address <= 0xdfff) return this.wram[address - 0xc000] = byte;
        if(address <= 0xfdff) return this.wram[address - 0xe000] = byte; // echo RAM mirrors wram
        if(address <= 0xfe9f) return this.oam[address - 0xfe00] = byte;
        if(address === 0xff00) { this.joypad.writeRegister(byte); return byte; }
        if((address >= 0xff10 && address <= 0xff2f) || (address >= 0xff30 && address <= 0xff3f)) { this.apu.writeRegister(address, byte); return byte; }
        if(address <= 0xff7f) return this.io[address - 0xfe00] = byte;
        if(address <= 0xfffe) return this.hram[address - 0xff80] = byte;
        return this.ie = byte;
    }

    // --- OAM corruption bug (DMG hardware quirk) ---
    // A 16-bit register inc/dec/hli/hld whose (pre-op) value points into $FE00-$FEFF, while
    // the PPU is mid mode-2 OAM scan, scrambles whichever OAM row the scan is currently on -
    // regardless of the actual address value. See gbdev Pan Docs "OAM Corruption Bug".
    private oamWord(row: number, wordIdx: number): number {
        const off = row * 8 + wordIdx * 2;
        return this.oam[off] | (this.oam[off + 1] << 8);
    }

    private setOamWord(row: number, wordIdx: number, value: number): void {
        const off = row * 8 + wordIdx * 2;
        this.oam[off] = value & 0xff;
        this.oam[off + 1] = (value >> 8) & 0xff;
    }

    private oamWriteCorruption(row: number): void {
        if (row <= 0) return; // row 0 (objects 0 & 1) is unaffected by the bug
        const a = this.oamWord(row, 0);
        const b = this.oamWord(row - 1, 0);
        const c = this.oamWord(row - 1, 2);
        this.setOamWord(row, 0, ((a ^ c) & (b ^ c)) ^ c);
        this.setOamWord(row, 1, this.oamWord(row - 1, 1));
        this.setOamWord(row, 2, c);
        this.setOamWord(row, 3, this.oamWord(row - 1, 3));
    }

    private oamReadCorruption(row: number): void {
        if (row <= 0) return;
        const a = this.oamWord(row, 0);
        const b = this.oamWord(row - 1, 0);
        const c = this.oamWord(row - 1, 2);
        this.setOamWord(row, 0, b | (a & c));
        this.setOamWord(row, 1, this.oamWord(row - 1, 1));
        this.setOamWord(row, 2, c);
        this.setOamWord(row, 3, this.oamWord(row - 1, 3));
    }

    // The combined pattern from a read happening in the same M-cycle as the IDU's
    // increment/decrement (e.g. LD A,(HL+)). Only applies to rows 4-18; a plain read
    // corruption always follows regardless.
    private oamReadWriteCorruption(row: number): void {
        if (row >= 4 && row <= 18) {
            const a = this.oamWord(row - 2, 0);
            const b = this.oamWord(row - 1, 0);
            const c = this.oamWord(row, 0);
            const d = this.oamWord(row - 1, 2);
            this.setOamWord(row - 1, 0, (b & (a | c | d)) | (a & c & d));
            for (let w = 0; w < 4; w++) {
                const val = this.oamWord(row - 1, w);
                this.setOamWord(row, w, val);
                this.setOamWord(row - 2, w, val);
            }
        }
        this.oamReadCorruption(row);
    }

    // Call whenever a 16-bit address in $FE00-$FEFF is asserted on the bus (via IDU
    // inc/dec or an actual OAM access) while the PPU may be mid OAM-scan. No-ops outside
    // mode 2. `kind` selects which of the three hardware corruption patterns applies.
    triggerOamCorruption(kind: 'write' | 'read' | 'readWrite'): void {
        const row = this.ppu.oamScanRow();
        if (row === null) return;
        if (kind === 'write') this.oamWriteCorruption(row);
        else if (kind === 'read') this.oamReadCorruption(row);
        else this.oamReadWriteCorruption(row);
    }
}
