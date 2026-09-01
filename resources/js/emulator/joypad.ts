import { u8 } from '.';

export type JoypadButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'select' | 'start';

export interface JoypadState {
    selectDpad: boolean;
    selectButtons: boolean;
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    a: boolean;
    b: boolean;
    select: boolean;
    start: boolean;
}

// 0xFF00 (P1/JOYP): bits 4-5 select which group of four buttons the lower
// nibble reports (both write-only from the game's side), bits 0-3 read back
// the state of the selected group, active-low (0 = pressed).
export class Joypad {
    private selectDpad = false;
    private selectButtons = false;

    private up = false;
    private down = false;
    private left = false;
    private right = false;
    private a = false;
    private b = false;
    private select = false;
    private start = false;

    constructor(private requestInterrupt: () => void) {}

    readRegister(): u8 {
        let lowNibble = 0b1111;
        if (this.selectDpad) {
            if (this.right) lowNibble &= ~0b0001;
            if (this.left) lowNibble &= ~0b0010;
            if (this.up) lowNibble &= ~0b0100;
            if (this.down) lowNibble &= ~0b1000;
        }
        if (this.selectButtons) {
            if (this.a) lowNibble &= ~0b0001;
            if (this.b) lowNibble &= ~0b0010;
            if (this.select) lowNibble &= ~0b0100;
            if (this.start) lowNibble &= ~0b1000;
        }

        const selectBits = (this.selectButtons ? 0 : 0b100000) | (this.selectDpad ? 0 : 0b010000);
        return u8(0b11000000 | selectBits | lowNibble);
    }

    writeRegister(value: u8): void {
        this.selectButtons = (value & 0b100000) === 0;
        this.selectDpad = (value & 0b010000) === 0;
    }

    setButton(button: JoypadButton, pressed: boolean): void {
        const wasPressed = this[button];
        this[button] = pressed;

        if (pressed && !wasPressed) {
            const isDpad = button === 'up' || button === 'down' || button === 'left' || button === 'right';
            if ((isDpad && this.selectDpad) || (!isDpad && this.selectButtons)) {
                this.requestInterrupt();
            }
        }
    }

    getState(): JoypadState {
        return {
            selectDpad: this.selectDpad,
            selectButtons: this.selectButtons,
            up: this.up,
            down: this.down,
            left: this.left,
            right: this.right,
            a: this.a,
            b: this.b,
            select: this.select,
            start: this.start,
        };
    }

    setState(state: JoypadState): void {
        this.selectDpad = state.selectDpad;
        this.selectButtons = state.selectButtons;
        this.up = state.up;
        this.down = state.down;
        this.left = state.left;
        this.right = state.right;
        this.a = state.a;
        this.b = state.b;
        this.select = state.select;
        this.start = state.start;
    }
}
