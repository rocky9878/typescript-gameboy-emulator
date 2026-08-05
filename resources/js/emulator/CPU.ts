import { overflowingAdd8, overflowingAdd16, overflowingSub8, overflowingSub16 } from "@/lib/utils";
import { JumpConditions, registers, u16, u8 } from "@/types";
import { instructionFromByte } from "./opcodes";
import { ArithmeticTarget, Instruction } from "./instruction";

class MemoryBus {
    memory: (u8)[] = [];

    readByte(address: u16): u8 {
        return this.memory[address];
    }

    writeByte(address: u16, byte: u8): void {
        this.memory[address] = byte;
    }
}

class CPU {
    register = new registers;
    pc = u16(0);
    sp = u16(0);
    bus = new MemoryBus;

    step() {
        let instruction_byte = this.bus.readByte(this.pc);
        let prefixed = instruction_byte == 0xCB;
        if (prefixed) {
            instruction_byte = this.bus.readByte(u16(this.pc + 1));
        }
        let instruction = instructionFromByte(instruction_byte, prefixed);

        if(instruction) {
            this.pc = this.execute(instruction);
        } else {
            console.error('Unkown instruction found for: 0x'+instruction_byte);
        }
    }

    execute(instruction: Instruction): u16 {
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
                    case ArithmeticTarget.U8: this.register.a = this.adc(this.bus.readByte(u16(this.pc + 1))); return u16(this.pc + 2);
                    default:
                        // TODO support more targets i.e. A,u8
                        break;
                }
                return u16(this.pc + 1);
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
                            case ArithmeticTarget.SP: this.register.setHl(this.add16(this.sp)); break;
                        } break;
                    case ArithmeticTarget.HLP: this.register.a = this.add(this.bus.readByte(this.register.hl())); break;
                    case ArithmeticTarget.U8: this.register.a = this.add(this.bus.readByte(u16(this.pc + 1))); return u16(this.pc + 2);
                    default:
                        // TODO support more targets i.e. HL,BC. SP,i8. A,u8
                        break;
                }
                return u16(this.pc + 1);
            }
            case 'CALL': {
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                return this.call(jumpConditions[<JumpConditions>instruction.target]);
            }
            case 'CCF': {
                this.register.f.carry = !this.register.f.carry;
                this.register.f.half_carry = false;
                this.register.f.subtract = false;
            }
            case 'CPL': {
                this.register.a = u8(~this.register.a);
                this.register.f.subtract = true;
                this.register.f.half_carry = true;
                return u16(this.pc + 1);
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
            }
            case 'DEC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.dec8(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.dec8(this.register.b); break;
                    case ArithmeticTarget.BC: this.register.setBc(this.dec16(this.register.bc())); break;
                    case ArithmeticTarget.C: this.register.c = this.dec8(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.dec8(this.register.d); break;
                    case ArithmeticTarget.DE: this.register.setDe(this.dec16(this.register.de())); break;
                    case ArithmeticTarget.E: this.register.e = this.dec8(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.dec8(this.register.h); break;
                    case ArithmeticTarget.HL: this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.dec8(this.bus.readByte(this.register.hl()))); break;
                    case ArithmeticTarget.L: this.register.l = this.dec8(this.register.l); break;
                    case ArithmeticTarget.SP: this.sp = this.dec16(this.sp); break;
                    default: break;
                }
                return u16(this.pc + 1);
            }
            case 'INC': {
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.inc8(this.register.a); break;
                    case ArithmeticTarget.B: this.register.b = this.inc8(this.register.b); break;
                    case ArithmeticTarget.BC: this.register.setBc(this.inc16(this.register.bc())); break;
                    case ArithmeticTarget.C: this.register.c = this.inc8(this.register.c); break;
                    case ArithmeticTarget.D: this.register.d = this.inc8(this.register.d); break;
                    case ArithmeticTarget.DE: this.register.setDe(this.inc16(this.register.de())); break;
                    case ArithmeticTarget.E: this.register.e = this.inc8(this.register.e); break;
                    case ArithmeticTarget.H: this.register.h = this.inc8(this.register.h); break;
                    case ArithmeticTarget.HL: this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), this.inc8(this.bus.readByte(this.register.hl()))); break;
                    case ArithmeticTarget.L: this.register.l = this.inc8(this.register.l); break;
                    case ArithmeticTarget.SP: this.sp = this.inc16(this.sp); break;
                    default: break;
                }
                return u16(this.pc + 1);
            }
            case 'JP': {
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                return this.jump(jumpConditions[<JumpConditions>instruction.target]);
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
                    let byte = <number>this.bus.readByte(u16(this.pc + 1));
                    if (byte > 127) byte -= 256;
                    return u16(this.pc + 2 + byte);
                }
                return u16(this.pc + 2);
            }
            case 'LD': {
                let source_value: u8|u16 = u8(0);
                switch (instruction.loadTarget) {
                    case ArithmeticTarget.A: source_value = this.register.a; break;
                    case ArithmeticTarget.BCP: source_value = this.bus.readByte(this.register.bc()); break;
                    case ArithmeticTarget.DEP: source_value = this.bus.readByte(this.register.de()); break;
                    case ArithmeticTarget.HLI: source_value = this.bus.readByte(this.register.hl()); this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLD: source_value = this.bus.readByte(this.register.hl()); this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.SP: source_value = this.sp; break;
                    case ArithmeticTarget.U8: source_value = this.bus.readByte(u16(this.pc + 1)); break;
                    case ArithmeticTarget.U16: source_value = u16((this.bus.readByte(u16(this.pc + 2)) << 8) | this.bus.readByte(u16(this.pc + 1))); break;
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
                    case ArithmeticTarget.H: this.register.h = <u8>source_value; break;
                    case ArithmeticTarget.HL: this.register.setHl(<u16>source_value); break;
                    case ArithmeticTarget.HLD: this.bus.writeByte(this.register.hl(), <u8>source_value); this.register.setHl(this.dec16(this.register.hl())); break;
                    case ArithmeticTarget.HLI: this.bus.writeByte(this.register.hl(), <u8>source_value); this.register.setHl(this.inc16(this.register.hl())); break;
                    case ArithmeticTarget.HLP: this.bus.writeByte(this.register.hl(), <u8>source_value); break;
                    case ArithmeticTarget.L: this.register.l = <u8>source_value; break;
                    case ArithmeticTarget.SP: this.sp = <u16>source_value; break;
                    case ArithmeticTarget.U16:
                        const addr = u16(this.bus.readByte(u16(this.pc + 2)) << 8 | this.bus.readByte(u16(this.pc + 1)));
                        if(instruction.loadTarget === ArithmeticTarget.SP) {
                            this.bus.writeByte(addr, u8(source_value & 0xff));
                            this.bus.writeByte(u16(addr + 1), u8(source_value >> 8));
                        } else {
                            this.bus.writeByte(addr, <u8>source_value);
                        }
                        break;
                }
                if (instruction.loadTarget === ArithmeticTarget.U16 || instruction.target === ArithmeticTarget.U16) {
                    return u16(this.pc + 3);
                }
                if (instruction.loadTarget === ArithmeticTarget.U8) {
                    return u16(this.pc + 2);
                }
                return u16(this.pc + 1);
            }
            case 'NOP': {
                return u16(this.pc + 1);
            }
            case 'RET': {
                const jumpConditions: Record<JumpConditions, boolean> = {
                    [JumpConditions.NotZero]: !this.register.f.zero,
                    [JumpConditions.NotCarry]: !this.register.f.carry,
                    [JumpConditions.Zero]: this.register.f.zero,
                    [JumpConditions.Carry]: this.register.f.carry,
                    [JumpConditions.Always]: true,
                };
                return this.return(jumpConditions[<JumpConditions>instruction.target]);
            }
            case 'RLA': {
                const shifted = (this.register.a << 1 & 0xff);
                const carry = this.register.a >> 7 & 0b1;

                // b0 = original carry
                this.register.a = u8(this.register.f.carry ? shifted | (0b00000001) : shifted & ~(0b00000001));
                // carry = original b7
                this.register.f.carry = carry ? true : false;

                this.register.f.half_carry = false;
                this.register.f.zero = false;
                this.register.f.subtract = false;

                return u16(this.pc + 1);
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

                return u16(this.pc + 1);
            }
            case 'RRA': {
                const shifted = (this.register.a >> 1 & 0xff);
                const carry = this.register.a & 0b1;

                // b7 = original carry
                this.register.a = u8(this.register.f.carry ? shifted | (0b10000000) : shifted & ~(0b10000000));
                // carry = original b0
                this.register.f.carry = carry ? true : false;

                this.register.f.half_carry = false;
                this.register.f.zero = false;
                this.register.f.subtract = false;

                return u16(this.pc + 1);
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

                return u16(this.pc + 1);
            }
            case 'SCF': {
                this.register.f.carry = true;
                this.register.f.half_carry = false;
                this.register.f.subtract = false;
                return u16(this.pc + 1);
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
                    case ArithmeticTarget.U8: this.register.a = this.sub(this.bus.readByte(u16(this.pc + 1))); return u16(this.pc + 2);
                }
                return u16(this.pc + 1);
            }
            default: {
                // TODO support more instructions
                break;
            }
        }

        return this.pc
    }

    jump(shouldJump: boolean): u16 {
        if(shouldJump) {
            // Gameboy is little endian so read pc + 2 as most significant bit
            // and pc + 1 as least significant bit
            let least_significant_byte = this.bus.readByte(u16(this.pc + 1));
            let most_significant_byte = this.bus.readByte(u16(this.pc + 2));
            return u16((most_significant_byte << 8) | least_significant_byte)
        } else {
            // If we don't jump we need to still move the program
            // counter forward by 3 since the jump instruction is
            // 3 bytes wide (1 byte for tag and 2 bytes for jump address)
            return u16(this.pc + 3);
        }
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

    adc(value: u8): u8 {
        const [tmp, overflow1] = overflowingAdd8(value, this.register.f.carry ? 1 : 0);
        const [newVal, overflow2] = overflowingAdd8(this.register.a, tmp);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = false;
        this.register.f.carry = overflow1 || overflow2;
        this.register.f.half_carry = (this.register.a & 0xf) + (value & 0xf) > 0xf;

        return newVal;
    }

    sub(value: u8): u8 {
        const [newVal, didOverflow] = overflowingSub8(this.register.a, value);

        this.register.f.zero = newVal == 0;
        this.register.f.subtract = true;
        this.register.f.carry = didOverflow;
        this.register.f.half_carry = (this.register.a & 0xf) < (value & 0xf);

        return newVal;
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

    push(value: u16) {
        this.sp = u16(this.sp - 1);
        this.bus.writeByte(this.sp, u8((value & 0xFF00) >> 8));

        this.sp = u16(this.sp - 1);
        this.bus.writeByte(this.sp, u8(value));
    }

    pop(): u16 {
        const lsb = this.bus.readByte(this.sp);
        this.sp = u16(this.sp + 1);

        const msb = this.bus.readByte(this.sp);
        this.sp = u16(this.sp + 1);

        return u16((msb << 8) | lsb);
    }

    call(shouldJump: boolean): u16 {
        const nextPc = u16(this.pc + 3);
        if(shouldJump) {
            this.push(nextPc);
            return u16(this.bus.readByte(u16(this.pc + 2)) << 8 | this.bus.readByte(u16(this.pc + 1)));
        } else {
            return nextPc;
        }
    }

    return(shouldJump: boolean): u16 {
        if(shouldJump) {
            return this.pop();
        } else {
            return u16(this.pc + 1);
        }
    }
}


export function run() {
    let cpu = new CPU();
    cpu.register.a = u8(0b00101011);
    cpu.execute(new Instruction('RRCA', 0));
    console.log(cpu.register.f);

}
