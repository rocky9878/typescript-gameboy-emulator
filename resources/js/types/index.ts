export * from './auth';
export * from './navigation';
export * from './ui';

export type SaveState = {
    save_data: string;
    rom_name: string;
    slot: number;
    created_at: string;
}

// Keyed by slot number (1-10); null when the user is not authenticated.
export type SaveStateMap = Record<number, SaveState> | null;
