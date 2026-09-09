import { overflowingAdd8, overflowingAdd16, overflowingSub8, overflowingSub16, overflowed } from "@/lib/utils";
import { JumpConditions, MemoryBus, registers, rom, u16, u8, bytesToBase64, base64ToBytes   } from ".";
import type {FlagsRegister, MemoryBusState} from ".";
import { Apu } from "./apu";
import type { JoypadButton } from "./joypad";
import { createMbc } from "./mbc";
import type { Instruction } from "./instruction";
import { ArithmeticTarget } from "./instruction";
import { instructionFromByte } from "./opcodes";

// Bumped whenever the shape of the serialized state below changes in a way that would
// make an older save state misread as valid rather than fail loudly.
const SAVE_STATE_VERSION = 2;

interface SaveState {
    version: number;
    register: {
        a: u8; b: u8; c: u8; d: u8; e: u8; f: FlagsRegister; h: u8; l: u8; pc: u16; sp: u16;
    };
    is_halted: boolean;
    ime: boolean;
    ime_next: boolean;
    cycleSum: number;
    systemCounter: number;
    speed: 1 | 2;
    bus: MemoryBusState;
}

export class CPU {
    register = new registers;
    bus = new MemoryBus;
    is_halted = false;
    ime = false;
    ime_next = false;
    cycleSum = 0;
    // 16-bit free-running counter DIV is the upper byte of; TIMA increments are edge-
    // triggered off a TAC-selected bit of this counter, entirely independent of TIMA's own
    // value (writing TIMA does NOT resync anything on real hardware). Kept unbounded
    // (not masked to 16 bits) so the periodic-increment math below never has to special-
    // case a wraparound - only the low 16 bits are ever actually exposed as DIV.
    systemCounter = 0;
    // CGB double-speed mode: instruction T-state costs (the handleTimer arguments) stay
    // the same at either speed - what changes is how much real/PPU-relative time each
    // T-state represents. 1 = normal speed, 2 = double speed.
    speed: 1 | 2 = 1;

    constructor() {
        this.bus.onDivWrite = () => {
            this.systemCounter = 0;
        };
    }

    async init(romPath: string): Promise<void> {
        await this.bus.init(romPath);
        this.configureForRom();
    }

    // Reads the cartridge header and sets the console mode plus the register state the boot
    // ROM would have left behind (this engine skips the boot ROM). Call once, after the ROM
    // bytes and MBC are in place. `mode` forces DMG/CGB behaviour; 'auto' uses the header.
    configureForRom(mode: ConsoleMode = 'auto'): void {
        const header = this.bus.rom.memory[0x143] ?? 0;
        // $80 = CGB-enhanced (also runs on DMG), $C0 = CGB-only - the exact values the boot
        // ROM checks (a plain bit-7 test would false-positive on old carts whose title runs
        // through $143). A real CGB runs both in CGB mode; 'dmg' forces DMG behaviour.
        const headerWantsCgb = header === 0x80 || header === 0xc0;
        this.bus.cgb = mode === 'cgb' || (mode === 'auto' && headerWantsCgb);

        this.bus.applyBootState();

        if (this.bus.cgb) {
            // CGB-in-CGB-mode post-boot register state (Pan Docs). Games branch on these for
            // hardware detection.
            this.register.a = u8(0x11);
            this.register.f = { zero: true, subtract: false, half_carry: false, carry: false };
            this.register.b = u8(0x00);
            this.register.c = u8(0x00);
            this.register.d = u8(0xff);
            this.register.e = u8(0x56);
            this.register.h = u8(0x00);
            this.register.l = u8(0x0d);
        }
    }

    // Serializes the full emulation state (CPU/PPU/APU/MBC/RAM - everything needed to
    // resume execution exactly where it left off), gzips it, and returns the compressed
    // bytes as a base64 string. Assumes the same ROM is already loaded when restoring:
    // the cartridge image itself isn't included.
    //
    // The underlying JSON is still mostly base64 text (VRAM/WRAM/cartridge RAM), which
    // gzip compresses well - GB RAM is full of runs of zeros and repeated tile data.
    // Async because CompressionStream has no synchronous equivalent in browsers.
    async getSaveState(): Promise<string> {
        const state: SaveState = {
            version: SAVE_STATE_VERSION,
            register: {
                a: this.register.a,
                b: this.register.b,
                c: this.register.c,
                d: this.register.d,
                e: this.register.e,
                f: this.register.f,
                h: this.register.h,
                l: this.register.l,
                pc: this.register.pc,
                sp: this.register.sp,
            },
            is_halted: this.is_halted,
            ime: this.ime,
            ime_next: this.ime_next,
            cycleSum: this.cycleSum,
            systemCounter: this.systemCounter,
            speed: this.speed,
            bus: this.bus.getState(),
        };

        const json = JSON.stringify(state);
        const compressedStream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        const compressedBytes = new Uint8Array(await new Response(compressedStream).arrayBuffer());

        return bytesToBase64(compressedBytes);
    }

