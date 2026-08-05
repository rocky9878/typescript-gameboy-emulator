import { InstructionType, JumpConditions } from "@/types";

export enum ArithmeticTarget {
  A, B, C, D, E, H, L, BC, DE, HL, SP, U8, U16, HLP, BCP, DEP, HLI, HLD
}


export class Instruction {
    kind: InstructionType = 'ADD';
    target;
    loadTarget;

    constructor(kind: InstructionType, target: ArithmeticTarget|JumpConditions, loadTarget: ArithmeticTarget|null = null) {
        this.kind = kind;
        this.target = target;
        this.loadTarget = loadTarget;
    }
}
