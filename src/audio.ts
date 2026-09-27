import { WebSocket } from 'ws';
import * as wav from 'wav';
import { Writable } from 'stream';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';

interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitDepth: number;
}
export enum SampleRate {
    RATE_16000 = 16000,
    RATE_44100 = 44100,
    RATE_24000 = 24000, 
    RATE_22050 = 22050
  }
  
export class AudioManager {
    private configMediumDef: AudioConfig = {
        sampleRate: 24000, // Match ESP32 sample rate from audioConfig[44100]
        channels: 1,       // Mono audio from audioConfig
        bitDepth: 16      // 16-bit audio for Int16 codec
    };

    private configLowDef: AudioConfig = {
        sampleRate: 16000, // Match ESP32 sample rate from audioConfig[16000]
        channels: 1,       // Mono audio from audioConfig
        bitDepth: 16      // 16-bit audio for Int16 codec
    };

    private configHighDef: AudioConfig = {
        sampleRate: 44100, // High definition sample rate
        channels: 1,       // Mono audio
        bitDepth: 16      // 16-bit audio for Int16 codec
    };
    private configUltraHighDef: AudioConfig = {
        sampleRate: 96000, // Ultra high definition sample rate
        channels: 1,       // Mono audio
        bitDepth: 16      // 16-bit audio for Int16 codec
    };
    private fileWriter: wav.FileWriter | undefined;
    private writeTimeout: NodeJS.Timeout | null = null;
    private isProcessing: boolean = false;

    private config = this.configHighDef;
    private readonly NOISE_FLOOR_THRESHOLD = 100;  // Amplitude threshold

    constructor() {
        // Don't initialize file writer in constructor
    }

    private initializeFileWriter(filename: string) {
        this.fileWriter = new wav.FileWriter(filename, {
            sampleRate: this.config.sampleRate,
            channels: this.config.channels,
            bitDepth: this.config.bitDepth
        });
    }

    /**
     * Check if chunk has meaningful audio (not just noise)
     */
    private hasSignificantAudio(buffer: Buffer): boolean {
        const samples = buffer.length / 2;
        let sumSquares = 0;

        for (let i = 0; i < samples; i++) {
            const sample = buffer.readInt16LE(i * 2);
            sumSquares += sample * sample;
        }

        const rms = Math.sqrt(sumSquares / samples);
        return rms > this.NOISE_FLOOR_THRESHOLD;
    }

    public startRecording() {
        // Generate random ID for filename
        const randomId = Math.random().toString(36).substring(2, 15);
        const filename = `recording-${randomId}.wav`;
        
        // Initialize new file writer with random filename
        this.initializeFileWriter(filename);
    }

    private audioBuffer: Buffer = Buffer.alloc(0);
    private readonly WRITE_DELAY = 500; // Reduced to 500ms for more responsive writes
    private readonly MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffer size to prevent memory issues
    private readonly MIN_BUFFER_SIZE = this.config.sampleRate; // 1 second worth of audio data

    
    public handleAudioBuffer(buffer: Buffer, ws?: WebSocket): void {
        try {
            // Check if adding new buffer would exceed max size
            if (this.audioBuffer.length + buffer.length > this.MAX_BUFFER_SIZE) {
                // Process existing buffer before adding more
                this.processAndWriteBuffer();
            }

            // Concatenate incoming buffer with existing data
            this.audioBuffer = Buffer.concat([this.audioBuffer, buffer]);

            // Reset the write timeout
            if (this.writeTimeout) {
                clearTimeout(this.writeTimeout);
            }

            // Set new timeout to trigger write
            this.writeTimeout = setTimeout(() => {
                if (this.audioBuffer.length > 0) {
                    this.processAndWriteBuffer();
                }
            }, this.WRITE_DELAY);

            // If buffer exceeds minimum size, process immediately
            if (this.audioBuffer.length >= this.MIN_BUFFER_SIZE && !this.isProcessing) {
                this.processAndWriteBuffer();
            }

        } catch (error) {
            console.error('Error handling audio buffer:', error);
            // Log more details about the error
            if (error instanceof Error) {
                console.error('Error details:', error.message, error.stack);
            }
            this.audioBuffer = Buffer.alloc(0);
            this.isProcessing = false;
        }
    }

