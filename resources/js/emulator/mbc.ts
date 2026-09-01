import type { u16 } from '.';
import { u8, bytesToBase64, base64ToBytes } from '.';

export interface Mbc {
    readRom(address: u16): u8;
    writeRom(address: u16, value: u8): void;
    readRam(address: u16): u8;
    writeRam(address: u16, value: u8): void;
    // Bank registers and cartridge RAM only - each implementation's shape differs, so
    // callers (MemoryBus) treat this opaquely and just round-trip whatever was returned.
    getState(): unknown;
    setState(state: unknown): void;
}

// Cartridge header byte 0x149 -> external RAM size in bytes.
const RAM_SIZES: Record<number, number> = {
    0x00: 0,
    0x01: 0x800,
    0x02: 0x2000,
    0x03: 0x8000,
    0x04: 0x20000,
    0x05: 0x10000,
};

// No memory bank controller: ROM is at most 32KB, mapped directly, writes to
// the ROM area are ignored since there's no hardware there to configure.
//
// Real "ROM ONLY" carts have no RAM at 0xA000-0xBFFF, but plenty of ROM dumps
// (Dr. Mario included) carry an inaccurate 0x149 header byte while their code
// still sweeps that address range as scratch RAM during startup. Always
// backing it with a real 8KB buffer, rather than the hardware-strict "no RAM
// present" behavior, keeps those ROMs working without needing per-game header
// overrides.
export class Mbc0 implements Mbc {
    private ram: Uint8Array = new Uint8Array(0x2000);

    constructor(private rom: Uint8Array) {}

    readRom(address: u16): u8 {
        return u8(this.rom[address] ?? 0xff);
    }

    writeRom(_address: u16, _value: u8): void {}

    readRam(address: u16): u8 {
        return u8(this.ram[address - 0xa000]);
    }

    writeRam(address: u16, value: u8): void {
        this.ram[address - 0xa000] = value;
    }

    getState(): Mbc0State {
        return { ram: bytesToBase64(this.ram) };
    }

    setState(state: unknown): void {
        this.ram.set(base64ToBytes((state as Mbc0State).ram));
    }
}

interface Mbc0State {
    ram: string;
}

// MBC1: switchable 16KB ROM bank at 0x4000-0x7FFF (5-bit bank register, bank 0
// aliases to bank 1), plus a 2-bit register that either extends the ROM bank
// selection or selects a RAM bank, depending on the banking mode.
export class Mbc1 implements Mbc {
    private romBankLow = 1;
    private bank2 = 0;
    private mode: 0 | 1 = 0;
    private ramEnabled = false;
    private ram: Uint8Array;
    private romBankCount: number;

    constructor(private rom: Uint8Array, ramSize: number) {
        this.ram = new Uint8Array(ramSize);
        this.romBankCount = Math.max(2, Math.ceil(rom.length / 0x4000));
    }

    private lowRomBank(): number {
        return this.mode === 1 ? (this.bank2 << 5) % this.romBankCount : 0;
    }

    private highRomBank(): number {
        return ((this.bank2 << 5) | this.romBankLow) % this.romBankCount;
    }

    readRom(address: u16): u8 {
        if (address <= 0x3fff) {
            return u8(this.rom[this.lowRomBank() * 0x4000 + address] ?? 0xff);
        }
        return u8(this.rom[this.highRomBank() * 0x4000 + (address - 0x4000)] ?? 0xff);
    }

    writeRom(address: u16, value: u8): void {
        if (address <= 0x1fff) {
            this.ramEnabled = (value & 0x0f) === 0x0a;
        } else if (address <= 0x3fff) {
            const bank = value & 0x1f;
            this.romBankLow = bank === 0 ? 1 : bank;
        } else if (address <= 0x5fff) {
            this.bank2 = value & 0x03;
        } else {
            this.mode = (value & 0x01) as 0 | 1;
        }
    }

    private ramOffset(address: u16): number {
        const ramBankCount = Math.max(1, this.ram.length / 0x2000);
        const bank = (this.mode === 1 ? this.bank2 : 0) % ramBankCount;
        return bank * 0x2000 + (address - 0xa000);
    }

