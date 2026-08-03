import { overflowingAdd } from "@/lib/utils";
import { byteFromFlagsRegister, FlagsRegister, InstructionType, registers, u16, u8 } from "@/types";
import { unprefixed } from "./opcodes";

export enum ArithmeticTarget {
  A, B, C, D, E, H, L, HL, U8
}

enum JumpTest {
  NotZero,
  Zero,
  NotCarry,
  Carry,
  Always
}

export class Instruction {
    kind: InstructionType = 'ADD';
    target;
    pointer: boolean = false;

    constructor(kind: InstructionType, target: ArithmeticTarget|JumpTest|u8) {
        this.kind = kind;
        this.target = target;
    }

    static fromByte(byte: u8, prefixed: boolean): Instruction {
        return prefixed ? this.fromByteNotPrefixed(byte) : this.fromBytePrefixed(byte);
    }

    static fromByteNotPrefixed(byte: u8): Instruction {
        return unprefixed[byte];
    }

    static fromBytePrefixed(byte: u8): Instruction {
        switch(byte) {
            case 0x80: return new Instruction('ADD', ArithmeticTarget.B); // TODO wrong
            default: return new Instruction('ADD', ArithmeticTarget.B);
        }
    }
}


class MemoryBus {
    memory: (u8)[] = [];

    readByte(address: u16): u8 {
        return this.memory[address];
    }
}

class CPU {
    register = new registers;
    pc = u16(0);
    bus = new MemoryBus;

    step() {
        let instruction_byte = this.bus.readByte(this.pc);
        let prefixed = instruction_byte == 0xCB;
        if (prefixed) {
            instruction_byte = this.bus.readByte(u16(this.pc + 1));
        }
        let instruction = Instruction.fromByte(instruction_byte, prefixed);

        if(instruction) {
            this.pc = this.execute(instruction);
        } else {
            console.error('Unkown instruction found for: 0x'+instruction_byte);
        }
    }

    execute(instruction: Instruction) {
        switch (instruction.kind) {
            case 'NOP':
                break;
            case 'ADD':
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.add(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.add(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.add(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.add(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.add(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.add(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.add(this.register.l); break;
                    case ArithmeticTarget.HL: this.register.a = this.add(this.bus.readByte(this.register.hl())); break;
                    default:
                        // TODO support more targets i.e. HL,BC. SP,i8. A,u8
                        break;
                }
                break;
            case 'ADC':
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.adc(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.adc(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.adc(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.adc(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.adc(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.adc(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.adc(this.register.l); break;
                    case ArithmeticTarget.HL: this.register.a = this.adc(this.bus.readByte(this.register.hl())); break;
                    default:
                        // TODO support more targets i.e. A,u8
                        break;
                }
                break;
            case 'SUB':
                switch (instruction.target) {
                    case ArithmeticTarget.A: this.register.a = this.sub(this.register.a); break;
                    case ArithmeticTarget.B: this.register.a = this.sub(this.register.b); break;
                    case ArithmeticTarget.C: this.register.a = this.sub(this.register.c); break;
                    case ArithmeticTarget.D: this.register.a = this.sub(this.register.d); break;
                    case ArithmeticTarget.E: this.register.a = this.sub(this.register.e); break;
                    case ArithmeticTarget.H: this.register.a = this.sub(this.register.h); break;
                    case ArithmeticTarget.L: this.register.a = this.sub(this.register.l); break;
                    case ArithmeticTarget.HL: this.register.a = this.sub(this.bus.readByte(this.register.hl())); break;
                    default:
                        // TODO support more targets i.e. A,u8
                        break;
                }
                break;
            case 'JP':
                const jumpConditions: Record<JumpTest, boolean> = {
                    [JumpTest.NotZero]: !this.register.f.zero,
                    [JumpTest.NotCarry]: !this.register.f.carry,
                    [JumpTest.Zero]: this.register.f.zero,
                    [JumpTest.Carry]: this.register.f.carry,
                    [JumpTest.Always]: true,
                };
                const jumpCondition = jumpConditions[<JumpTest>instruction.target];
                this.pc = this.jump(jumpCondition);
                break;
            default:
                // TODO support more instructions
                break;
        }

        this.pc = u16(this.pc + 1);
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
        const [new_val, did_overflow] = overflowingAdd(this.register.a, value);

        this.register.f.zero = new_val == 0;
        this.register.f.subtract = false;
        this.register.f.carry = did_overflow;
        this.register.f.half_carry = (this.register.a & 0xf) + (value & 0xf) > 0xf;

        return new_val;
    }

    adc(value: u8): u8 {
        const [tmp, overflow1] = overflowingAdd(value, u8(this.register.f.carry ? 1 : 0));
        const [new_val, overflow2] = overflowingAdd(this.register.a, tmp);

        this.register.f.zero = new_val == 0;
        this.register.f.subtract = false;
        this.register.f.carry = overflow1 || overflow2;
        this.register.f.half_carry = (this.register.a & 0xf) + (value & 0xf) > 0xf;

        return new_val;
    }

    sub(value: u8): u8 {
        const new_val = u8(this.register.a - value);

        this.register.f.zero = new_val == 0;
        this.register.f.subtract = true;
        this.register.f.carry = new_val < 0;
        this.register.f.half_carry = (this.register.a & 0xf) < (value & 0xf);

        return new_val;
    }
}


export function run() {
    let cpu = new CPU();
}
