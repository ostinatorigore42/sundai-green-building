/**
 * Silero VAD implementation using avr-vad
 * Drop-in replacement for WebRTCVAD with same interface
 */
import { RealTimeVAD, type RealTimeVADOptions } from 'avr-vad';

export interface VADResult {
    isDone: boolean;
    audio?: Buffer;
    reason?: 'silence' | 'timeout' | 'error';
    hasSpeech?: boolean;  // True only if speech was confirmed (not just a misfire)
}

export class SileroVAD {
    private speechBuffer: Buffer[] = [];
    private vad: RealTimeVAD | null = null;
    private initialized = false;
    private startTime: number = 0;
    private hasSpeech = false;
    private speechEndDetected = false;  // Track when onSpeechEnd fires
    private eventCallback?: (event: any) => void;  // Optional callback for monitor events

    // Configuration
    private readonly INPUT_SAMPLE_RATE = 44100;   // From ESP32
    private readonly MAX_DURATION_MS = 30000;     // 30 seconds timeout

    // Silero VAD parameters (tunable)
    private readonly POSITIVE_SPEECH_THRESHOLD = 0.5;  // 0-1, lowered for quiet microphone
    private readonly NEGATIVE_SPEECH_THRESHOLD = 0.3;  // Hysteresis for speech end
    private readonly REDEMPTION_FRAMES = 24;           // ~720ms of silence (24 × 30ms frames) - faster response

    constructor(eventCallback?: (event: any) => void) {
        this.startTime = Date.now();
        this.eventCallback = eventCallback;
        console.log(`[VAD] Initializing Silero VAD (threshold=${this.POSITIVE_SPEECH_THRESHOLD})`);
    }