    // Restores a base64 string previously produced by getSaveState(). Throws if it's
    // malformed, not validly gzipped, or was written by an incompatible (or missing)
    // version, rather than silently loading a partially-applied or garbage state.
    async setSaveState(compressed: string): Promise<void> {
        const compressedBytes = base64ToBytes(compressed);
        const decompressedStream = new Blob([compressedBytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
        const json = await new Response(decompressedStream).text();
        const state = JSON.parse(json) as SaveState;

        if (state.version !== SAVE_STATE_VERSION) {
            throw new Error(`Save state version mismatch: expected ${SAVE_STATE_VERSION}, got ${state.version}`);
        }

        this.register.a = state.register.a;
        this.register.b = state.register.b;
        this.register.c = state.register.c;
        this.register.d = state.register.d;
        this.register.e = state.register.e;
        this.register.f = state.register.f;
        this.register.h = state.register.h;
        this.register.l = state.register.l;
        this.register.pc = state.register.pc;
        this.register.sp = state.register.sp;

        this.is_halted = state.is_halted;
        this.ime = state.ime;
        this.ime_next = state.ime_next;
        this.cycleSum = state.cycleSum;
        this.systemCounter = state.systemCounter;
        this.speed = state.speed;

        this.bus.setState(state.bus);
    }

    // volume is 0..1; ramps slightly to avoid clicks.
    setVolume(volume: number) {
        const clamped = Math.max(0, Math.min(1, volume));
        gain.gain.setTargetAtTime(clamped, audioCtx.currentTime, 0.01);
    }

    getVolume(): number {
        return gain.gain.value;
    }


    step() {
        let instruction_byte = this.bus.readByte(this.register.pc);
        const prefixed = instruction_byte == 0xCB;

        if (prefixed) {
            instruction_byte = this.bus.readByte(u16(this.register.pc + 1));
        }

        const instruction = instructionFromByte(instruction_byte, prefixed);

        if(instruction) {
            this.register.pc = this.execute(instruction);
        } else {
            console.error('Unkown instruction found for: 0x'+instruction_byte.toString(16));

            throw new Error('halt');
        }
    }

    execute(instruction: Instruction): u16 {
        if(this.is_halted && !this.ime) {
            this.handleTimer(4);

            if (this.bus.readByte(u16(0xffff)) & this.bus.readByte(u16(0xff0f))) {
                this.is_halted = false;
            }

            return this.register.pc;
        }

        if(this.ime) {
            if(this.bus.readByte(u16(0xffff)) & this.bus.readByte(u16(0xff0f))) {
                // Priority order: v-blank, LCD, timer, serial, joypad. Only the highest-priority
                // pending+enabled interrupt is dispatched; the instruction already fetched for
                // this step is discarded (the interrupt preempts it) rather than still executed
                // with a pc the dispatch just overwrote.
                let vector: u16 | null = null;

                if((this.bus.readByte(u16(0xffff)) & 1) & (this.bus.readByte(u16(0xff0f)) & 1)) {
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) & ~(1)))
                    vector = u16(0x40);
                } else if((this.bus.readByte(u16(0xffff)) & (1 << 1)) & (this.bus.readByte(u16(0xff0f)) & (1 << 1))) {
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) & ~(1 << 1)))
                    vector = u16(0x48);
                } else if((this.bus.readByte(u16(0xffff)) & (1 << 2)) & (this.bus.readByte(u16(0xff0f)) & (1 << 2))) {
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) & ~(1 << 2)))
                    vector = u16(0x50);
                } else if((this.bus.readByte(u16(0xffff)) & (1 << 3)) & (this.bus.readByte(u16(0xff0f)) & (1 << 3))) {
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) & ~(1 << 3)))
                    vector = u16(0x58);
                } else if((this.bus.readByte(u16(0xffff)) & (1 << 4)) & (this.bus.readByte(u16(0xff0f)) & (1 << 4))) {
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) & ~(1 << 4)))
                    vector = u16(0x60);
                }

                if (vector !== null) {
                    this.ime = false;
                    this.is_halted = false; // wake from HALT: without this, the next step's
                    // is_halted && !ime check re-enters the idle branch instead of running
                    // the vector's code, freezing forever once no further interrupt can fire.
                    this.push(this.register.pc); // self-times 12 of the dispatch's 20 cycles
                    this.handleTimer(8);

                    return vector;
                }
            }
        }

        if(this.ime_next) {
            this.ime = true;
            this.ime_next = false;
        }

        switch (instruction.kind) {
            case 'ADC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.adc(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.adc(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.adc(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.adc(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.adc(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.adc(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.adc(this.register.l); break;
                    case ArithmeticTarget.HLP: this.register.a = this.adc(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.adc(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.U8 || instruction.target === ArithmeticTarget.HLP) this.handleTimer(8); else this.handleTimer(4);
                return instruction.target === ArithmeticTarget.U8 ? u16(this.register.pc + 2) : u16(this.register.pc + 1);
            }
            case 'ADD': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.add(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.add(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.add(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.add(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.add(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.add(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.add(this.register.l); break;
                    case ArithmeticTarget.HL:
                        switch(instruction.loadTarget) {
                            case ArithmeticTarget.BC: this.register.setHl(this.add16(this.register.bc())); break;
                            case ArithmeticTarget.DE: this.register.setHl(this.add16(this.register.de())); break;
                            case ArithmeticTarget.HL: this.register.setHl(this.add16(this.register.hl())); break;
                            case ArithmeticTarget.SP: this.register.setHl(this.add16(this.register.sp)); break;
                        } break;
                    case ArithmeticTarget.HLP: this.register.a = this.add(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.SP:
                        let signed = <number>this.bus.readByte(u16(this.register.pc + 1));
                        this.register.f.carry = ((this.register.sp & 0xff) + signed) > 0xff;
                        if (signed > 127) signed -= 256;
                        const newVal = u16(overflowingAdd16(this.register.sp, signed));
                        this.register.f.zero = false;
                        this.register.f.subtract = false;
                        this.register.f.half_carry = (this.register.sp & 0xf) + (signed & 0xf) > 0xf;
                        this.register.sp = newVal;
                        break;
                    case ArithmeticTarget.U8: this.register.a = this.add(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.HL || instruction.target === ArithmeticTarget.HLP) {
                    this.handleTimer(8);
                    return u16(this.register.pc + 1);
                }
                if(instruction.target === ArithmeticTarget.U8 || instruction.target === ArithmeticTarget.SP) {
                    instruction.target === ArithmeticTarget.SP ? this.handleTimer(16) : this.handleTimer(8);
                    return u16(this.register.pc + 2)
                }
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'AND': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.and(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.and(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.and(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.and(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.and(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.and(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.and(this.register.l); break;
                    case ArithmeticTarget.HLP: this.register.a = this.and(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.and(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.U8 || instruction.target === ArithmeticTarget.HLP) this.handleTimer(8); else this.handleTimer(4);
                return instruction.target === ArithmeticTarget.U8 ? u16(this.register.pc + 2) : u16(this.register.pc + 1);
            }
            case 'BIT': {
                switch (instruction.loadTarget) {
                    case ArithmeticTarget.A: this.bit(instruction.target, this.register.a); break;
                    case ArithmeticTarget.B: this.bit(instruction.target, this.register.b); break;
                    case ArithmeticTarget.C: this.bit(instruction.target, this.register.c); break;
                    case ArithmeticTarget.D: this.bit(instruction.target, this.register.d); break;
                    case ArithmeticTarget.E: this.bit(instruction.target, this.register.e); break;
                    case ArithmeticTarget.H: this.bit(instruction.target, this.register.h); break;
                    case ArithmeticTarget.L: this.bit(instruction.target, this.register.l); break;
                    case ArithmeticTarget.HLP: this.bit(instruction.target, this.bus.readByte(this.register.hl())); break;
                }
                if(instruction.loadTarget === ArithmeticTarget.HLP) this.handleTimer(12);
                else this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'CALL': {
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                const shouldJump = jumpConditions[<JumpConditions>instruction.target];
                // Taken (24 total) hands 12 off to push()'s self-timing; not-taken never
                // calls push() and is 12 total either way.
                this.handleTimer(12);
                return this.call(shouldJump);
            }
            case 'CCF': {
                this.register.f.carry = !this.register.f.carry;
                this.register.f.half_carry = false;
                this.register.f.subtract = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'CP': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.cp(this.register.a); break;
                    case ArithmeticTarget.B: this.cp(this.register.b); break;
                    case ArithmeticTarget.C: this.cp(this.register.c); break;
                    case ArithmeticTarget.D: this.cp(this.register.d); break;
                    case ArithmeticTarget.E: this.cp(this.register.e); break;
                    case ArithmeticTarget.H: this.cp(this.register.h); break;
                    case ArithmeticTarget.L: this.cp(this.register.l); break;
                    case ArithmeticTarget.HLP: this.cp(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.cp(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.HLP || instruction.target === ArithmeticTarget.U8) this.handleTimer(8); else this.handleTimer(4);
                return instruction.target === ArithmeticTarget.U8 ? u16(this.register.pc + 2) : u16(this.register.pc + 1);
            }
            case 'CPL': {
                this.register.a = u8(~this.register.a);
                this.register.f.subtract = true;
                this.register.f.half_carry = true;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'DAA': {
                let adjustment = 0;
                if(this.register.f.subtract) {
                    if (this.register.f.half_carry) adjustment += 0x6;
                    if (this.register.f.carry) adjustment += 0x60;

                    this.register.a = u8(this.register.a - adjustment);
                } else {
                    if (this.register.f.half_carry || (this.register.a & 0xf) > 0x9) adjustment += 0x6;

                    if (this.register.f.carry || this.register.a > 0x99) {
                        adjustment += 0x60;
                        this.register.f.carry = true;
                    }

                    this.register.a = u8(this.register.a + adjustment);
                }

                this.register.f.zero = (this.register.a === 0)
                this.register.f.half_carry = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'DEC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.dec8(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.dec8(this.register.b); break;
                    // 16-bit inc/dec split into its two real M-cycles (fetch, then the IDU
                    // decrement) so the OAM-bug row check sees PPU state as of the IDU cycle
                    // itself, not state left over from the previous instruction entirely.
                    case ArithmeticTarget.BC: this.handleTimer(4); this.checkOamOn16BitOp(this.register.bc()); this.register.setBc(this.dec16(this.register.bc())); this.handleTimer(4); break;
                    case ArithmeticTarget.C: this.register.c = this.dec8(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.dec8(this.register.d); break;
                    case ArithmeticTarget.DE: this.handleTimer(4); this.checkOamOn16BitOp(this.register.de()); this.register.setDe(this.dec16(this.register.de())); this.handleTimer(4); break;
                    case ArithmeticTarget.E: this.register.e = this.dec8(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.dec8(this.register.h); break;
                    case ArithmeticTarget.HL: this.handleTimer(4); this.checkOamOn16BitOp(this.register.hl()); this.register.setHl(this.dec16(this.register.hl())); this.handleTimer(4); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.dec8(this.bus.readByte(this.register.hl()))); break;
                    case ArithmeticTarget.L: this.register.l = this.dec8(this.register.l); break;
                    case ArithmeticTarget.SP: this.handleTimer(4); this.checkOamOn16BitOp(this.register.sp); this.register.sp = this.dec16(this.register.sp); this.handleTimer(4); break;
                }
                if(!(instruction.target === ArithmeticTarget.SP || instruction.target === ArithmeticTarget.HL || instruction.target === ArithmeticTarget.DE || instruction.target === ArithmeticTarget.BC)) {
                    instruction.target === ArithmeticTarget.HLP ? this.handleTimer(12) : this.handleTimer(4);
                }
                return u16(this.register.pc + 1);
            }
            case 'DI': {
                this.ime = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'EI': {
                this.ime_next = true;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'HALT': {
                this.is_halted = !this.is_halted;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'INC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.inc8(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.inc8(this.register.b); break;
                    // 16-bit inc/dec split into its two real M-cycles (fetch, then the IDU
                    // increment) so the OAM-bug row check sees PPU state as of the IDU cycle
                    // itself, not state left over from the previous instruction entirely.
                    case ArithmeticTarget.BC: this.handleTimer(4); this.checkOamOn16BitOp(this.register.bc()); this.register.setBc(this.inc16(this.register.bc())); this.handleTimer(4); break;
                    case ArithmeticTarget.C: this.register.c = this.inc8(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.inc8(this.register.d); break;
                    case ArithmeticTarget.DE: this.handleTimer(4); this.checkOamOn16BitOp(this.register.de()); this.register.setDe(this.inc16(this.register.de())); this.handleTimer(4); break;
                    case ArithmeticTarget.E: this.register.e = this.inc8(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.inc8(this.register.h); break;
                    case ArithmeticTarget.HL: this.handleTimer(4); this.checkOamOn16BitOp(this.register.hl()); this.register.setHl(this.inc16(this.register.hl())); this.handleTimer(4); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.inc8(this.bus.readByte(this.register.hl()))); break;
                    case ArithmeticTarget.L: this.register.l = this.inc8(this.register.l); break;
                    case ArithmeticTarget.SP: this.handleTimer(4); this.checkOamOn16BitOp(this.register.sp); this.register.sp = this.inc16(this.register.sp); this.handleTimer(4); break;
                }
                if(!(instruction.target === ArithmeticTarget.SP || instruction.target === ArithmeticTarget.HL || instruction.target === ArithmeticTarget.DE || instruction.target === ArithmeticTarget.BC)) {
                    instruction.target === ArithmeticTarget.HLP ? this.handleTimer(12) : this.handleTimer(4);
                }
                return u16(this.register.pc + 1);
            }
            case 'JP': {
                if(instruction.target === ArithmeticTarget.HL) {
                    this.handleTimer(4);
                    return this.register.hl();
                }
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                const shouldJump = jumpConditions[<JumpConditions>instruction.target];
                shouldJump ? this.handleTimer(16) : this.handleTimer(12);
                return this.jump(shouldJump);
            }
            case 'JR': {
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                if (jumpConditions[<JumpConditions>instruction.target]) {
                    let byte = <number>this.bus.readByte(u16(this.register.pc + 1));
                    if (byte > 127) byte -= 256;
                    this.handleTimer(12);
                    return u16(this.register.pc + 2 + byte);
                }
                this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'LD': {
                let source_value: u8|u16 = u8(0);
                let ffu8pLoadSelfTimed = false;
                let ffu8pStoreSelfTimed = false;
                switch (instruction.loadTarget) {
                    case ArithmeticTarget.A: source_value = this.register.a; break;
                    case ArithmeticTarget.B: source_value = this.register.b; break;
                    case ArithmeticTarget.BCP: source_value = this.bus.readByte(this.register.bc()); break;
                    case ArithmeticTarget.C: source_value = this.register.c; break;
                    case ArithmeticTarget.D: source_value = this.register.d; break;
                    case ArithmeticTarget.DEP: source_value = this.bus.readByte(this.register.de()); break;
                    case ArithmeticTarget.E: source_value = this.register.e; break;
                    case ArithmeticTarget.FFU8P: {
                        // LDH A,(n): split into its two real M-cycles (fetch+read-operand,
                        // then the actual high-page read) so a read timed to land on a
                        // specific dot (e.g. sampling LY right at a PPU mode boundary) sees
                        // PPU state as of that read's own M-cycle, not the previous instruction's.
                        const offset = this.bus.readByte(u16(this.register.pc + 1));
                        this.handleTimer(8);
                        source_value = this.bus.readByte(u16(0xff00 | offset));
                        this.handleTimer(4);
                        ffu8pLoadSelfTimed = true;
                        break;
                    }
                    case ArithmeticTarget.FFCP: source_value = this.bus.readByte(u16(0xff << 8 | this.register.c)); break;
                    case ArithmeticTarget.H: source_value = this.register.h; break;
                    case ArithmeticTarget.HL: source_value = this.register.hl(); break;
                    // LD A,(HL+/-): on real hardware the read itself is the only OAM-bug
                    // trigger here (the implied inc/dec has no separate glitch-write, per
                    // SameBoy's cycle-accurate model - Pan Docs' "triggers twice" is wrong).
                    case ArithmeticTarget.HLD: this.checkOamOn16BitOp(this.register.hl(), 'read'); source_value = this.bus.readByte(this.register.hl()); this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.HLI: this.checkOamOn16BitOp(this.register.hl(), 'read'); source_value = this.bus.readByte(this.register.hl()); this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: source_value = this.bus.readByte(this.register.hl()); break;
                    case ArithmeticTarget.L: source_value = this.register.l; break;
                    case ArithmeticTarget.SP: source_value = this.register.sp; break;
                    case ArithmeticTarget.SPI8:
                        let byte = <number>this.bus.readByte(u16(this.register.pc + 1));
                        this.register.f.carry = ((this.register.sp & 0xff) + byte) > 0xff;
                        if (byte > 127) byte -= 256;
                        const result = u16(overflowingAdd16(this.register.sp, byte));
                        source_value = result;
                        this.register.f.zero = false;
                        this.register.f.subtract = false;
                        this.register.f.half_carry = (this.register.sp & 0xf) + (byte & 0xf) > 0xf;
                        break;
                    case ArithmeticTarget.U8: source_value = this.bus.readByte(u16(this.register.pc + 1)); break;
                    case ArithmeticTarget.U16: source_value = u16((this.bus.readByte(u16(this.register.pc + 2)) << 8) | this.bus.readByte(u16(this.register.pc + 1))); break;
                    case ArithmeticTarget.U16P: source_value = this.bus.readByte(u16((this.bus.readByte(u16(this.register.pc + 2)) << 8) | this.bus.readByte(u16(this.register.pc + 1)))); break;
                }
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = <u8>source_value; break;
                    case ArithmeticTarget.B: this.register.b = <u8>source_value; break;
                    case ArithmeticTarget.BC: this.register.setBc(<u16>source_value); break;
                    case ArithmeticTarget.BCP: this.bus.writeByte(this.register.bc(), <u8>source_value); break;
                    case ArithmeticTarget.C: this.register.c = <u8>source_value; break;
                    case ArithmeticTarget.D: this.register.d = <u8>source_value; break;
                    case ArithmeticTarget.DE: this.register.setDe(<u16>source_value); break;
                    case ArithmeticTarget.DEP: this.bus.writeByte(this.register.de(), <u8>source_value); break;
                    case ArithmeticTarget.E: this.register.e = <u8>source_value; break;
                    case ArithmeticTarget.FFU8P: {
                        // LDH (n),A: split into its two real M-cycles (fetch+read-operand,
                        // then the actual high-page write), same reasoning as the read
                        // direction above - some ROMs time writes to land on a specific dot
                        // or exploit the exact cycle-gap to a following read.
                        const offset = this.bus.readByte(u16(this.register.pc + 1));
                        this.handleTimer(8);
                        this.bus.writeByte(u16(0xff00 | offset), <u8>source_value);
                        this.handleTimer(4);
                        ffu8pStoreSelfTimed = true;
                        break;
                    }
                    case ArithmeticTarget.FFCP: this.bus.writeByte(u16(0xff << 8 | this.register.c), <u8>source_value); break;
                    case ArithmeticTarget.H: this.register.h = <u8>source_value; break;
                    case ArithmeticTarget.HL: this.register.setHl(<u16>source_value); break;
                    case ArithmeticTarget.HLD: this.checkOamOn16BitOp(this.register.hl()); this.bus.writeByte(this.register.hl(), <u8>source_value); this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.HLI: this.checkOamOn16BitOp(this.register.hl()); this.bus.writeByte(this.register.hl(), <u8>source_value); this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), <u8>source_value); break;
                    case ArithmeticTarget.L: this.register.l = <u8>source_value; break;
                    case ArithmeticTarget.SP: this.register.sp = <u16>source_value; break;
                    case ArithmeticTarget.U16: {
                        const addr = u16(this.bus.readByte(u16(this.register.pc + 2)) << 8 | this.bus.readByte(u16(this.register.pc + 1)));
                        if(instruction.loadTarget === ArithmeticTarget.SP) {
                            this.bus.writeByte(addr, u8(source_value & 0xff));
                            this.bus.writeByte(u16(addr + 1), u8(source_value >> 8));
                        } else {
                            this.bus.writeByte(addr, <u8>source_value);
                        }
                        break;
                    }
                }
                if (ffu8pLoadSelfTimed || ffu8pStoreSelfTimed) {
                    // already self-timed above
                } else if(instruction.loadTarget === ArithmeticTarget.U16P || instruction.target === ArithmeticTarget.U16) {
                    instruction.loadTarget === ArithmeticTarget.SP ? this.handleTimer(20) : this.handleTimer(16);
                } else if((instruction.loadTarget === ArithmeticTarget.U16 || instruction.loadTarget === ArithmeticTarget.FFU8P || instruction.target === ArithmeticTarget.FFU8P || instruction.loadTarget === ArithmeticTarget.SPI8) ||
                        (instruction.target === ArithmeticTarget.HLP && instruction.loadTarget === ArithmeticTarget.U8)
                    ) {
                    this.handleTimer(12);
                } else if(instruction.target === ArithmeticTarget.BCP || instruction.loadTarget === ArithmeticTarget.BCP ||
                        instruction.target === ArithmeticTarget.DEP || instruction.loadTarget === ArithmeticTarget.DEP ||
                        instruction.target === ArithmeticTarget.HLI || instruction.loadTarget === ArithmeticTarget.HLI ||
                        instruction.target === ArithmeticTarget.HLD || instruction.loadTarget === ArithmeticTarget.HLD ||
                        instruction.target === ArithmeticTarget.HLP || instruction.loadTarget === ArithmeticTarget.HLP ||
                        instruction.target === ArithmeticTarget.SP || instruction.loadTarget === ArithmeticTarget.U8 ||
                        instruction.target === ArithmeticTarget.FFCP || instruction.loadTarget === ArithmeticTarget.FFCP
                    ) {
                    this.handleTimer(8);
                } else {
                    this.handleTimer(4);
                }
                if (instruction.loadTarget === ArithmeticTarget.U16 || instruction.target === ArithmeticTarget.U16 || instruction.loadTarget === ArithmeticTarget.U16P) {
                    return u16(this.register.pc + 3);
                }
                if (instruction.loadTarget === ArithmeticTarget.U8 || instruction.loadTarget === ArithmeticTarget.SPI8 || instruction.target === ArithmeticTarget.FFU8P || instruction.loadTarget === ArithmeticTarget.FFU8P) {
                    return u16(this.register.pc + 2);
                }
                return u16(this.register.pc + 1);
            }
            case 'NOP': {
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'OR': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.or(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.or(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.or(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.or(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.or(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.or(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.or(this.register.l); break;
                    case ArithmeticTarget.HLP: this.register.a = this.or(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.or(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.HLP || instruction.target === ArithmeticTarget.U8) {
                    this.handleTimer(8);
                    if(instruction.target === ArithmeticTarget.U8) return u16(this.register.pc + 2);
                } else this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'POP': {
                this.handleTimer(4); // M1 fetch; pop() self-times the remaining 8 cycles
                switch (instruction.target) {
                    case ArithmeticTarget.BC: this.register.setBc(this.pop()); break;
                    case ArithmeticTarget.DE: this.register.setDe(this.pop()); break;
                    case ArithmeticTarget.HL: this.register.setHl(this.pop()); break;
                    case ArithmeticTarget.AF: this.register.setAf(this.pop()); break;
                }
                return u16(this.register.pc + 1);
            }
            case 'PUSH': {
                this.handleTimer(4); // M1 fetch; push() self-times the remaining 12 cycles
                switch (instruction.target) {
                    case ArithmeticTarget.BC: this.push(this.register.bc()); break;
                    case ArithmeticTarget.DE: this.push(this.register.de()); break;
                    case ArithmeticTarget.HL: this.push(this.register.hl()); break;
                    case ArithmeticTarget.AF: this.push(this.register.af()); break;
                }
                return u16(this.register.pc + 1);
            }
            case 'RES': {
                switch (instruction.loadTarget) {
                    case ArithmeticTarget.A: this.register.a = this.res(instruction.target, this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.res(instruction.target, this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.res(instruction.target, this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.res(instruction.target, this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.res(instruction.target, this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.res(instruction.target, this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.res(instruction.target, this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.res(instruction.target, this.bus.readByte(this.register.hl()))); break;
                }
                instruction.loadTarget === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'RET': {
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                const shouldJump = jumpConditions[<JumpConditions>instruction.target];
                // Any taken RET calls pop(), which self-times 8; only pre-charge the rest.
                if(instruction.target === JumpConditions.Always) this.handleTimer(8);
                else shouldJump ? this.handleTimer(12) : this.handleTimer(8);
                return this.return(shouldJump);
            }
            case 'RETI': {
                this.ime = true;
                this.handleTimer(8); // pop() (always called here) self-times the other 8
                return this.return(true);
            }
            case 'RLA': {
                const shifted = (this.register.a << 1 & 0xff);
                const b7 = this.register.a >> 7 & 0b1;
                // b0 = original carry
                this.register.a = u8(this.register.f.carry ? shifted | (0b00000001) : shifted & ~(0b00000001));
                // carry = original b7
                this.register.f.carry = b7 ? true : false;
                this.register.f.half_carry = false;
                this.register.f.zero = false;
                this.register.f.subtract = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'RLC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.rlc(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.rlc(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.rlc(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.rlc(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.rlc(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.rlc(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.rlc(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.rlc(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'RLCA': {
                const shifted = (this.register.a << 1 & 0xff);
                const carry = this.register.a >> 7 & 0b1;
                // b0 = original b7
                this.register.a = u8(carry ? shifted | (0b00000001) : shifted & ~(0b00000001));
                // carry = original b7
                this.register.f.carry = carry ? true : false;
                this.register.f.half_carry = false;
                this.register.f.zero = false;
                this.register.f.subtract = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'RRA': {
                const shifted = (this.register.a >> 1 & 0xff);
                const b0 = this.register.a & 0b1;
                // b7 = original carry
                this.register.a = u8(this.register.f.carry ? shifted | (0b10000000) : shifted & ~(0b10000000));
                // carry = original b0
                this.register.f.carry = b0 ? true : false;
                this.register.f.half_carry = false;
                this.register.f.zero = false;
                this.register.f.subtract = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'RL': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.rl(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.rl(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.rl(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.rl(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.rl(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.rl(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.rl(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.rl(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'RR': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.rr(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.rr(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.rr(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.rr(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.rr(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.rr(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.rr(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.rr(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'RRC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.rrc(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.rrc(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.rrc(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.rrc(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.rrc(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.rrc(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.rrc(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.rrc(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'RRCA': {
                const shifted = (this.register.a >> 1 & 0xff);
                const carry = this.register.a & 0b1;
                // b7 = original b0
                this.register.a = u8(carry ? shifted | (0b10000000) : shifted & ~(0b10000000));
                // carry = original b0
                this.register.f.carry = carry ? true : false;
                this.register.f.half_carry = false;
                this.register.f.zero = false;
                this.register.f.subtract = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'RST': {
                this.handleTimer(4); // fetch; push()'s self-timing covers the other 12
                return this.call(true, u8(instruction.target));
            }
            case 'SBC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.sbc(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.sbc(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.sbc(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.sbc(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.sbc(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.sbc(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.sbc(this.register.l); break;
                    case ArithmeticTarget.HLP: this.register.a = this.sbc(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.sbc(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.HLP || instruction.target === ArithmeticTarget.U8) this.handleTimer(8); else this.handleTimer(4);
                return instruction.target === ArithmeticTarget.U8 ? u16(this.register.pc + 2) : u16(this.register.pc + 1);
            }
            case 'SCF': {
                this.register.f.carry = true;
                this.register.f.half_carry = false;
                this.register.f.subtract = false;
                this.handleTimer(4);
                return u16(this.register.pc + 1);
            }
            case 'SET': {
                switch (instruction.loadTarget) {
                    case ArithmeticTarget.A: this.register.a = this.set(instruction.target, this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.set(instruction.target, this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.set(instruction.target, this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.set(instruction.target, this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.set(instruction.target, this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.set(instruction.target, this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.set(instruction.target, this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.set(instruction.target, this.bus.readByte(this.register.hl()))); break;
                }
                instruction.loadTarget === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'SLA': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.sla(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.sla(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.sla(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.sla(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.sla(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.sla(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.sla(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.sla(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'SRA': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.sra(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.sra(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.sra(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.sra(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.sra(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.sra(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.sra(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.sra(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'SRL': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.srl(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.srl(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.srl(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.srl(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.srl(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.srl(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.srl(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.srl(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'STOP': {
                // CGB double-speed switch: KEY1 bit 0 armed, then STOP toggles the speed.
                // On DMG hardware (bus.cgb false) STOP is a plain no-op - a $80 cart running
                // in forced-DMG mode expects that (blargg's cpu_instrs exercises the exact
                // byte sequence expecting no-op behaviour).
                if (this.bus.cgb) {
                    const key1 = this.bus.readByte(u16(0xff4d));

                    if (key1 & 1) {
                        this.speed = this.speed === 1 ? 2 : 1;
                        this.bus.writeByte(u16(0xff4d), u8(this.speed === 2 ? 0x80 : 0x00));
                        this.handleTimer(8200);

                        return u16(this.register.pc + 2);
                    }
                }
                this.handleTimer(4);
                return u16(this.register.pc + 2);
            }
            case 'SUB': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.sub(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.sub(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.sub(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.sub(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.sub(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.sub(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.sub(this.register.l); break;
                    case ArithmeticTarget.HLP: this.register.a = this.sub(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.sub(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.HLP || instruction.target === ArithmeticTarget.U8) this.handleTimer(8); else this.handleTimer(4);
                return instruction.target === ArithmeticTarget.U8 ? u16(this.register.pc + 2) : u16(this.register.pc + 1);
            }
            case 'SWAP': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.swap(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.swap(this.register.b); break;
                    case ArithmeticTarget.C: this.register.c = this.swap(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.swap(this.register.d); break;
                    case ArithmeticTarget.E: this.register.e = this.swap(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.swap(this.register.h); break;
                    case ArithmeticTarget.L: this.register.l = this.swap(this.register.l); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.swap(this.bus.readByte(this.register.hl()))); break;
                }
                instruction.target === ArithmeticTarget.HLP ? this.handleTimer(16) : this.handleTimer(8);
                return u16(this.register.pc + 2);
            }
            case 'XOR': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.xor(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.xor(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.xor(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.xor(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.xor(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.xor(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.xor(this.register.l); break;
                    case ArithmeticTarget.HLP: this.register.a = this.xor(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.xor(this.bus.readByte(u16(this.register.pc + 1))); break;
                }
                if(instruction.target === ArithmeticTarget.HLP || instruction.target === ArithmeticTarget.U8) this.handleTimer(8); else this.handleTimer(4);
                return instruction.target === ArithmeticTarget.U8 ? u16(this.register.pc + 2) : u16(this.register.pc + 1);
            }
        }
    }

    handleTimer(tCycle: number) {
        // A general-purpose VRAM DMA freezes the CPU; fold those cycles in so the rest of
        // the system still advances for the transfer's duration.
        tCycle += this.bus.takeHdmaStall();

        // At double speed the CPU executes twice as many T-states per unit of real time.
        // DIV/TIMA speed up right along with the CPU (so they use the raw tCycle count
        // below), but the PPU and all sound timings stay at the fixed real-world rate
        // regardless of CPU speed, so they advance by "real" cycles (tCycle halved).
        const realCycles = tCycle / this.speed;
        this.bus.ppu.step(realCycles);
        this.bus.apu.step(realCycles);
        this.cycleSum += realCycles;

        // DIV/TIMA both derive from the same free-running system counter and scale with
        // CPU speed (unlike PPU/APU above), so they use the raw tCycle count.
        const oldCounter = this.systemCounter;
        this.systemCounter += tCycle;
        this.bus.syncDivByte(u8(this.systemCounter >> 8));

        const TAC = this.bus.readByte(u16(0xff07));

        // Timer control is TIMA enabled
        if(TAC >> 2 & 1) {
            let period = 0;

            switch(TAC & 0b11) {
                case 0: period = 1024; break; // 4096 Hz   (bit 9 falling edge)
                case 1: period = 16; break;   // 262144 Hz (bit 3 falling edge)
                case 2: period = 64; break;   // 65536 Hz  (bit 5 falling edge)
                case 3: period = 256; break;  // 16384 Hz  (bit 7 falling edge)
            }

            // Number of falling edges of the selected bit within [oldCounter, oldCounter+tCycle) -
            // exactly how many times TIMA increments this step, independent of any writes to TIMA.
            const increments = Math.floor((oldCounter + tCycle) / period) - Math.floor(oldCounter / period);

            for (let i = 0; i < increments; i++) {
                const packed = overflowingAdd8(this.bus.readByte(u16(0xff05)), 1);

                if(!overflowed(packed)) this.bus.writeByte(u16(0xff05), u8(packed));
                else {
                    this.bus.writeByte(u16(0xff05), this.bus.readByte(u16(0xff06))); // reset timer to TMA
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) | 1 << 2)); // set the request timer interrupt flag
                }
            }
        }
    }

    jump(shouldJump: boolean): u16 {
        if(shouldJump) {
            // Gameboy is little endian so read pc + 2 as most significant bit
            // and pc + 1 as least significant bit
            const least_significant_byte = this.bus.readByte(u16(this.register.pc + 1));
            const most_significant_byte = this.bus.readByte(u16(this.register.pc + 2));

            return u16((most_significant_byte << 8) | least_significant_byte)
        } else {
            // If we don't jump we need to still move the program
            // counter forward by 3 since the jump instruction is
            // 3 bytes wide (1 byte for tag and 2 bytes for jump address)
            return u16(this.register.pc + 3);
        }
    }

    adc(value: u8): u8 {
        const carryIn = this.register.f.carry ? 1 : 0;
        const result = this.register.a + value + carryIn;

        this.register.f.zero = (result & 0xff) === 0;
        this.register.f.subtract = false;
        this.register.f.carry = result > 0xff;
        this.register.f.half_carry = (this.register.a & 0xf) + (value & 0xf) + carryIn > 0xf;

        return u8(result);
    }

    add(value: u8): u8 {
        const packed = overflowingAdd8(this.register.a, value);
        const newVal = u8(packed);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.carry = overflowed(packed);
        this.register.f.half_carry = (this.register.a & 0xf) + (value & 0xf) > 0xf;

        return newVal;
    }

    add16(value: u16) {
        const packed = overflowingAdd16(this.register.hl(), value);
        const newVal = u16(packed);

        this.register.f.subtract = false;
        this.register.f.carry = overflowed(packed);
        this.register.f.half_carry = (this.register.hl() & 0xfff) + (value & 0xfff) > 0xfff;

        return newVal;
    }

    and(value: u8): u8 {
        const newVal = u8(this.register.a & value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.carry = false;
        this.register.f.half_carry = true;

        return newVal;
    }

    bit(target: number, byte: u8): void {
        const bit = byte >> target & 0b1;

        this.register.f.zero = bit === 0 ? true : false;
        this.register.f.half_carry = true;
        this.register.f.subtract = false;
    }

    call(shouldJump: boolean, value: u8|null = null): u16 {
        if (value !== null) {
            if (shouldJump) {
                this.push(u16(this.register.pc + 1));
            }

            return shouldJump ? u16(value) : u16(this.register.pc + 1);
        }

        const nextPc = u16(this.register.pc + 3);

        if(shouldJump) {
            this.push(nextPc);

            return u16(this.bus.readByte(u16(value ? 0x00 : this.register.pc + 2)) << 8 | this.bus.readByte(u16(value ?? this.register.pc + 1)));
        } else {
            return nextPc;
        }
    }

    cp(value: u8): void {
        const packed = overflowingSub8(this.register.a, value);
        const newVal = u8(packed);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = true;
        this.register.f.carry = overflowed(packed);
        this.register.f.half_carry = (this.register.a & 0xf) < (value & 0xf);
    }

    dec8(value: u8): u8 {
        const newVal = u8(value - 1);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = true;
        this.register.f.half_carry = (value & 0xf) < 1;

        return newVal;
    }

    dec16(value: u16): u16 {
        return u16(value - 1);
    }

    inc8(value: u8): u8 {
        const newVal = u8(value + 1);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.half_carry = (value & 0xf) + (1 & 0xf) > 0xf;

        return newVal;
    }

    inc16(value: u16): u16 {
        return u16(value + 1);
    }

    or(value: u8): u8 {
        const newVal = u8(this.register.a | value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.carry = false;
        this.register.f.half_carry = false;

        return newVal;
    }

    // Self-times its own 12 T-cycles (3 M-cycles); callers pre-charge only the cycles that
    // happen before this (e.g. opcode fetch), so the OAM-bug check at each step sees PPU
    // state as of that step's own M-cycle instead of state left over from a prior one.
    // Sequencing matches SameBoy's push_rr exactly: one IDU check against the pre-decrement
    // SP (its glitched write always happens before either byte is actually written), then
    // each of the two writes triggers its own check at its own post-decrement address.
    push(value: u16) {
        // M2: internal delay - IDU is about to decrement SP; checked against the
        // not-yet-decremented value, matching real hardware's cycle ordering.
        this.checkOamOn16BitOp(this.register.sp, 'write');
        this.handleTimer(4);

        // M3: SP decrements, write high byte
        this.register.sp = u16(this.register.sp - 1);
        this.checkOamOn16BitOp(this.register.sp, 'write');
        this.bus.writeByte(this.register.sp, u8((value & 0xFF00) >> 8));
        this.handleTimer(4);

        // M4: SP decrements, write low byte
        this.register.sp = u16(this.register.sp - 1);
        this.checkOamOn16BitOp(this.register.sp, 'write');
        this.bus.writeByte(this.register.sp, u8(value));
        this.handleTimer(4);
    }

    // Self-times its own 8 T-cycles (2 M-cycles); see push() above for why.
    // Matches SameBoy's pop_rr: just two plain reads (each its own SP++), no separate
    // IDU glitch-write at all - despite Pan Docs describing one, the reference
    // cycle-accurate implementation this ROM suite's CRCs were computed against has none.
    pop(): u16 {
        this.checkOamOn16BitOp(this.register.sp, 'read');
        const lsb = this.bus.readByte(this.register.sp);
        this.register.sp = u16(this.register.sp + 1);
        this.handleTimer(4);

        this.checkOamOn16BitOp(this.register.sp, 'read');
        const msb = this.bus.readByte(this.register.sp);
        this.register.sp = u16(this.register.sp + 1);
        this.handleTimer(4);

        return u16((msb << 8) | lsb);
    }

    // OAM corruption bug (DMG): a 16-bit register inc/dec/access whose value points into
    // $FE00-$FEFF while the PPU is mid mode-2 OAM scan scrambles whatever OAM row the scan
    // is currently on. `value` is the address as asserted on the bus for this access; `kind`
    // defaults to 'write' since that's what a bare inc/dec's IDU triggers.
    private checkOamOn16BitOp(value: u16, kind: 'write' | 'read' = 'write'): void {
        if (value >= 0xfe00 && value <= 0xfeff) this.bus.triggerOamCorruption(kind);
    }

    res(target: number, byte: u8): u8 {
        const mask = ~(1 << target);

        return u8(byte & mask);
    }

    return(shouldJump: boolean): u16 {
        if(shouldJump) {
            return this.pop();
        } else {
            return u16(this.register.pc + 1);
        }
    }

    rl(byte: u8): u8 {
        const shifted = (byte << 1 & 0xff);
        const b7 = byte >> 7 & 0b1;

        // b0 = original carry
        byte = u8(this.register.f.carry ? shifted | (0b00000001) : shifted & ~(0b00000001));
        // carry = original b7
        this.register.f.carry = b7 ? true : false;
        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    rlc(byte: u8): u8 {
        const shifted = (byte << 1 & 0xff);
        const b7 = byte >> 7 & 0b1;

        // b0 = original b7
        byte = u8(b7 ? shifted | (0b00000001) : shifted & ~(0b00000001));
        // carry = original b7
        this.register.f.carry = b7 ? true : false;
        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    rr(byte: u8): u8 {
        const shifted = (byte >> 1 & 0xff);
        const b0 = byte & 0b1;

        // b7 = original carry
        byte = u8(this.register.f.carry ? shifted | (0b10000000) : shifted & ~(0b10000000));
        // carry = original b0
        this.register.f.carry = b0 ? true : false;

        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    rrc(byte: u8): u8 {
        const shifted = (byte >> 1 & 0xff);
        const b0 = byte & 0b1;

        // b7 = original b0
        byte = u8(b0 ? shifted | (0b10000000) : shifted & ~(0b10000000));
        // carry = original b0
        this.register.f.carry = b0 ? true : false;

        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    set(target: number, byte: u8): u8 {
        const mask = (1 << target);

        return u8(byte | mask);
    }

    sla(byte: u8): u8 {
        const shifted = (byte << 1 & 0xff);
        const b7 = byte >> 7 & 0b1;

        // b0 = 0
        byte = u8(shifted & (0b11111110));
        // carry = original b7
        this.register.f.carry = b7 ? true : false;

        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    sra(byte: u8): u8 {
        const shifted = (byte >> 1 & 0xff);
        const b0 = byte & 0b1;

        // b7 = original b7
        byte = u8((byte >> 7 & 0b1) ? shifted | (0b10000000) : shifted & ~(0b10000000));
        // carry = original b0
        this.register.f.carry = b0 ? true : false;

        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    srl(byte: u8): u8 {
        const shifted = (byte >> 1 & 0xff);
        const b0 = byte & 0b1;

        // b7 = 0
        byte = u8(shifted & (0b01111111));
        // carry = original b7
        this.register.f.carry = b0 ? true : false;

        this.register.f.half_carry = false;
        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.subtract = false;

        return byte;
    }

    sub(value: u8): u8 {
        const packed = overflowingSub8(this.register.a, value);
        const newVal = u8(packed);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = true;
        this.register.f.carry = overflowed(packed);
        this.register.f.half_carry = (this.register.a & 0xf) < (value & 0xf);

        return newVal;
    }

    sbc(value: u8): u8 {
        const carryIn = this.register.f.carry ? 1 : 0;
        const result = this.register.a - value - carryIn;

        this.register.f.zero = (result & 0xff) === 0;
        this.register.f.subtract = true;
        this.register.f.carry = result < 0;
        this.register.f.half_carry = (this.register.a & 0xf) - (value & 0xf) - carryIn < 0;

        return u8(result);
    }

    swap(byte: u8): u8 {
        const high = (byte >> 4 & 0xf);
        const low = byte & 0xf;

        // swap upper and lower nibble
        byte = u8((low << 4) | high);

        this.register.f.zero = byte === 0 ? true : false;
        this.register.f.carry = false;
        this.register.f.half_carry = false;
        this.register.f.subtract = false;

        return byte;
    }

    xor(value: u8): u8 {
        const newVal = u8(this.register.a ^ value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.carry = false;
        this.register.f.half_carry = false;

        return newVal;
    }
}


const KEY_TO_BUTTON: Record<string, JoypadButton> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    KeyZ: 'a',
    KeyX: 'b',
    Enter: 'start',
    ShiftLeft: 'select',
    ShiftRight: 'select',
};

// Real Game Boy clock: 4194304 T-cycles/second. tick() paces by actual elapsed wall time
// rather than a fixed per-frame budget so audio scheduling can't drift against the display's
// true refresh rate (rAF's 60Hz is ~0.45% fast vs the GB's 59.7275Hz).
const BASE_CPU_SPEED = 4194304;
let CPU_SPEED = BASE_CPU_SPEED;
const audioCtx = new AudioContext();
const gain = audioCtx.createGain();
gain.connect(audioCtx.destination);

// Mobile rAF is throttled/jittery and stops when backgrounded - the audio pipeline needs
// more lead and wider drift tolerance there.
const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export function setCpuSpeed(speed: 1|2|3) {
    // APU is unaffected - it always samples at 1x; run()'s tick loop resamples the surplus.
    CPU_SPEED = BASE_CPU_SPEED * speed;
}

export type RunHandle = {
    cpu: CPU;
    // Whether the ROM is running in CGB mode (colour). Reflects the resolved `mode`.
    cgb: boolean;
    // Tears down the rAF loop, event listeners and AudioContext. Must run on SPA navigation
    // away, or the key listeners keep swallowing Z/X/Enter/arrows on other pages.
    dispose: () => void;
};

export type ConsoleMode = 'auto' | 'dmg' | 'cgb';

export async function run(rom: string, canvas?: HTMLCanvasElement, mode: ConsoleMode = 'auto'): Promise<RunHandle> {
    const cpu = new CPU();
    const response = await fetch(rom);
    console.log('test');
    if (!response.ok) {
        throw new Error(`Failed to load ROM "${rom}": ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // A returned HTML error page would otherwise be parsed as a (garbage) cartridge.
    if (bytes.length < 0x150 || bytes[0x104] !== 0xce || bytes[0x105] !== 0xed) {
        throw new Error(`"${rom}" is not a Game Boy ROM (missing Nintendo logo header)`);
    }
    cpu.bus.rom.memory = bytes; // copies bytes into memory starting at pos 0
    cpu.bus.mbc = createMbc(bytes);
    cpu.configureForRom(mode);

    cpu.bus.apu = new Apu(audioCtx.sampleRate);
    const sampleRate = audioCtx.sampleRate;

    // Lead time before the first scheduled chunk: scheduling at ~currentTime routinely
    // underruns before the node is wired into the graph (the startup/resync crackle).
    const SCHEDULE_LEAD = IS_TOUCH ? 0.16 : 0.06;
    // Drop the backlog and resync if scheduled audio drifts this far ahead of playback.
    const MAX_LATENCY = IS_TOUCH ? 0.6 : 0.25;
    let nextChunkTime = audioCtx.currentTime + SCHEDULE_LEAD;
    // Emit audio in fixed-size chunks - per-tick sample counts vary (elapsed-time pacing),
    // and variable-length buffers click at the boundaries.
    const CHUNK_FRAMES = Math.round(sampleRate * 0.02); // 20ms chunks

    // The APU always samples at 1x. During fast-forward the CPU runs Nx the cycles/sec so the
    // APU emits ~Nx the samples; the resampler reads this raw stream (interleaved stereo) at a
    // variable stride and writes exactly enough output frames for real time, so fast-forward
    // audio speeds up at native pitch instead of pitching up. pendingSamples is the resampled
    // output-rate stream the chunk scheduler drains.
    const rawSamples: number[] = [];
    const pendingSamples: number[] = [];
    // resamplePos: fractional read index into rawSamples (frames). ratioEma: smoothed input
    // frames consumed per output frame (~= speed actually achieved). outputDue: output frames
    // owed for elapsed real time.
    let resamplePos = 0;
    let ratioEma = 1;
    let outputDue = 0;
    let lastCpuSpeed = CPU_SPEED;

    // Scheduled-but-not-finished sources, so a visibility change can stop them instead of
    // leaving them to overlap a freshly-timed batch on resume (garbled crackle).
    const activeSources = new Set<AudioBufferSourceNode>();

    const resetAudioQueues = () => {
        rawSamples.length = 0;
        pendingSamples.length = 0;
        resamplePos = 0;
        outputDue = 0;
        nextChunkTime = audioCtx.currentTime + SCHEDULE_LEAD;
    };
    const suspendAudio = () => {
        for (const source of activeSources) source.stop();
        activeSources.clear();
        resetAudioQueues();
        void audioCtx.suspend();
    };
    const onVisibilityChange = () => {
        if (document.hidden) {
            suspendAudio();
        } else {
            void audioCtx.resume();
        }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // pagehide/pageshow are what fire on mobile backgrounding/screen-lock (visibilitychange
    // is unreliable there).
    const onPageHide = () => suspendAudio();
    const onPageShow = () => { void audioCtx.resume(); };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    // Synthetic KeyboardEvents from the on-screen D-pad don't count as a user gesture, so
    // resume() from onKeyDown fails on mobile - a real pointerdown does count.
    const onPointerDown = () => { void audioCtx.resume(); };
    window.addEventListener('pointerdown', onPointerDown);

    const onKeyDown = (e: KeyboardEvent) => {
        void audioCtx.resume();
        const button = KEY_TO_BUTTON[e.code];

        if (button) {
            e.preventDefault();
            cpu.bus.joypad.setButton(button, true);
        }
    };
    const onKeyUp = (e: KeyboardEvent) => {
        const button = KEY_TO_BUTTON[e.code];

        if (button) {
            e.preventDefault();
            cpu.bus.joypad.setButton(button, false);
        }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const ctx = canvas?.getContext('2d');

    if (ctx) {
        // The PPU framebuffer is already packed 0xAABBGGRR - a Uint32 view over the
        // ImageData bytes lets each frame be a single typed-array copy. (Browsers are all
        // little-endian, so packed RGBA maps straight onto the R,G,B,A byte order.)
        const image = ctx.createImageData(160, 144);
        const pixels = new Uint32Array(image.data.buffer);
        cpu.bus.ppu.onFrame = () => {
            pixels.set(cpu.bus.ppu.framebuffer);
            ctx.putImageData(image, 0, 0);
        };
    }

    let lastTickTime = performance.now();
    let rafId = 0;
    let disposed = false;

    const RESAMPLE_TARGET_BACKLOG = sampleRate * (IS_TOUCH ? 0.05 : 0.03);

    function tick() {
        if (disposed) return;

        const now = performance.now();
        // Cap the catch-up window so a long gap (backgrounded tab) can't burst on resume.
        const elapsedSeconds = Math.min((now - lastTickTime) / 1000, 0.1);
        lastTickTime = now;

        const target = cpu.cycleSum + elapsedSeconds * CPU_SPEED;

        // Wall-clock ceiling on the step burst: a device that can't sustain the requested
        // fast-forward speed would otherwise block the main thread every frame and spiral
        // into a freeze. Bailing just runs fast-forward slower; the resampler adapts.
        const enforceDeadline = CPU_SPEED > BASE_CPU_SPEED;
        const deadline = now + (IS_TOUCH ? 12 : 18);
        let stepGuard = 0;
        while (cpu.cycleSum < target) {
            cpu.step();
            // performance.now() per step is too costly - sample it periodically.
            if (enforceDeadline && (stepGuard++ & 0x1fff) === 0 && performance.now() >= deadline) {
                break;
            }
        }

        const samples = cpu.bus.apu.drainSamples();

        if (audioCtx.state !== 'running') {
            // Suspended (pre-gesture / backgrounded): drop the backlog so it doesn't all
            // play out on resume before live audio is heard.
            resetAudioQueues();
            rafId = requestAnimationFrame(tick);

            return;
        }

        if (CPU_SPEED === BASE_CPU_SPEED) {
            // Normal speed: APU rate already matches the device - pass through untouched so
            // the resampler can't colour pitch.
            if (rawSamples.length > 0) {
                rawSamples.length = 0;
                resamplePos = 0;
                outputDue = 0;
            }
            for (let i = 0; i < samples.length; i++) pendingSamples.push(samples[i]);
        } else {
            // Fast-forward: resample the surplus. Seed ratio at the nominal multiplier on a
            // speed change so it doesn't have to climb from 1x; measurement corrects it
            // toward the real rate (which may be < N if the device can't keep up).
            if (CPU_SPEED !== lastCpuSpeed) {
                ratioEma = CPU_SPEED / BASE_CPU_SPEED;
            }

            for (let i = 0; i < samples.length; i++) rawSamples.push(samples[i]);

            if (elapsedSeconds > 0.001 && samples.length > 0) {
                const measuredRatio = samples.length / 2 / (elapsedSeconds * sampleRate);
                ratioEma += (measuredRatio - ratioEma) * 0.05;
            }
            outputDue = Math.min(outputDue + elapsedSeconds * sampleRate, sampleRate * 0.25);

            // Hold the raw backlog near target by flexing frame count (tempo, inaudible),
            // not the resample ratio (pitch).
            const rawFrames = rawSamples.length / 2;
            outputDue = Math.max(0, outputDue + (rawFrames - RESAMPLE_TARGET_BACKLOG) * 0.002);

            const ratio = Math.max(0.05, Math.min(16, ratioEma));
            let produced = 0;
            const wanted = Math.floor(outputDue);
            for (; produced < wanted; produced++) {
                const base = Math.floor(resamplePos);

                if ((base + 1) * 2 + 1 >= rawSamples.length) {
                    break; // out of input
                }

                const frac = resamplePos - base;
                const i = base * 2;
                pendingSamples.push(
                    rawSamples[i] * (1 - frac) + rawSamples[i + 2] * frac,
                    rawSamples[i + 1] * (1 - frac) + rawSamples[i + 3] * frac,
                );
                resamplePos += ratio;
            }
            outputDue -= produced;

            const consumed = Math.floor(resamplePos);
            if (consumed > 0) {
                rawSamples.splice(0, consumed * 2);
                resamplePos -= consumed;
            }
            if (rawSamples.length > sampleRate * 2) {
                rawSamples.splice(0, rawSamples.length - Math.floor(sampleRate));
            }
        }
        lastCpuSpeed = CPU_SPEED;

        // Scheduled audio drifted too far ahead of playback - drop the backlog and resync.
        if (nextChunkTime - audioCtx.currentTime > MAX_LATENCY) {
            for (const source of activeSources) source.stop();
            activeSources.clear();
            resetAudioQueues();
        }

        while (pendingSamples.length >= CHUNK_FRAMES * 2) {
            const chunk = pendingSamples.splice(0, CHUNK_FRAMES * 2);
            const audioBuffer = audioCtx.createBuffer(2, CHUNK_FRAMES, audioCtx.sampleRate);
            const left = audioBuffer.getChannelData(0);
            const right = audioBuffer.getChannelData(1);

            for (let i = 0; i < CHUNK_FRAMES; i++) {
                left[i] = chunk[i * 2];
                right[i] = chunk[i * 2 + 1];
            }

            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(gain);

            // Fell behind? Don't schedule in the past.
            if (nextChunkTime < audioCtx.currentTime) nextChunkTime = audioCtx.currentTime + SCHEDULE_LEAD;

            source.start(nextChunkTime);
            activeSources.add(source);
            source.onended = () => activeSources.delete(source);
            nextChunkTime += audioBuffer.duration;
        }

        rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    const dispose = () => {
        if (disposed) return;
        disposed = true;

        cancelAnimationFrame(rafId);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        document.removeEventListener('visibilitychange', onVisibilityChange);

        for (const source of activeSources) source.stop();
        activeSources.clear();
        rawSamples.length = 0;
        pendingSamples.length = 0;

        void audioCtx.close();
    };

    return { cpu, cgb: cpu.bus.cgb, dispose };
}
