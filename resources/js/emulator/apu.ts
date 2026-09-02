const CPU_SPEED = 4194304;

// Square wave duty patterns: 1 = high, 0 = low, read left-to-right as the wave
// advances through its 8 steps.
const DUTY_TABLE: number[][] = [
    [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
    [1, 0, 0, 0, 0, 0, 0, 1], // 25%
    [1, 0, 0, 0, 0, 1, 1, 1], // 50%
    [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];

const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

interface Triggerable {
    enabled: boolean;
    length: LengthCounter;
    trigger(): void;
}

interface LengthCounterState {
    value: number;
    enabled: boolean;
}

class LengthCounter {
    value = 0;
    enabled = false;

    // `initial` is the raw value loaded into the register's length field (0 to max-1);
    // hardware counts down from (max - initial), not from initial itself.
    load(max: number, initial: number): void {
        this.value = max - initial;
    }

    // Clocked at 256Hz by the frame sequencer. Returns true if the channel should stop.
    tick(): boolean {
        if (!this.enabled || this.value === 0) return false;
        this.value--;
        return this.value === 0;
    }

    getState(): LengthCounterState {
        return { value: this.value, enabled: this.enabled };
    }

    setState(state: LengthCounterState): void {
        this.value = state.value;
        this.enabled = state.enabled;
    }
}

interface VolumeEnvelopeState {
    initialVolume: number;
    increasing: boolean;
    period: number;
    volume: number;
    timer: number;
}

class VolumeEnvelope {
    initialVolume = 0;
    increasing = false;
    period = 0;
    volume = 0;
    private timer = 0;

    trigger(): void {
        this.volume = this.initialVolume;
        this.timer = this.period;
    }

    // Clocked at 64Hz by the frame sequencer.
    tick(): void {
        if (this.period === 0) return;
        if (this.timer > 0) this.timer--;
        if (this.timer === 0) {
            this.timer = this.period;
            if (this.increasing && this.volume < 15) this.volume++;
            else if (!this.increasing && this.volume > 0) this.volume--;
        }
    }

    getState(): VolumeEnvelopeState {
        return {
            initialVolume: this.initialVolume,
            increasing: this.increasing,
            period: this.period,
            volume: this.volume,
            timer: this.timer,
        };
    }

    setState(state: VolumeEnvelopeState): void {
        this.initialVolume = state.initialVolume;
        this.increasing = state.increasing;
        this.period = state.period;
        this.volume = state.volume;
        this.timer = state.timer;
    }
}

interface PulseChannelState {
    enabled: boolean;
    dacEnabled: boolean;
    duty: number;
    dutyStep: number;
    frequency: number;
    freqTimer: number;
    length: LengthCounterState;
    envelope: VolumeEnvelopeState;
    sweepPeriod: number;
    sweepIncreasing: boolean;
    sweepShift: number;
    sweepTimer: number;
    sweepEnabled: boolean;
    shadowFrequency: number;
    sweepNegateUsed: boolean;
}

// Channels 1 and 2: a duty-cycle square wave, with an optional frequency sweep on channel 1.
class PulseChannel {
    enabled = false;
    dacEnabled = false;
    hasSweep: boolean;

    duty = 0;
    dutyStep = 0;
    frequency = 0;
    freqTimer = 0;

    length = new LengthCounter();
    envelope = new VolumeEnvelope();

    // Sweep (channel 1 only)
    sweepPeriod = 0;
    sweepIncreasing = false; // register bit: 0 = increase frequency, 1 = decrease
    sweepShift = 0;
    private sweepTimer = 0;
    private sweepEnabled = false;
    private shadowFrequency = 0;
    // Tracks whether a sweep calculation has run in negate mode since the last trigger.
    // Hardware quirk: clearing the negate bit afterward immediately disables the channel.
    sweepNegateUsed = false;

    constructor(hasSweep: boolean) {
        this.hasSweep = hasSweep;
    }

    private periodFor(freq: number): number {
        return (2048 - freq) * 4;
    }

    trigger(): void {
        this.enabled = this.dacEnabled;
        this.freqTimer = this.periodFor(this.frequency);
        this.envelope.trigger();
        if (this.length.value === 0) this.length.load(64, 0);

        if (this.hasSweep) {
            this.shadowFrequency = this.frequency;
            this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
            this.sweepEnabled = this.sweepPeriod > 0 || this.sweepShift > 0;
            this.sweepNegateUsed = false;
            if (this.sweepShift > 0) this.sweepCalculate();
        }
    }

    private sweepCalculate(): number {
        if (this.sweepIncreasing) this.sweepNegateUsed = true;
        const delta = this.shadowFrequency >> this.sweepShift;
        const newFreq = this.sweepIncreasing ? this.shadowFrequency - delta : this.shadowFrequency + delta;
        if (newFreq > 2047) this.enabled = false;
        return newFreq;
    }

    // Hardware quirk: clearing the sweep negate bit after a negate-mode calculation has
    // run since the last trigger immediately disables the channel.
    writeSweepControl(period: number, negate: boolean, shift: number): void {
        if (this.sweepIncreasing && !negate && this.sweepNegateUsed) this.enabled = false;
        this.sweepPeriod = period;
        this.sweepIncreasing = negate;
        this.sweepShift = shift;
    }

    tickSweep(): void {
        if (!this.hasSweep || !this.sweepEnabled) return;
        if (this.sweepTimer > 0) this.sweepTimer--;
        if (this.sweepTimer === 0) {
            this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
            if (this.sweepPeriod > 0) {
                const newFreq = this.sweepCalculate();
                if (newFreq <= 2047 && this.sweepShift > 0) {
                    this.shadowFrequency = newFreq;
                    this.frequency = newFreq;
                    this.sweepCalculate(); // overflow check runs again on real hardware
                }
            }
        }
    }

    tickLength(): void {
        if (this.length.tick()) this.enabled = false;
    }

    tickEnvelope(): void {
        this.envelope.tick();
    }

    step(cycles: number): void {
        this.freqTimer -= cycles;
        while (this.freqTimer <= 0) {
            const period = this.periodFor(this.frequency);
            this.freqTimer += period > 0 ? period : 8192;
            this.dutyStep = (this.dutyStep + 1) & 7;
        }
    }

    // Centered analog output in [-1, 1]; exactly 0 when the channel isn't contributing at all.
    sample(): number {
        if (!this.enabled || !this.dacEnabled) return 0;
        const bit = DUTY_TABLE[this.duty][this.dutyStep];
        const dac = bit * this.envelope.volume; // 0-15
        return dac / 7.5 - 1;
    }

    getState(): PulseChannelState {
        return {
            enabled: this.enabled,
            dacEnabled: this.dacEnabled,
            duty: this.duty,
            dutyStep: this.dutyStep,
            frequency: this.frequency,
            freqTimer: this.freqTimer,
            length: this.length.getState(),
            envelope: this.envelope.getState(),
            sweepPeriod: this.sweepPeriod,
            sweepIncreasing: this.sweepIncreasing,
            sweepShift: this.sweepShift,
            sweepTimer: this.sweepTimer,
            sweepEnabled: this.sweepEnabled,
            shadowFrequency: this.shadowFrequency,
            sweepNegateUsed: this.sweepNegateUsed,
        };
    }

    setState(state: PulseChannelState): void {
        this.enabled = state.enabled;
        this.dacEnabled = state.dacEnabled;
        this.duty = state.duty;
        this.dutyStep = state.dutyStep;
        this.frequency = state.frequency;
        this.freqTimer = state.freqTimer;
        this.length.setState(state.length);
        this.envelope.setState(state.envelope);
        this.sweepPeriod = state.sweepPeriod;
        this.sweepIncreasing = state.sweepIncreasing;
        this.sweepShift = state.sweepShift;
        this.sweepTimer = state.sweepTimer;
        this.sweepEnabled = state.sweepEnabled;
        this.shadowFrequency = state.shadowFrequency;
        this.sweepNegateUsed = state.sweepNegateUsed;
    }
}

interface WaveChannelState {
    enabled: boolean;
    dacEnabled: boolean;
    frequency: number;
    freqTimer: number;
    position: number;
    volumeShift: number;
    length: LengthCounterState;
    wave: number[];
}

// Channel 3: plays back 32 4-bit samples from wave RAM.
class WaveChannel {
    enabled = false;
    dacEnabled = false;

    frequency = 0;
    freqTimer = 0;
    position = 0;
    volumeShift = 4; // 4 = mute, 0 = 100%, 1 = 50%, 2 = 25%

    length = new LengthCounter();
    wave = new Uint8Array(16);

    private periodFor(freq: number): number {
        return (2048 - freq) * 2;
    }

    trigger(): void {
        this.enabled = this.dacEnabled;
        this.freqTimer = this.periodFor(this.frequency);
        this.position = 0;
        if (this.length.value === 0) this.length.load(256, 0);
    }

    tickLength(): void {
        if (this.length.tick()) this.enabled = false;
    }

    step(cycles: number): void {
        this.freqTimer -= cycles;
        while (this.freqTimer <= 0) {
            const period = this.periodFor(this.frequency);
            this.freqTimer += period > 0 ? period : 4096;
            this.position = (this.position + 1) & 31;
        }
    }

    // Centered analog output in [-1, 1]; exactly 0 when the channel isn't contributing at all.
    sample(): number {
        if (!this.enabled || !this.dacEnabled || this.volumeShift === 4) return 0;
        const byte = this.wave[this.position >> 1];
        const nibble = (this.position & 1) === 0 ? (byte >> 4) : (byte & 0xf);
        const dac = nibble >> this.volumeShift; // 0-15
        return dac / 7.5 - 1;
    }

    getState(): WaveChannelState {
        return {
            enabled: this.enabled,
            dacEnabled: this.dacEnabled,
            frequency: this.frequency,
            freqTimer: this.freqTimer,
            position: this.position,
            volumeShift: this.volumeShift,
            length: this.length.getState(),
            wave: Array.from(this.wave),
        };
    }

    setState(state: WaveChannelState): void {
        this.enabled = state.enabled;
        this.dacEnabled = state.dacEnabled;
        this.frequency = state.frequency;
        this.freqTimer = state.freqTimer;
        this.position = state.position;
        this.volumeShift = state.volumeShift;
        this.length.setState(state.length);
        this.wave.set(state.wave);
    }
}

interface NoiseChannelState {
    enabled: boolean;
    dacEnabled: boolean;
    clockShift: number;
    divisorCode: number;
    widthMode7bit: boolean;
    freqTimer: number;
    lfsr: number;
    length: LengthCounterState;
    envelope: VolumeEnvelopeState;
}

// Channel 4: pseudo-random noise via a linear-feedback shift register.
class NoiseChannel {
    enabled = false;
    dacEnabled = false;

    clockShift = 0;
    divisorCode = 0;
    widthMode7bit = false;
    freqTimer = 8;
    lfsr = 0x7fff;

    length = new LengthCounter();
    envelope = new VolumeEnvelope();

    private period(): number {
        return NOISE_DIVISORS[this.divisorCode] << this.clockShift;
    }

    trigger(): void {
        this.enabled = this.dacEnabled;
        this.freqTimer = this.period();
        this.lfsr = 0x7fff;
        this.envelope.trigger();
        if (this.length.value === 0) this.length.load(64, 0);
    }

    tickLength(): void {
        if (this.length.tick()) this.enabled = false;
    }

    tickEnvelope(): void {
        this.envelope.tick();
    }

    step(cycles: number): void {
        this.freqTimer -= cycles;
        while (this.freqTimer <= 0) {
            this.freqTimer += this.period();
            const xorBit = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
            this.lfsr >>= 1;
            this.lfsr |= xorBit << 14;
            if (this.widthMode7bit) {
                this.lfsr = (this.lfsr & ~(1 << 6)) | (xorBit << 6);
            }
        }
    }

    // Centered analog output in [-1, 1]; exactly 0 when the channel isn't contributing at all.
    sample(): number {
        if (!this.enabled || !this.dacEnabled) return 0;
        const bit = (this.lfsr & 1) === 0 ? 1 : 0;
        const dac = bit * this.envelope.volume; // 0-15
        return dac / 7.5 - 1;
    }

    getState(): NoiseChannelState {
        return {
            enabled: this.enabled,
            dacEnabled: this.dacEnabled,
            clockShift: this.clockShift,
            divisorCode: this.divisorCode,
            widthMode7bit: this.widthMode7bit,
            freqTimer: this.freqTimer,
            lfsr: this.lfsr,
            length: this.length.getState(),
            envelope: this.envelope.getState(),
        };
    }

    setState(state: NoiseChannelState): void {
        this.enabled = state.enabled;
        this.dacEnabled = state.dacEnabled;
        this.clockShift = state.clockShift;
        this.divisorCode = state.divisorCode;
        this.widthMode7bit = state.widthMode7bit;
        this.freqTimer = state.freqTimer;
        this.lfsr = state.lfsr;
        this.length.setState(state.length);
        this.envelope.setState(state.envelope);
    }
}

export interface ApuState {
    ch1: PulseChannelState;
    ch2: PulseChannelState;
    ch3: WaveChannelState;
    ch4: NoiseChannelState;
    powerOn: boolean;
    leftVolume: number;
    rightVolume: number;
    vinBits: number;
    panning: number;
    frameSeqCounter: number;
    frameSeqStep: number;
    sampleCycleAcc: number;
}

export class Apu {
    private ch1 = new PulseChannel(true);
    private ch2 = new PulseChannel(false);
    private ch3 = new WaveChannel();
    private ch4 = new NoiseChannel();

    private powerOn = true;
    private leftVolume = 7;
    private rightVolume = 7;
    private vinBits = 0; // NR50 bits 3 and 7 (VIN enable) aren't wired to anything audible, but must still round-trip on read
    private panning = 0xff; // NR51: which channels feed left/right

    private frameSeqCounter = 0;
    private frameSeqStep = 0;

    private sampleCycleAcc = 0;
    private cyclesPerSample: number;
    private sampleRate: number;

    // Interleaved stereo float samples in [-1, 1], drained by the audio backend.
    sampleBuffer: number[] = [];

    constructor(sampleRate: number = 44100) {
        this.sampleRate = sampleRate;
        this.cyclesPerSample = CPU_SPEED / sampleRate;
    }

    setSpeed(speed: number): void {
        this.cyclesPerSample = (CPU_SPEED * speed) / this.sampleRate;
    }

    // Length is clocked on even frame-sequencer steps (256Hz out of the 512Hz sequencer).
    private frameSeqWillClockLength(): boolean {
        return this.frameSeqStep % 2 === 0;
    }

    // Obscure hardware quirk: if the length counter is (or becomes) enabled at a moment
    // when the frame sequencer's next tick would NOT clock it, it gets clocked once anyway,
    // right now. If that immediate clock brings it to 0, the channel is disabled.
    private extraClockLength(channel: Triggerable): void {
        if (!channel.length.enabled || channel.length.value === 0 || this.frameSeqWillClockLength()) return;
        channel.length.value--;
        if (channel.length.value === 0) channel.enabled = false;
    }

    // Shared NRx4 (frequency-hi/trigger/length-enable) write handling for all four channels.
    private writeNRx4(channel: Triggerable, value: number): void {
        const triggering = (value & 0x80) !== 0;
        const wasEnabled = channel.length.enabled;
        channel.length.enabled = (value & 0x40) !== 0;

        if (!wasEnabled && channel.length.enabled) this.extraClockLength(channel);

        const lengthWasZero = channel.length.value === 0;
        if (triggering) {
            channel.trigger(); // reloads length to max if it was 0
            if (lengthWasZero) this.extraClockLength(channel);
        }
    }

    step(cycles: number): void {
        // The frame sequencer is clocked by DIV, which keeps running even while the APU is
        // powered off - so this counter must too, or the phase drifts on the next power-on.
        this.frameSeqCounter += cycles;
        while (this.frameSeqCounter >= 8192) {
            this.frameSeqCounter -= 8192;
            if (this.powerOn) this.tickFrameSequencer();
        }

        if (!this.powerOn) return;

        this.ch1.step(cycles);
        this.ch2.step(cycles);
        this.ch3.step(cycles);
        this.ch4.step(cycles);

        this.sampleCycleAcc += cycles;
        while (this.sampleCycleAcc >= this.cyclesPerSample) {
            this.sampleCycleAcc -= this.cyclesPerSample;
            this.pushSample();
        }
    }

    private tickFrameSequencer(): void {
        // 512Hz sequencer: length @256Hz (steps 0,2,4,6), sweep @128Hz (steps 2,6), envelope @64Hz (step 7).
        if (this.frameSeqStep % 2 === 0) {
            this.ch1.tickLength();
            this.ch2.tickLength();
            this.ch3.tickLength();
            this.ch4.tickLength();
        }
        if (this.frameSeqStep === 2 || this.frameSeqStep === 6) {
            this.ch1.tickSweep();
        }
        if (this.frameSeqStep === 7) {
            this.ch1.tickEnvelope();
            this.ch2.tickEnvelope();
            this.ch4.tickEnvelope();
        }
        this.frameSeqStep = (this.frameSeqStep + 1) & 7;
    }

    private pushSample(): void {
        const s1 = this.ch1.sample();
        const s2 = this.ch2.sample();
        const s3 = this.ch3.sample();
        const s4 = this.ch4.sample();

        let left = 0;
        let right = 0;
        if (this.panning & 0x10) left += s1;
        if (this.panning & 0x20) left += s2;
        if (this.panning & 0x40) left += s3;
        if (this.panning & 0x80) left += s4;
        if (this.panning & 0x01) right += s1;
        if (this.panning & 0x02) right += s2;
        if (this.panning & 0x04) right += s3;
        if (this.panning & 0x08) right += s4;

        // Each channel already contributes a centered [-1, 1] value (or exactly 0 if it isn't
        // playing); average the up-to-4 channels back into [-1, 1], then apply master volume (0-7 -> 1/8-8/8).
        const leftOut = (left / 4) * ((this.leftVolume + 1) / 8);
        const rightOut = (right / 4) * ((this.rightVolume + 1) / 8);

        this.sampleBuffer.push(leftOut, rightOut);
    }

    // Drains and returns all samples accumulated since the last call.
    drainSamples(): number[] {
        const samples = this.sampleBuffer;
        this.sampleBuffer = [];
        return samples;
    }

    // cyclesPerSample (derived from the AudioContext's sample rate at construction) and
    // sampleBuffer (audio queued but not yet drained/played) are intentionally excluded -
    // both are runtime playback plumbing, not emulated hardware state.
    getState(): ApuState {
        return {
            ch1: this.ch1.getState(),
            ch2: this.ch2.getState(),
            ch3: this.ch3.getState(),
            ch4: this.ch4.getState(),
            powerOn: this.powerOn,
            leftVolume: this.leftVolume,
            rightVolume: this.rightVolume,
            vinBits: this.vinBits,
            panning: this.panning,
            frameSeqCounter: this.frameSeqCounter,
            frameSeqStep: this.frameSeqStep,
            sampleCycleAcc: this.sampleCycleAcc,
        };
    }

    setState(state: ApuState): void {
        this.ch1.setState(state.ch1);
        this.ch2.setState(state.ch2);
        this.ch3.setState(state.ch3);
        this.ch4.setState(state.ch4);
        this.powerOn = state.powerOn;
        this.leftVolume = state.leftVolume;
        this.rightVolume = state.rightVolume;
        this.vinBits = state.vinBits;
        this.panning = state.panning;
        this.frameSeqCounter = state.frameSeqCounter;
        this.frameSeqStep = state.frameSeqStep;
        this.sampleCycleAcc = state.sampleCycleAcc;
    }

    readRegister(address: number): number {
        switch (address) {
            case 0xff10: return 0x80 | (this.ch1.sweepPeriod << 4) | (this.ch1.sweepIncreasing ? 0x08 : 0) | this.ch1.sweepShift;
            case 0xff11: return (this.ch1.duty << 6) | 0x3f;
            case 0xff12: return (this.ch1.envelope.initialVolume << 4) | (this.ch1.envelope.increasing ? 0x08 : 0) | this.ch1.envelope.period;
            case 0xff13: return 0xff;
            case 0xff14: return 0xbf | (this.ch1.length.enabled ? 0x40 : 0);

            case 0xff16: return (this.ch2.duty << 6) | 0x3f;
            case 0xff17: return (this.ch2.envelope.initialVolume << 4) | (this.ch2.envelope.increasing ? 0x08 : 0) | this.ch2.envelope.period;
            case 0xff18: return 0xff;
            case 0xff19: return 0xbf | (this.ch2.length.enabled ? 0x40 : 0);

            case 0xff1a: return this.ch3.dacEnabled ? 0xff : 0x7f;
            case 0xff1b: return 0xff;
            case 0xff1c: return 0x9f | (this.ch3.volumeShift === 4 ? 0 : ((this.ch3.volumeShift === 0 ? 1 : this.ch3.volumeShift) << 5));
            case 0xff1d: return 0xff;
            case 0xff1e: return 0xbf | (this.ch3.length.enabled ? 0x40 : 0);

            case 0xff20: return 0xff;
            case 0xff21: return (this.ch4.envelope.initialVolume << 4) | (this.ch4.envelope.increasing ? 0x08 : 0) | this.ch4.envelope.period;
            case 0xff22: return (this.ch4.clockShift << 4) | (this.ch4.widthMode7bit ? 0x08 : 0) | this.ch4.divisorCode;
            case 0xff23: return 0xbf | (this.ch4.length.enabled ? 0x40 : 0);

            case 0xff24: return this.vinBits | (this.leftVolume << 4) | this.rightVolume;
            case 0xff25: return this.panning;
            case 0xff26:
                return (this.powerOn ? 0x80 : 0) | 0x70
                    | (this.ch1.enabled ? 0x01 : 0)
                    | (this.ch2.enabled ? 0x02 : 0)
                    | (this.ch3.enabled ? 0x04 : 0)
                    | (this.ch4.enabled ? 0x08 : 0);
        }
        if (address >= 0xff30 && address <= 0xff3f) {
            // While channel 3 is playing, any wave RAM address reads the byte it's
            // currently sampling instead of the addressed byte.
            const index = this.ch3.enabled ? this.ch3.position >> 1 : address - 0xff30;
            return this.ch3.wave[index];
        }
        return 0xff;
    }

    writeRegister(address: number, value: number): void {
        if (!this.powerOn && address !== 0xff26 && !(address >= 0xff30 && address <= 0xff3f)) return;

        switch (address) {
            case 0xff10:
                this.ch1.writeSweepControl((value >> 4) & 0x07, (value & 0x08) !== 0, value & 0x07);
                break;
            case 0xff11:
                this.ch1.duty = (value >> 6) & 0x03;
                this.ch1.length.load(64, value & 0x3f);
                break;
            case 0xff12:
                this.ch1.envelope.initialVolume = (value >> 4) & 0x0f;
                this.ch1.envelope.increasing = (value & 0x08) !== 0;
                this.ch1.envelope.period = value & 0x07;
                this.ch1.dacEnabled = (value & 0xf8) !== 0;
                if (!this.ch1.dacEnabled) this.ch1.enabled = false;
                break;
            case 0xff13:
                this.ch1.frequency = (this.ch1.frequency & 0x700) | value;
                break;
            case 0xff14:
                this.ch1.frequency = (this.ch1.frequency & 0xff) | ((value & 0x07) << 8);
                this.writeNRx4(this.ch1, value);
                break;

            case 0xff16:
                this.ch2.duty = (value >> 6) & 0x03;
                this.ch2.length.load(64, value & 0x3f);
                break;
            case 0xff17:
                this.ch2.envelope.initialVolume = (value >> 4) & 0x0f;
                this.ch2.envelope.increasing = (value & 0x08) !== 0;
                this.ch2.envelope.period = value & 0x07;
                this.ch2.dacEnabled = (value & 0xf8) !== 0;
                if (!this.ch2.dacEnabled) this.ch2.enabled = false;
                break;
            case 0xff18:
                this.ch2.frequency = (this.ch2.frequency & 0x700) | value;
                break;
            case 0xff19:
                this.ch2.frequency = (this.ch2.frequency & 0xff) | ((value & 0x07) << 8);
                this.writeNRx4(this.ch2, value);
                break;

            case 0xff1a:
                this.ch3.dacEnabled = (value & 0x80) !== 0;
                if (!this.ch3.dacEnabled) this.ch3.enabled = false;
                break;
            case 0xff1b:
                this.ch3.length.load(256, value);
                break;
            case 0xff1c: {
                const code = (value >> 5) & 0x03;
                this.ch3.volumeShift = code === 0 ? 4 : (code === 1 ? 0 : code);
                break;
            }
            case 0xff1d:
                this.ch3.frequency = (this.ch3.frequency & 0x700) | value;
                break;
            case 0xff1e:
                this.ch3.frequency = (this.ch3.frequency & 0xff) | ((value & 0x07) << 8);
                this.writeNRx4(this.ch3, value);
                break;

            case 0xff20:
                this.ch4.length.load(64, value & 0x3f);
                break;
            case 0xff21:
                this.ch4.envelope.initialVolume = (value >> 4) & 0x0f;
                this.ch4.envelope.increasing = (value & 0x08) !== 0;
                this.ch4.envelope.period = value & 0x07;
                this.ch4.dacEnabled = (value & 0xf8) !== 0;
                if (!this.ch4.dacEnabled) this.ch4.enabled = false;
                break;
            case 0xff22:
                this.ch4.clockShift = (value >> 4) & 0x0f;
                this.ch4.widthMode7bit = (value & 0x08) !== 0;
                this.ch4.divisorCode = value & 0x07;
                break;
            case 0xff23:
                this.writeNRx4(this.ch4, value);
                break;

            case 0xff24:
                this.leftVolume = (value >> 4) & 0x07;
                this.rightVolume = value & 0x07;
                this.vinBits = value & 0x88;
                break;
            case 0xff25:
                this.panning = value;
                break;
            case 0xff26: {
                const wasOn = this.powerOn;
                this.powerOn = (value & 0x80) !== 0;
                if (wasOn && !this.powerOn) {
                    // Powering off clears all registers (but not wave RAM).
                    this.ch1 = new PulseChannel(true);
                    this.ch2 = new PulseChannel(false);
                    const wave = this.ch3.wave;
                    this.ch3 = new WaveChannel();
                    this.ch3.wave = wave;
                    this.ch4 = new NoiseChannel();
                    this.leftVolume = 0;
                    this.rightVolume = 0;
                    this.vinBits = 0;
                    this.panning = 0;
                }
                // Frame sequencer phase resets on a 0->1 power transition; the underlying
                // DIV-driven clock (frameSeqCounter) is untouched since it never stopped.
                if (!wasOn && this.powerOn) this.frameSeqStep = 0;
                break;
            }
        }

        if (address >= 0xff30 && address <= 0xff3f) {
            // Same redirect as reads: while channel 3 is playing, any wave RAM address
            // writes the byte it's currently sampling instead of the addressed byte.
            const index = this.ch3.enabled ? this.ch3.position >> 1 : address - 0xff30;
            this.ch3.wave[index] = value;
        }
    }
}
