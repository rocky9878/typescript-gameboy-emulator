export * from './auth';

export type u8 = number & { readonly __brand: 'u8' };
export type u16 = number & { readonly __brand: 'u16' };

export type InstructionType = 'NOP'|'ADD'|'ADC'|'SUB'|'JP'

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

const ZERO_FLAG_BYTE_POSITION: u8 = u8(7);
const SUBTRACT_FLAG_BYTE_POSITION: u8 = u8(6);
const HALF_CARRY_FLAG_BYTE_POSITION: u8 = u8(5);
const CARRY_FLAG_BYTE_POSITION: u8 = u8(4);

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

export class registers {
    a: u8 = u8(0);
    b: u8 = u8(0);
    c: u8 = u8(0);
    d: u8 = u8(0);
    e: u8 = u8(0);
    f: FlagsRegister = { zero: false, subtract: false, half_carry: false, carry: false };
    h: u8 = u8(0);
    l: u8 = u8(0);

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
}
