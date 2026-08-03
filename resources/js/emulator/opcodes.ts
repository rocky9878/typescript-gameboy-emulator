import { u8 } from "@/types"
import { ArithmeticTarget, Instruction } from "./CPU"

// TODO LD

export const unprefixed: Record<number, Instruction> = {
    0x00: new Instruction('NOP', 0),
    0x80: new Instruction('ADD', ArithmeticTarget.B),
    0x81: new Instruction('ADD', ArithmeticTarget.C),
    0x82: new Instruction('ADD', ArithmeticTarget.D),
    0x83: new Instruction('ADD', ArithmeticTarget.E),
    0x84: new Instruction('ADD', ArithmeticTarget.H),
    0x85: new Instruction('ADD', ArithmeticTarget.L),
    0x86: new Instruction('ADD', ArithmeticTarget.HL),
    0x87: new Instruction('ADD', ArithmeticTarget.A),
    0x88: new Instruction('ADC', ArithmeticTarget.B),
    0x89: new Instruction('ADC', ArithmeticTarget.C),
    0x8A: new Instruction('ADC', ArithmeticTarget.D),
    0x8B: new Instruction('ADC', ArithmeticTarget.E),
    0x8C: new Instruction('ADC', ArithmeticTarget.H),
    0x8D: new Instruction('ADC', ArithmeticTarget.L),
    0x8E: new Instruction('ADC', ArithmeticTarget.HL),
    0x8F: new Instruction('ADC', ArithmeticTarget.A),
    0x90: new Instruction('SUB', ArithmeticTarget.B),
    0x91: new Instruction('SUB', ArithmeticTarget.C),
    0x92: new Instruction('SUB', ArithmeticTarget.D),
    0x93: new Instruction('SUB', ArithmeticTarget.E),
    0x94: new Instruction('SUB', ArithmeticTarget.H),
    0x95: new Instruction('SUB', ArithmeticTarget.L),
    0x96: new Instruction('SUB', ArithmeticTarget.HL),
    0x97: new Instruction('SUB', ArithmeticTarget.A),
}

export const prefixed: Record<number, Instruction> = {

}
