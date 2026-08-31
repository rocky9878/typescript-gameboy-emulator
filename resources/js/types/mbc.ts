import { u8, u16 } from '.';

export interface Mbc {
    readRom(address: u16): u8;
    writeRom(address: u16, value: u8): void;
    readRam(address: u16): u8;
    writeRam(address: u16, value: u8): void;
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
        default:
            console.warn(`Unsupported cartridge type 0x${cartType.toString(16)}, falling back to ROM ONLY`);
            return new Mbc0(rom);
    }
}
