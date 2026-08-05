import { u16, u8 } from '@/types';
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function overflowingAdd8(a: u8, b: u8|number): [u8, boolean] {
    const sum = a + b;
    return [u8(sum), sum > 0xff];
}

export function overflowingAdd16(a: u16, b: u16|number): [u16, boolean] {
    const sum = a + b;
    return [u16(sum), sum > 0xffff];
}

export function overflowingSub8(a: u8, b: u8|number): [u8, boolean] {
    const sum = a - b;
    return [u8(sum), sum < 0];
}

export function overflowingSub16(a: u16, b: u16|number): [u16, boolean] {
    const sum = a - b;
    return [u16(sum), sum < 0];
}
