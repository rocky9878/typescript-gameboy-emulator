import { overflowingAdd8, overflowingAdd16, overflowingSub8, overflowingSub16 } from "@/lib/utils";
import { JumpConditions, MemoryBus, registers, rom, u16, u8 } from "@/types";
import { createMbc } from "@/types/mbc";
import type { JoypadButton } from "@/types/joypad";
import { Apu } from "@/types/apu";
import { instructionFromByte } from "./opcodes";
import { ArithmeticTarget, Instruction } from "./instruction";

const CPU_SPEED = 4194304;

export class CPU {
    register = new registers;
    bus = new MemoryBus;
    is_halted = false;
    ime = false;
    ime_next = false;
    divClockSum = 0;
    timaClockSum = 0;
    cycleSum = 0;

    async init(romPath: string): Promise<void> {
        await this.bus.init(romPath);
    }

    step() {
        if (this.bus.readByte(u16(0xff02)) == 0x81) {
            let c = this.bus.readByte(u16(0xff01));
            console.log(String.fromCharCode(c));
            this.bus.writeByte(u16(0xff02), u8(0x0));
	    }
        let instruction_byte = this.bus.readByte(this.register.pc);
        let prefixed = instruction_byte == 0xCB;
        if (prefixed) {
            instruction_byte = this.bus.readByte(u16(this.register.pc + 1));
        }
        let instruction = instructionFromByte(instruction_byte, prefixed);
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
                    this.push(this.register.pc);
                    this.handleTimer(20);
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
                        const [newVal, didOverflow] = overflowingAdd16(this.register.sp, signed);
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
                if(instruction.loadTarget === ArithmeticTarget.HLP) {
                    this.handleTimer(12);
                } else this.handleTimer(8);

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
                shouldJump ? this.handleTimer(24) : this.handleTimer(12);
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
                    case ArithmeticTarget.BC: this.checkOamOn16BitOp(this.register.bc()); this.register.setBc(this.dec16(this.register.bc())); break;
                    case ArithmeticTarget.C: this.register.c = this.dec8(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.dec8(this.register.d); break;
                    case ArithmeticTarget.DE: this.checkOamOn16BitOp(this.register.de()); this.register.setDe(this.dec16(this.register.de())); break;
                    case ArithmeticTarget.E: this.register.e = this.dec8(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.dec8(this.register.h); break;
                    case ArithmeticTarget.HL: this.checkOamOn16BitOp(this.register.hl()); this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.dec8(this.bus.readByte(this.register.hl()))); break;
                    case ArithmeticTarget.L: this.register.l = this.dec8(this.register.l); break;
                    case ArithmeticTarget.SP: this.checkOamOn16BitOp(this.register.sp); this.register.sp = this.dec16(this.register.sp); break;
                }
                if(instruction.target === ArithmeticTarget.SP || instruction.target === ArithmeticTarget.HL || instruction.target === ArithmeticTarget.DE || instruction.target === ArithmeticTarget.BC) {
                    this.handleTimer(8);
                } else instruction.target === ArithmeticTarget.HLP ? this.handleTimer(12) : this.handleTimer(4);
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
                    case ArithmeticTarget.BC: this.checkOamOn16BitOp(this.register.bc()); this.register.setBc(this.inc16(this.register.bc())); break;
                    case ArithmeticTarget.C: this.register.c = this.inc8(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.inc8(this.register.d); break;
                    case ArithmeticTarget.DE: this.checkOamOn16BitOp(this.register.de()); this.register.setDe(this.inc16(this.register.de())); break;
                    case ArithmeticTarget.E: this.register.e = this.inc8(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.inc8(this.register.h); break;
                    case ArithmeticTarget.HL: this.checkOamOn16BitOp(this.register.hl()); this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.inc8(this.bus.readByte(this.register.hl()))); break;
                    case ArithmeticTarget.L: this.register.l = this.inc8(this.register.l); break;
                    case ArithmeticTarget.SP: this.checkOamOn16BitOp(this.register.sp); this.register.sp = this.inc16(this.register.sp); break;
                }
                if(instruction.target === ArithmeticTarget.SP || instruction.target === ArithmeticTarget.HL || instruction.target === ArithmeticTarget.DE || instruction.target === ArithmeticTarget.BC) {
                    this.handleTimer(8);
                } else instruction.target === ArithmeticTarget.HLP ? this.handleTimer(12) : this.handleTimer(4);
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
                switch (instruction.loadTarget) {
                    case ArithmeticTarget.A: source_value = this.register.a; break;
                    case ArithmeticTarget.B: source_value = this.register.b; break;
                    case ArithmeticTarget.BCP: source_value = this.bus.readByte(this.register.bc()); break;
                    case ArithmeticTarget.C: source_value = this.register.c; break;
                    case ArithmeticTarget.D: source_value = this.register.d; break;
                    case ArithmeticTarget.DEP: source_value = this.bus.readByte(this.register.de()); break;
                    case ArithmeticTarget.E: source_value = this.register.e; break;
                    case ArithmeticTarget.FFU8P: source_value = this.bus.readByte(u16(0xff << 8 | this.bus.readByte(u16(this.register.pc + 1)))); break;
                    case ArithmeticTarget.FFCP: source_value = this.bus.readByte(u16(0xff << 8 | this.register.c)); break;
                    case ArithmeticTarget.H: source_value = this.register.h; break;
                    case ArithmeticTarget.HL: source_value = this.register.hl(); break;
                    case ArithmeticTarget.HLD: this.checkOamOn16BitOp(this.register.hl(), 'readWrite'); source_value = this.bus.readByte(this.register.hl()); this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.HLI: this.checkOamOn16BitOp(this.register.hl(), 'readWrite'); source_value = this.bus.readByte(this.register.hl()); this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: source_value = this.bus.readByte(this.register.hl()); break;
                    case ArithmeticTarget.L: source_value = this.register.l; break;
                    case ArithmeticTarget.SP: source_value = this.register.sp; break;
                    case ArithmeticTarget.SPI8:
                        let byte = <number>this.bus.readByte(u16(this.register.pc + 1));
                        this.register.f.carry = ((this.register.sp & 0xff) + byte) > 0xff;
                        if (byte > 127) byte -= 256;
                        const [result, didOverflow] = overflowingAdd16(this.register.sp, byte);
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
                    case ArithmeticTarget.FFU8P: this.bus.writeByte(u16(0xff << 8 | this.bus.readByte(u16(this.register.pc + 1))), <u8>source_value); break;
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
                if(instruction.loadTarget === ArithmeticTarget.U16P || instruction.target === ArithmeticTarget.U16) instruction.loadTarget === ArithmeticTarget.SP ? this.handleTimer(20) : this.handleTimer(16);
                else if((instruction.loadTarget === ArithmeticTarget.U16 || instruction.loadTarget === ArithmeticTarget.FFU8P || instruction.target === ArithmeticTarget.FFU8P || instruction.loadTarget === ArithmeticTarget.SPI8) ||
                        (instruction.target === ArithmeticTarget.HLP && instruction.loadTarget === ArithmeticTarget.U8)
                    ) this.handleTimer(12);
                else if(instruction.target === ArithmeticTarget.BCP || instruction.loadTarget === ArithmeticTarget.BCP ||
                        instruction.target === ArithmeticTarget.DEP || instruction.loadTarget === ArithmeticTarget.DEP ||
                        instruction.target === ArithmeticTarget.HLI || instruction.loadTarget === ArithmeticTarget.HLI ||
                        instruction.target === ArithmeticTarget.HLD || instruction.loadTarget === ArithmeticTarget.HLD ||
                        instruction.target === ArithmeticTarget.HLP || instruction.loadTarget === ArithmeticTarget.HLP ||
                        instruction.target === ArithmeticTarget.SP || instruction.loadTarget === ArithmeticTarget.U8 ||
                        instruction.target === ArithmeticTarget.FFCP || instruction.loadTarget === ArithmeticTarget.FFCP
                    ) this.handleTimer(8);
                else this.handleTimer(4);
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
                switch (instruction.target) {
                    case ArithmeticTarget.BC: this.register.setBc(this.pop()); break;
                    case ArithmeticTarget.DE: this.register.setDe(this.pop()); break;
                    case ArithmeticTarget.HL: this.register.setHl(this.pop()); break;
                    case ArithmeticTarget.AF: this.register.setAf(this.pop()); break;
                }
                this.handleTimer(12);
                return u16(this.register.pc + 1);
            }
            case 'PUSH': {
                switch (instruction.target) {
                    case ArithmeticTarget.BC: this.push(this.register.bc()); break;
                    case ArithmeticTarget.DE: this.push(this.register.de()); break;
                    case ArithmeticTarget.HL: this.push(this.register.hl()); break;
                    case ArithmeticTarget.AF: this.push(this.register.af()); break;
                }
                this.handleTimer(16);
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
                if(instruction.target === JumpConditions.Always) this.handleTimer(16);
                else shouldJump ? this.handleTimer(20) : this.handleTimer(8);
                return this.return(shouldJump);
            }
            case 'RETI': {
                this.ime = true;
                this.handleTimer(16);
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
                this.handleTimer(16);
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
        this.bus.ppu.step(tCycle);
        this.bus.apu.step(tCycle);
        this.cycleSum += tCycle;

        // div register/0xff04 increments based on t-cycles
        this.divClockSum += tCycle;
        if(this.divClockSum >= 256) {
            this.divClockSum -= 256;
            this.bus.writeByte(u16(0xff04), u8(this.bus.readByte(u16(0xff04)) + 1));
        }

        const TAC = this.bus.readByte(u16(0xff07));
        // Timer control is TIMA enabled
        if(TAC >> 2 & 1) {
            this.timaClockSum += tCycle;
            let freq = 0;
            switch(TAC & 0b11) {
                case 0: freq = 4096; break;
                case 1: freq = 262144; break;
                case 2: freq = 65536; break;
                case 3: freq = 16384; break;
            }

            while(this.timaClockSum >= (CPU_SPEED / freq)) {
                const [result, didOverflow] = overflowingAdd8(this.bus.readByte(u16(0xff05)), 1);
                if(!didOverflow) this.bus.writeByte(u16(0xff05), result);
                else {
                    this.bus.writeByte(u16(0xff05), this.bus.readByte(u16(0xff06))); // reset timer to TMA
                    this.bus.writeByte(u16(0xff0f), u8(this.bus.readByte(u16(0xff0f)) | 1 << 2)); // set the request timer interrupt flag
                }
                this.timaClockSum -= (CPU_SPEED / freq)
            }
        }
    }

    jump(shouldJump: boolean): u16 {
        if(shouldJump) {
            // Gameboy is little endian so read pc + 2 as most significant bit
            // and pc + 1 as least significant bit
            let least_significant_byte = this.bus.readByte(u16(this.register.pc + 1));
            let most_significant_byte = this.bus.readByte(u16(this.register.pc + 2));
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
        const [newVal, didOverflow] = overflowingAdd8(this.register.a, value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.carry = didOverflow;
        this.register.f.half_carry = (this.register.a & 0xf) + (value & 0xf) > 0xf;

        return newVal;
    }

    add16(value: u16) {
        const [newVal, didOverflow] = overflowingAdd16(this.register.hl(), value);

        this.register.f.subtract = false;
        this.register.f.carry = didOverflow;
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
            if (shouldJump) this.push(u16(this.register.pc + 1));
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
        const [newVal, didOverflow] = overflowingSub8(this.register.a, value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = true;
        this.register.f.carry = didOverflow;
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

    push(value: u16) {
        this.register.sp = u16(this.register.sp - 1);
        this.checkOamOn16BitOp(u16(this.register.sp + 1), 'write'); // decrement's IDU-asserted address
        this.bus.writeByte(this.register.sp, u8((value & 0xFF00) >> 8));

        this.register.sp = u16(this.register.sp - 1);
        this.checkOamOn16BitOp(u16(this.register.sp + 1), 'write');
        this.bus.writeByte(this.register.sp, u8(value));
    }

    pop(): u16 {
        this.checkOamOn16BitOp(this.register.sp, 'read'); // the actual LSB read
        const lsb = this.bus.readByte(this.register.sp);
        this.register.sp = u16(this.register.sp + 1);
        this.checkOamOn16BitOp(this.register.sp, 'write'); // glitched write from the first increment

        this.checkOamOn16BitOp(this.register.sp, 'read'); // the actual MSB read
        const msb = this.bus.readByte(this.register.sp);
        this.register.sp = u16(this.register.sp + 1);
        // Real hardware doesn't glitch-write on the second increment - no check here.

        return u16((msb << 8) | lsb);
    }

    // OAM corruption bug (DMG): a 16-bit register inc/dec/access whose value points into
    // $FE00-$FEFF while the PPU is mid mode-2 OAM scan scrambles whatever OAM row the scan
    // is currently on. `value` is the address as asserted on the bus for this access; `kind`
    // defaults to 'write' since that's what a bare inc/dec's IDU triggers.
    private checkOamOn16BitOp(value: u16, kind: 'write' | 'read' | 'readWrite' = 'write'): void {
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
        const [newVal, didOverflow] = overflowingSub8(this.register.a, value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = true;
        this.register.f.carry = didOverflow;
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


const SHADES: [number, number, number][] = [
    [0x9b, 0xbc, 0x0f], // colorId 0 (lightest)
    [0x8b, 0xac, 0x0f],
    [0x30, 0x62, 0x30],
    [0x0f, 0x38, 0x0f], // colorId 3 (darkest)
];

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

export async function run(canvas?: HTMLCanvasElement) {
    const cpu = new CPU();
    // const response = await fetch('/oam_bug/4-scanline_timing.gb');
    const response = await fetch('/tetris.gb');
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    cpu.bus.rom.memory = bytes; // copies bytes into memory starting at pos 0
    cpu.bus.mbc = createMbc(bytes);

    const audioCtx = new AudioContext();
    cpu.bus.apu = new Apu(audioCtx.sampleRate);
    let nextChunkTime = audioCtx.currentTime;

    window.addEventListener('keydown', (e) => {
        void audioCtx.resume(); // browsers require a user gesture before audio can play
        const button = KEY_TO_BUTTON[e.code];
        if (button) {
            e.preventDefault();
            cpu.bus.joypad.setButton(button, true);
        }
    });
    window.addEventListener('keyup', (e) => {
        const button = KEY_TO_BUTTON[e.code];
        if (button) {
            e.preventDefault();
            cpu.bus.joypad.setButton(button, false);
        }
    });

    const ctx = canvas?.getContext('2d');
    if (ctx) {
        const image = ctx.createImageData(160, 144);
        cpu.bus.ppu.onFrame = () => {
            const framebuffer = cpu.bus.ppu.framebuffer;
            for (let i = 0; i < framebuffer.length; i++) {
                const [r, g, b] = SHADES[framebuffer[i]];
                image.data[i * 4] = r;
                image.data[i * 4 + 1] = g;
                image.data[i * 4 + 2] = b;
                image.data[i * 4 + 3] = 255;
            }
            ctx.putImageData(image, 0, 0);
        };
    }

    // One Game Boy frame = 154 scanlines * 456 dots = 70224 T-cycles.
    // Running exactly that many cycles per requestAnimationFrame callback paces
    // the CPU to the browser's ~60Hz repaint rate, close enough to the real 59.7Hz.
    const CYCLES_PER_FRAME = 70224;

    function tick() {
        const target = cpu.cycleSum + CYCLES_PER_FRAME;
        while (cpu.cycleSum < target) {
            cpu.step();
        }

        const samples = cpu.bus.apu.drainSamples();
        if (samples.length > 0) {
            const frameCount = samples.length / 2;
            const audioBuffer = audioCtx.createBuffer(2, frameCount, audioCtx.sampleRate);
            const left = audioBuffer.getChannelData(0);
            const right = audioBuffer.getChannelData(1);
            for (let i = 0; i < frameCount; i++) {
                left[i] = samples[i * 2];
                right[i] = samples[i * 2 + 1];
            }

            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);
            // Fell behind (e.g. backgrounded tab)? Don't let queued audio pile up and play back-to-back late.
            if (nextChunkTime < audioCtx.currentTime) nextChunkTime = audioCtx.currentTime;
            source.start(nextChunkTime);
            nextChunkTime += audioBuffer.duration;
        }

        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}
