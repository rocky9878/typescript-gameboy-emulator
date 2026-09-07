import type { InertiaLinkProps } from '@inertiajs/vue3';
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { u16, u8 } from '@/emulator';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function toUrl(href: NonNullable<InertiaLinkProps['href']>) {
    return typeof href === 'string' ? href : href?.url;
}

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
