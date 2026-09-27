declare module 'avr-vad' {
  export interface RealTimeVADOptions {
    sampleRate: number;
    positiveSpeechThreshold: number;
    negativeSpeechThreshold: number;
    redemptionFrames: number;
    onSpeechStart?: () => void;
    onSpeechEnd?: (audio: Float32Array) => void;
    onVADMisfire?: () => void;
    onFrameProcessed?: () => void;
    onSpeechRealStart?: () => void;
  }

  export class RealTimeVAD {
    static new(options: RealTimeVADOptions): Promise<RealTimeVAD>;
    processAudio(audio: Float32Array): Promise<void>;
    start(): void;
    reset(): void;
    pause(): void;
    destroy(): void;
  }
}
