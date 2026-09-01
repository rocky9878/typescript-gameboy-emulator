import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { u16, u8 } from '@/emulator';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// These run on nearly every ADD/SUB/INC/DEC the CPU executes - often enough, at real
// Game Boy speed, that a fresh [value, overflow] tuple allocated per call becomes real
// GC pressure and was eating into the CPU's already razor-thin real-time performance
// margin (measured at ~0.9965x realtime on Pokemon Red, i.e. barely unable to keep up -
// any jitter pushes it under 1x, which starves the audio pipeline and sounds like
// crackling). Packing the overflow flag into an unused high bit of the same number
// instead avoids the allocation entirely; unpack the value with the existing u8()/u16()
// (their masking already discards the flag bit) and the flag with overflowed().
const OVERFLOW_FLAG = 0x10000; // bit 16 - above any 8-bit or 16-bit result

export function overflowed(packed: number): boolean {
    return (packed & OVERFLOW_FLAG) !== 0;
}

export function overflowingAdd8(a: u8, b: u8|number): number {
    const sum = a + b;

    return u8(sum) | (sum > 0xff ? OVERFLOW_FLAG : 0);
}

export function overflowingAdd16(a: u16, b: u16|number): number {
    const sum = a + b;

    return u16(sum) | (sum > 0xffff ? OVERFLOW_FLAG : 0);
}

export function overflowingSub8(a: u8, b: u8|number): number {
    const sum = a - b;

    return u8(sum) | (sum < 0 ? OVERFLOW_FLAG : 0);
}

export function overflowingSub16(a: u16, b: u16|number): number {
    const sum = a - b;

    return u16(sum) | (sum < 0 ? OVERFLOW_FLAG : 0);
}
