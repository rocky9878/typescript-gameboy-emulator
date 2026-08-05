import { JumpConditions, u16, u8 } from "@/types"
import { ArithmeticTarget, Instruction } from "./instruction"

// TODO LD

export const unprefixed: Record<number, Instruction> = {
    0x00: new Instruction('NOP', 0),
    0x01: new Instruction('LD', ArithmeticTarget.BC, ArithmeticTarget.U16),
    0x02: new Instruction('LD', ArithmeticTarget.BCP, ArithmeticTarget.A),
    0x03: new Instruction('INC', ArithmeticTarget.BC),
    0x04: new Instruction('INC', ArithmeticTarget.B),
    0x05: new Instruction('DEC', ArithmeticTarget.B),
    0x06: new Instruction('LD', ArithmeticTarget.B, ArithmeticTarget.U8),
    0x07: new Instruction('RLCA', 0),
    0x08: new Instruction('LD', ArithmeticTarget.U16, ArithmeticTarget.SP),
    0x09: new Instruction('ADD', ArithmeticTarget.HL, ArithmeticTarget.BC),
    0x0A: new Instruction('LD', ArithmeticTarget.A, ArithmeticTarget.BCP),
    0x0B: new Instruction('DEC', ArithmeticTarget.BC),
    0x0C: new Instruction('INC', ArithmeticTarget.C),
    0x0D: new Instruction('DEC', ArithmeticTarget.C),
    0x0E: new Instruction('LD', ArithmeticTarget.C, ArithmeticTarget.U8),
    0x0F: new Instruction('RRCA', 0),

    0x10: new Instruction('NOP', 0), // this is supposed to be STOP but it's supposedly unused by all licensed ROMS
    0x11: new Instruction('LD', ArithmeticTarget.DE, ArithmeticTarget.U16),
    0x12: new Instruction('LD', ArithmeticTarget.DEP, ArithmeticTarget.A),
    0x13: new Instruction('INC', ArithmeticTarget.DE),
    0x14: new Instruction('INC', ArithmeticTarget.D),
    0x15: new Instruction('DEC', ArithmeticTarget.D),
    0x16: new Instruction('LD', ArithmeticTarget.D, ArithmeticTarget.U8),
    0x17: new Instruction('RLA', 0),
    0x18: new Instruction('JR', JumpConditions.Always),
    0x19: new Instruction('ADD', ArithmeticTarget.HL, ArithmeticTarget.DE),
    0x1A: new Instruction('LD', ArithmeticTarget.A, ArithmeticTarget.DEP),
    0x1B: new Instruction('DEC', ArithmeticTarget.DE),
    0x1C: new Instruction('INC', ArithmeticTarget.E),
    0x1D: new Instruction('DEC', ArithmeticTarget.E),
    0x1E: new Instruction('LD', ArithmeticTarget.E, ArithmeticTarget.U8),
    0x1F: new Instruction('RRA', 0),

    0x20: new Instruction('JR', JumpConditions.NotZero),
    0x21: new Instruction('LD', ArithmeticTarget.HL, ArithmeticTarget.U16),
    0x22: new Instruction('LD', ArithmeticTarget.HLI, ArithmeticTarget.A),
    0x23: new Instruction('INC', ArithmeticTarget.HL),
    0x24: new Instruction('INC', ArithmeticTarget.H),
    0x25: new Instruction('DEC', ArithmeticTarget.H),
    0x26: new Instruction('LD', ArithmeticTarget.H, ArithmeticTarget.U8),
    0x27: new Instruction('DAA', 0),
    0x28: new Instruction('JR', JumpConditions.Zero),
    0x29: new Instruction('ADD', ArithmeticTarget.HL, ArithmeticTarget.HL),
    0x2A: new Instruction('LD', ArithmeticTarget.A, ArithmeticTarget.HLI),
    0x2B: new Instruction('DEC', ArithmeticTarget.HL),
    0x2C: new Instruction('INC', ArithmeticTarget.L),
    0x2D: new Instruction('DEC', ArithmeticTarget.L),
    0x2E: new Instruction('LD', ArithmeticTarget.L, ArithmeticTarget.U8),
    0x2F: new Instruction('CPL', 0),

    0x30: new Instruction('JR', JumpConditions.NotCarry),
    0x31: new Instruction('LD', ArithmeticTarget.SP, ArithmeticTarget.U16),
    0x32: new Instruction('LD', ArithmeticTarget.HLD, ArithmeticTarget.A),
    0x33: new Instruction('INC', ArithmeticTarget.SP),
    0x34: new Instruction('INC', ArithmeticTarget.HLP),
    0x35: new Instruction('DEC', ArithmeticTarget.HLP),
    0x36: new Instruction('LD', ArithmeticTarget.HLP, ArithmeticTarget.U8),
    0x37: new Instruction('SCF', 0),
    0x38: new Instruction('JR', JumpConditions.Carry),
    0x39: new Instruction('ADD', ArithmeticTarget.HL, ArithmeticTarget.SP),
    0x3A: new Instruction('LD', ArithmeticTarget.A, ArithmeticTarget.HLD),
    0x3B: new Instruction('DEC', ArithmeticTarget.SP),
    0x3C: new Instruction('INC', ArithmeticTarget.A),
    0x3D: new Instruction('DEC', ArithmeticTarget.A),
    0x3E: new Instruction('LD', ArithmeticTarget.A, ArithmeticTarget.U8),
    0x3F: new Instruction('CCF', 0),
}

export const prefixed: Record<number, Instruction> = {

}

export function instructionFromByte(byte: u8, isPrefixed: boolean): Instruction {
    return isPrefixed ? prefixed[byte] : unprefixed[byte];
}