    readRam(address: u16): u8 {
        if (!this.ramEnabled || this.ram.length === 0) return u8(0xff);
        return u8(this.ram[this.ramOffset(address)]);
    }

    writeRam(address: u16, value: u8): void {
        if (!this.ramEnabled || this.ram.length === 0) return;
        this.ram[this.ramOffset(address)] = value;
    }

    getState(): Mbc1State {
        return {
            romBankLow: this.romBankLow,
            bank2: this.bank2,
            mode: this.mode,
            ramEnabled: this.ramEnabled,
            ram: bytesToBase64(this.ram),
        };
    }

    setState(state: unknown): void {
        const s = state as Mbc1State;
        this.romBankLow = s.romBankLow;
        this.bank2 = s.bank2;
        this.mode = s.mode;
        this.ramEnabled = s.ramEnabled;
        this.ram.set(base64ToBytes(s.ram));
    }
}

interface Mbc1State {
    romBankLow: number;
    bank2: number;
    mode: 0 | 1;
    ramEnabled: boolean;
    ram: string;
}

// MBC3: switchable 16KB ROM bank at 0x4000-0x7FFF (7-bit bank register, bank 0
// maps to bank 1 - unlike MBC1 there's no 0x20/0x40/0x60 aliasing quirk to
// work around), plus 4 RAM banks selected via the same register MBC1 uses for
// RAM banking. Also exposes RTC registers (seconds/minutes/hours/day) for
// cartridges with the real-time clock chip; games without one (like Pokemon
// Red/Blue, cart type 0x13) never select those register indices, so the RTC
// state here just needs to exist and not crash, not be a real ticking clock.
export class Mbc3 implements Mbc {
    private romBank = 1;
    private ramBank = 0;
    private ramTimerEnabled = false;
    private ram: Uint8Array;
    private romBankCount: number;
    private rtc = new Uint8Array(5); // seconds, minutes, hours, day low, day high
    private rtcLatched = new Uint8Array(5);
    private latchState = 0xff;

    constructor(private rom: Uint8Array, ramSize: number) {
        this.ram = new Uint8Array(ramSize);
        this.romBankCount = Math.max(2, Math.ceil(rom.length / 0x4000));
    }

    readRom(address: u16): u8 {
        if (address <= 0x3fff) {
            return u8(this.rom[address] ?? 0xff);
        }
        const bank = this.romBank % this.romBankCount;
        return u8(this.rom[bank * 0x4000 + (address - 0x4000)] ?? 0xff);
    }

    writeRom(address: u16, value: u8): void {
        if (address <= 0x1fff) {
            this.ramTimerEnabled = (value & 0x0f) === 0x0a;
        } else if (address <= 0x3fff) {
            this.romBank = (value & 0x7f) === 0 ? 1 : (value & 0x7f);
        } else if (address <= 0x5fff) {
            this.ramBank = value; // 0x00-0x03 = RAM bank, 0x08-0x0C = RTC register
        } else {
            // Latch current time into the readable RTC registers on a 0->1 write.
            if (this.latchState === 0x00 && value === 0x01) {
                this.rtcLatched.set(this.rtc);
            }
            this.latchState = value;
        }
    }

    readRam(address: u16): u8 {
        if (!this.ramTimerEnabled) return u8(0xff);
        if (this.ramBank >= 0x08 && this.ramBank <= 0x0c) {
            return u8(this.rtcLatched[this.ramBank - 0x08]);
        }
        if (this.ram.length === 0) return u8(0xff);
        const ramBankCount = Math.max(1, this.ram.length / 0x2000);
        const bank = this.ramBank % ramBankCount;
        return u8(this.ram[bank * 0x2000 + (address - 0xa000)]);
    }

    writeRam(address: u16, value: u8): void {
        if (!this.ramTimerEnabled) return;
        if (this.ramBank >= 0x08 && this.ramBank <= 0x0c) {
            this.rtc[this.ramBank - 0x08] = value;
            return;
        }
        if (this.ram.length === 0) return;
        const ramBankCount = Math.max(1, this.ram.length / 0x2000);
        const bank = this.ramBank % ramBankCount;
        this.ram[bank * 0x2000 + (address - 0xa000)] = value;
    }

