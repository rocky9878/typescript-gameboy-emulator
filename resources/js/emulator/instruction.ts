import { InstructionType, JumpConditions } from "@/types";

export enum ArithmeticTarget {
  A, B, C, D, E, H, L, AF, BC, DE, HL, SP, SPI8, U8, U16, U16P, HLP, BCP, DEP, HLI, HLD, FFCP, FFU8P
}


export class Instruction {
    kind: InstructionType = 'ADD';
    target;
    loadTarget;

    constructor(kind: InstructionType, target: ArithmeticTarget|JumpConditions|number, loadTarget: ArithmeticTarget|null = null) {
        this.kind = kind;
        this.target = target;
        this.loadTarget = loadTarget;
    }
}