    /**
     * Initialize Silero VAD (async)
     */
    public async init(): Promise<void> {
        if (this.initialized) return;

        try {
            // Create real-time VAD for streaming audio
            // Type assertion needed due to avr-vad type definition quirks
            this.vad = await RealTimeVAD.new({
                // Sample rate configuration
                sampleRate: this.INPUT_SAMPLE_RATE,  // 44.1kHz from ESP32 (avr-vad resamples internally)

                // Silero model configuration
                positiveSpeechThreshold: this.POSITIVE_SPEECH_THRESHOLD,
                negativeSpeechThreshold: this.NEGATIVE_SPEECH_THRESHOLD,
                redemptionFrames: this.REDEMPTION_FRAMES,

                // Callbacks
                onSpeechStart: () => {
                    // Note: hasSpeech is set in onSpeechRealStart (confirmed), not here (may still be misfire)
                    console.log(`[VAD] Speech START (Silero confidence > ${this.POSITIVE_SPEECH_THRESHOLD})`);

                    if (this.eventCallback) {
                        this.eventCallback({
                            type: 'vad_speech_start',
                            threshold: this.POSITIVE_SPEECH_THRESHOLD,
                            timestamp: Date.now()
                        });
                    }
                },

                onSpeechEnd: (audio: Float32Array) => {
                    const duration = (Date.now() - this.startTime) / 1000;
                    console.log(`[VAD] Speech END (${duration.toFixed(1)}s, silence > ${this.REDEMPTION_FRAMES * 30}ms)`);

                    // Signal that speech has ended
                    this.speechEndDetected = true;

                    if (this.eventCallback) {
                        this.eventCallback({
                            type: 'vad_speech_end',
                            duration: duration.toFixed(1),
                            silenceMs: this.REDEMPTION_FRAMES * 30,
                            timestamp: Date.now()
                        });
                    }
                },

                // Other callbacks (optional)
                onVADMisfire: () => {
                    console.log('[VAD] False positive detected (misfire)');

                    if (this.eventCallback) {
                        this.eventCallback({
                            type: 'vad_misfire',
                            timestamp: Date.now()
                        });
                    }
                },

                onFrameProcessed: () => {
                    // Called for every frame - too verbose, disabled
                },

                onSpeechRealStart: () => {
                    // Called when speech is confirmed (not a misfire)
                    this.hasSpeech = true;
                    console.log('[VAD] Speech confirmed (real start)');

                    if (this.eventCallback) {
                        this.eventCallback({
                            type: 'vad_real_start',
                            timestamp: Date.now()
                        });
                    }
                }
            });

            // Start processing
            this.vad.start();
            this.initialized = true;
            console.log(`[VAD] Silero VAD initialized (redemption=${this.REDEMPTION_FRAMES} frames = ${this.REDEMPTION_FRAMES * 30}ms)`);

            // Send config to dashboard
            if (this.eventCallback) {
                this.eventCallback({
                    type: 'vad_config',
                    mode: 'silero-vad',
                    positiveThreshold: this.POSITIVE_SPEECH_THRESHOLD,
                    negativeThreshold: this.NEGATIVE_SPEECH_THRESHOLD,
                    redemptionMs: this.REDEMPTION_FRAMES * 30,
                    redemptionFrames: this.REDEMPTION_FRAMES
                });
            }
        } catch (error) {
            console.error('[VAD] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Process incoming audio chunk from ESP32
     */
    public async addChunk(chunk: Buffer): Promise<VADResult> {
        if (!this.initialized || !this.vad) {
            console.error('[VAD] Not initialized - call await vad.init() first');
            return this.finalize('error');
        }

        try {
            // Check timeout (prevent infinite recording)
            if (Date.now() - this.startTime > this.MAX_DURATION_MS) {
                console.warn('[VAD] Max duration reached, forcing stop');

                if (this.eventCallback) {
                    this.eventCallback({
                        type: 'vad_timeout',
                        maxDurationMs: this.MAX_DURATION_MS,
                        timestamp: Date.now()
                    });
                }

                return this.finalize('timeout');
            }

            // Buffer original 44.1kHz audio (we'll send this to OpenAI)
            this.speechBuffer.push(chunk);

            // Convert Buffer (int16 PCM) to Float32Array for avr-vad
            const float32Audio = this.bufferToFloat32(chunk);

            // Process with Silero VAD (async, triggers callbacks)
            await this.vad.processAudio(float32Audio);

            // Check if onSpeechEnd was triggered
            if (this.speechEndDetected) {
                return this.finalize('silence');
            }

            return { isDone: false };

        } catch (error) {
            console.error('[VAD] Error processing chunk:', error);
            return this.finalize('error');
        }
    }

    /**
     * Convert int16 PCM Buffer to Float32Array (-1.0 to 1.0 range)
     */
    private bufferToFloat32(buffer: Buffer): Float32Array {
        const samples = buffer.length / 2;  // int16 = 2 bytes per sample
        const float32 = new Float32Array(samples);

        for (let i = 0; i < samples; i++) {
            const int16 = buffer.readInt16LE(i * 2);
            float32[i] = int16 / 32768.0;  // Normalize to -1.0 to 1.0
        }

        return float32;
    }

    /**
     * Finalize recording and return buffered audio
     */
    private finalize(reason: 'silence' | 'timeout' | 'error'): VADResult {
        const duration = (Date.now() - this.startTime) / 1000;
        console.log(`[VAD] Finalizing: reason=${reason}, duration=${duration.toFixed(1)}s, buffer=${this.speechBuffer.length} chunks`);

        // Return original 44.1kHz audio (better quality for OpenAI)
        const audio = this.speechBuffer.length > 0
            ? Buffer.concat(this.speechBuffer)
            : undefined;

        return {
            isDone: true,
            audio,
            reason,
            hasSpeech: this.hasSpeech
        };
    }

    /**
     * Reset VAD state for next utterance
     */
    public reset(): void {
        this.speechBuffer = [];
        this.hasSpeech = false;
        this.speechEndDetected = false;
        this.startTime = Date.now();

        // Reset VAD internal state
        if (this.vad) {
            this.vad.reset();
            this.vad.start();  // Restart processing
        }
    }

    /**
     * Cleanup resources
     */
    public destroy(): void {
        if (this.vad) {
            this.vad.pause();  // Stop processing
            this.vad.destroy();  // Clean up resources
            this.vad = null;
        }
        this.initialized = false;
    }

    /**
     * Get current recording stats (for debugging)
     */
    public getStats() {
        return {
            duration: (Date.now() - this.startTime) / 1000,
            hasSpeech: this.hasSpeech,
            bufferSize: this.speechBuffer.reduce((sum, buf) => sum + buf.length, 0),
            chunks: this.speechBuffer.length
        };
    }
}