    getState(): Mbc3State {
        return {
            romBank: this.romBank,
            ramBank: this.ramBank,
            ramTimerEnabled: this.ramTimerEnabled,
            rtc: Array.from(this.rtc),
            rtcLatched: Array.from(this.rtcLatched),
            latchState: this.latchState,
            ram: bytesToBase64(this.ram),
        };
    }

    setState(state: unknown): void {
        const s = state as Mbc3State;
        this.romBank = s.romBank;
        this.ramBank = s.ramBank;
        this.ramTimerEnabled = s.ramTimerEnabled;
        this.rtc.set(s.rtc);
        this.rtcLatched.set(s.rtcLatched);
        this.latchState = s.latchState;
        this.ram.set(base64ToBytes(s.ram));
    }
}

interface Mbc3State {
    romBank: number;
    ramBank: number;
    ramTimerEnabled: boolean;
    rtc: number[];
    rtcLatched: number[];
    latchState: number;
    ram: string;
}

// MBC2: switchable 16KB ROM bank at 0x4000-0x7FFF (4-bit bank register, bank 0
// aliases to bank 1). RAM enable and ROM bank number share the same
// 0x0000-0x3FFF write region - which one a write targets is decided by bit 8
// of the address (the least significant bit of the upper address byte), not
// by address range like MBC1/3. There's no separate RAM chip on the
// cartridge: MBC2 has 512x4 bits of RAM built into the MBC itself, always
// present, addressed at 0xA000-0xA1FF with only the lower nibble wired up -
// the upper nibble reads back as garbage (conventionally all 1s) and writes
// to it are ignored.
export class Mbc2 implements Mbc {
    private romBank = 1;
    private ramEnabled = false;
    private ram = new Uint8Array(512);
    private romBankCount: number;

    constructor(private rom: Uint8Array) {
        this.romBankCount = Math.max(2, Math.ceil(rom.length / 0x4000));
    }

    readRom(address: u16): u8 {
        if (address <= 0x3fff) {
            return u8(this.rom[address] ?? 0xff);
        }
        const bank = this.romBank % this.romBankCount;
        return u8(this.rom[bank * 0x4000 + (address - 0x4000)] ?? 0xff);
    }

    writeRom(address: u16, value: u8): void {
        if (address > 0x3fff) return;
        if (address & 0x0100) {
            const bank = value & 0x0f;
            this.romBank = bank === 0 ? 1 : bank;
        } else {
            this.ramEnabled = (value & 0x0f) === 0x0a;
        }
    }

    readRam(address: u16): u8 {
        if (!this.ramEnabled) return u8(0xff);
        return u8(0xf0 | (this.ram[(address - 0xa000) & 0x1ff] & 0x0f));
    }

    writeRam(address: u16, value: u8): void {
        if (!this.ramEnabled) return;
        this.ram[(address - 0xa000) & 0x1ff] = value & 0x0f;
    }

    getState(): Mbc2State {
        return { romBank: this.romBank, ramEnabled: this.ramEnabled, ram: bytesToBase64(this.ram) };
    }

    setState(state: unknown): void {
        const s = state as Mbc2State;
        this.romBank = s.romBank;
        this.ramEnabled = s.ramEnabled;
        this.ram.set(base64ToBytes(s.ram));
    }
}

interface Mbc2State {
    romBank: number;
    ramEnabled: boolean;
    ram: string;
}

// MBC5: switchable 16KB ROM bank at 0x4000-0x7FFF (9-bit bank register, split
// across two write regions - unlike every earlier MBC, bank 0 is a valid,
// unaliased selection here), plus up to 16 RAM banks. Rumble cartridges reuse
// the RAM bank register's bit 3 as a motor on/off flag instead of a real bank
// bit, but nothing here drives a rumble motor, so that bit is simply masked
// off rather than given special handling.
export class Mbc5 implements Mbc {
    private romBankLow = 0;
    private romBankHigh = 0;
    private ramBank = 0;
    private ramEnabled = false;
    private ram: Uint8Array;
    private romBankCount: number;