    private processAndWriteBufferSimple(): void {
        if (!this.fileWriter || this.audioBuffer.length === 0 || this.isProcessing) return;

        try {
            this.isProcessing = true;
            // Write buffer and clear in one atomic operation
            const bufferToWrite = this.audioBuffer;
            this.audioBuffer = Buffer.alloc(0);
            
            this.fileWriter.write(bufferToWrite);

            // Audio data written (logging disabled to reduce spam)
        } catch (error) {
            console.error('Error writing audio buffer:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    public getCurrentBuffer(): Buffer {
        if (!this.fileWriter) {
            console.error('No file writer available');
            return Buffer.alloc(0);
        }

        try {
            const audioFilePath = this.fileWriter.path;
            const fileBuffer = fs.readFileSync(audioFilePath);
            console.log(`Successfully read audio file: ${audioFilePath}`);

            /*
             * Delete it the moment it has been read.
             *
             * The file was never meant as a record of anything. It is the
             * accumulation buffer: chunks are flushed to a wav.FileWriter
             * purely because that was the easy way to get a valid header, and
             * this method reads the whole thing straight back. By the time we
             * are here the bytes are in memory and the file has no further
             * use, so keeping it only leaves recordings of people's voices
             * lying around — on a deployed host, indefinitely and off your
             * machine. cleanupRecordings() capping the directory at ten files
             * was a disk-space guard, not a decision to retain anything.
             *
             * Set KEEP_RECORDINGS=true to keep them, which is worth doing when
             * you are debugging what the microphone actually captured.
             */
            if (process.env.KEEP_RECORDINGS !== 'true') {
                try {
                    fs.unlinkSync(audioFilePath);
                } catch (err) {
                    // A failed delete must not lose the utterance we just read.
                    console.warn(`[AUDIO] Could not delete ${audioFilePath}:`, err);
                }
            }

            return fileBuffer;
        } catch (error) {
            console.error('Error reading current audio buffer:', error);
            return Buffer.alloc(0);
        }
    }

    private processAndWriteBuffer(): void {
        return this.processAndWriteBufferWithGain();
        // return this.processAndWriteBufferSimple();
    }

    private processAndWriteBufferWithGain(): void {
        if (this.isProcessing || this.audioBuffer.length === 0) return;

        this.isProcessing = true;
        try {
            // Convert buffer to 16-bit PCM samples
            const samples = new Int16Array(this.audioBuffer.length / 2);
            for (let i = 0; i < this.audioBuffer.length; i += 2) {
                // Read samples directly without distortion
                const sample = this.audioBuffer.readInt16LE(i);
                samples[i / 2] = sample;
            }

            // Write audio directly (amplification already applied in server.ts)
            const audioBuffer = Buffer.from(samples.buffer);
            this.fileWriter?.write(audioBuffer);
            console.log(`Wrote ${this.audioBuffer.length} bytes of audio data`);

            // Clear the buffer after processing
            this.audioBuffer = Buffer.alloc(0);
        } finally {
            this.isProcessing = false;
        }
    }
    private processAudioSamples(samples: Int16Array, maxAmplitude: number): Buffer {
        const processedSamples = new Int16Array(samples.length);
        const GAIN = 10.0; // INCREASED gain to amplify quiet microphone audio
        // Normalize and amplify
        const normalizeRatio = maxAmplitude > 0 ? (32767 / maxAmplitude) * GAIN : 1;
        const noiseFloor = 15; // Increased noise floor
        const maxVal = 32767 * 0.6; // Reduced maximum value to prevent clipping
        
        let prevSample = 0; // For simple low-pass filter
        const smoothingFactor = 0.1; // Adjust between 0 and 1

        for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i]) < noiseFloor) {
                processedSamples[i] = 0;
                continue;
            }

            let normalizedSample = samples[i] * normalizeRatio;
            
            // Apply simple low-pass filter
            normalizedSample = prevSample + smoothingFactor * (normalizedSample - prevSample);
            prevSample = normalizedSample;

            processedSamples[i] = Math.round(
                Math.max(Math.min(normalizedSample, maxVal), -maxVal)
            );
        }

        return Buffer.from(processedSamples.buffer);
    }

    /**
     * Create WAV header for PCM audio
     */
    public static createWavHeader(
        dataLength: number,
        sampleRate: number = 44100
    ): Buffer {
        const header = Buffer.alloc(44);

        // RIFF chunk
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4);
        header.write('WAVE', 8);

        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);         // PCM
        header.writeUInt16LE(1, 22);         // Mono
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * 2, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);

        return header;
    }

    /**
     * Clean up old recordings (keep last 10)
     */
    public static async cleanupRecordings(): Promise<void> {
        try {
            const cwd = process.cwd();
            const files = await fsPromises.readdir(cwd);
            const wavFiles = files
                .filter(f => f.startsWith('recording-') && f.endsWith('.wav'))
                .map(f => ({
                    name: f,
                    path: path.join(cwd, f),
                    time: 0
                }));

            // Get modification times
            for (const file of wavFiles) {
                const stats = await fsPromises.stat(file.path);
                file.time = stats.mtimeMs;
            }

            // Sort newest first
            wavFiles.sort((a, b) => b.time - a.time);

            /*
             * Sweep all of them, not the all-but-ten this used to keep.
             *
             * getCurrentBuffer() now deletes each file as soon as it has been
             * read, so in the normal path there is nothing here to find. What
             * this catches is the abandoned ones: a turn where the VAD never
             * fired, or the device dropped mid-utterance, leaves a file that
             * nothing ever reads. Keeping ten of those was fine as a disk
             * guard and is not fine as a privacy posture — they are recordings
             * of whoever was last in front of the toy.
             *
             * Runs on every device connect, so an orphan survives at most until
             * the next session.
             */
            const toDelete = process.env.KEEP_RECORDINGS === 'true' ? wavFiles.slice(10) : wavFiles;
            for (const file of toDelete) {
                await fsPromises.unlink(file.path);
                console.log(`[AUDIO] Deleted old recording: ${file.name}`);
            }

            if (toDelete.length > 0) {
                console.log(`[AUDIO] Cleanup complete: removed ${toDelete.length} old recordings`);
            }
        } catch (error) {
            console.error('[AUDIO] Cleanup error:', error);
        }
    }

    // public getCurrentBuffer(): Buffer {
    //     return this.audioBuffer;
    // }

    public closeFile(): void {
        console.log('Closing WAV file writer');
        if (this.writeTimeout) {
            clearTimeout(this.writeTimeout);
        }
        if (this.audioBuffer.length > 0) {
            this.processAndWriteBuffer();
        }
        if (this.fileWriter) {
            this.fileWriter.end();
        }
    }
}
