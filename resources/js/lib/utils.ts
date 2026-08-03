import { u8 } from '@/types';
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function overflowingAdd(a: u8, b: u8): [u8, boolean] {
    const sum = a + b;
    return [u8(sum), sum > 0xff];
}