    constructor(
        private rom: Uint8Array,
        ramSize: number,
        private hasRumble: boolean,
    ) {
        this.ram = new Uint8Array(ramSize);
        this.romBankCount = Math.max(1, Math.ceil(rom.length / 0x4000));
    }

    private romBank(): number {
        return ((this.romBankHigh << 8) | this.romBankLow) % this.romBankCount;
    }

    readRom(address: u16): u8 {
        if (address <= 0x3fff) {
            return u8(this.rom[address] ?? 0xff);
        }
        return u8(this.rom[this.romBank() * 0x4000 + (address - 0x4000)] ?? 0xff);
    }

    writeRom(address: u16, value: u8): void {
        if (address <= 0x1fff) {
            this.ramEnabled = (value & 0x0f) === 0x0a;
        } else if (address <= 0x2fff) {
            this.romBankLow = value;
        } else if (address <= 0x3fff) {
            this.romBankHigh = value & 0x01;
        } else if (address <= 0x5fff) {
            this.ramBank = value & (this.hasRumble ? 0x07 : 0x0f);
        }
    }

    private ramOffset(address: u16): number {
        const ramBankCount = Math.max(1, this.ram.length / 0x2000);
        const bank = this.ramBank % ramBankCount;
        return bank * 0x2000 + (address - 0xa000);
    }

    readRam(address: u16): u8 {
        if (!this.ramEnabled || this.ram.length === 0) return u8(0xff);
        return u8(this.ram[this.ramOffset(address)]);
    }

    writeRam(address: u16, value: u8): void {
        if (!this.ramEnabled || this.ram.length === 0) return;
        this.ram[this.ramOffset(address)] = value;
    }

    getState(): Mbc5State {
        return {
            romBankLow: this.romBankLow,
            romBankHigh: this.romBankHigh,
            ramBank: this.ramBank,
            ramEnabled: this.ramEnabled,
            ram: bytesToBase64(this.ram),
        };
    }

    setState(state: unknown): void {
        const s = state as Mbc5State;
        this.romBankLow = s.romBankLow;
        this.romBankHigh = s.romBankHigh;
        this.ramBank = s.ramBank;
        this.ramEnabled = s.ramEnabled;
        this.ram.set(base64ToBytes(s.ram));
    }
}

interface Mbc5State {
    romBankLow: number;
    romBankHigh: number;
    ramBank: number;
    ramEnabled: boolean;
    ram: string;
}

export function createMbc(rom: Uint8Array): Mbc {
    const cartType = rom[0x147] ?? 0x00;
    const ramSize = RAM_SIZES[rom[0x149] ?? 0] ?? 0;

    switch (cartType) {
        case 0x00: // ROM ONLY
            return new Mbc0(rom);
        case 0x01: // MBC1
        case 0x02: // MBC1+RAM
        case 0x03: // MBC1+RAM+BATTERY
            return new Mbc1(rom, ramSize);
        case 0x05: // MBC2
        case 0x06: // MBC2+BATTERY
            return new Mbc2(rom);
        case 0x0f: // MBC3+TIMER+BATTERY
        case 0x10: // MBC3+TIMER+RAM+BATTERY
        case 0x11: // MBC3
        case 0x12: // MBC3+RAM
        case 0x13: // MBC3+RAM+BATTERY
            return new Mbc3(rom, ramSize);
        case 0x19: // MBC5
        case 0x1a: // MBC5+RAM
        case 0x1b: // MBC5+RAM+BATTERY
            return new Mbc5(rom, ramSize, false);
        case 0x1c: // MBC5+RUMBLE
        case 0x1d: // MBC5+RUMBLE+RAM
        case 0x1e: // MBC5+RUMBLE+RAM+BATTERY
            return new Mbc5(rom, ramSize, true);
        default:
            console.warn(`Unsupported cartridge type 0x${cartType.toString(16)}, falling back to ROM ONLY`);
            return new Mbc0(rom);
    }
}
