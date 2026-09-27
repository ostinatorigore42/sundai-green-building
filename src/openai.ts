import OpenAI from 'openai';
import { Readable } from 'stream';
import { transcribeWithGroqWhisper, generateTextResponseGroq, HistoryMessage } from './groq';
import { generateSpeechStreamCartesia } from './cartesia';
import { pickSong, pcmStream } from './songs';

export const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function createOpenAICompletionStream(fileBuffer: Buffer) {
    const base64str = fileBuffer.toString('base64');

    return await openaiClient.chat.completions.create({
        model: "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: {
            voice: "alloy",
            format: "pcm16"
        },
        messages: [
            {
                role: "system",
                content: "You are a helpful AI assistant. Your task is to listen to the audio input, transcribe it, and provide a relevant and concise response. If the audio is unclear or there's no speech detected, kindly ask for clarification."
            },
            {
                role: "user",
                content: [
                    { type: "input_audio", input_audio: { data: base64str, format: "wav" } }
                ]
            }
        ],
        stream: true
    });
}

/**
 * Transcribe audio using Whisper API (no AI response, just transcription)
 * Perfect for testing VAD - shows exactly what was spoken
 */
export async function transcribeWithWhisper(audioBuffer: Buffer): Promise<string> {
    try {
        // Whisper API expects a File object
        const file = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

        const transcription = await openaiClient.audio.transcriptions.create({
            file: file,
            model: 'whisper-1',
            language: 'en', // Optional: specify language for better accuracy
            response_format: 'text'
        });

        return transcription;
    } catch (error: any) {
        console.error('[WHISPER] Transcription error:', error.message);
        throw error;
    }
}

/**
 * Generate text response from transcription using GPT-4
 */
export async function generateTextResponse(transcription: string): Promise<string> {
    try {
        const completion = await openaiClient.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful, friendly AI assistant in a children\'s toy. Keep responses short (1-2 sentences), simple, and encouraging.'
                },
                {
                    role: 'user',
                    content: transcription
                }
            ],
            temperature: 0.8,
            max_tokens: 150
        });

        const responseText = completion.choices[0]?.message?.content;
        if (!responseText) {
            throw new Error('No response from GPT-4');
        }

        return responseText;
    } catch (error: any) {
        console.error('[GPT-4] Generation error:', error.message);
        throw error;
    }
}

/**
 * Resample PCM16 audio using linear interpolation
 * Required because TTS API outputs 24kHz but ESP32 speaker expects 32kHz
 */
function resamplePCM16(audioBuffer: Buffer, originalRate: number = 24000, targetRate: number = 32000): Buffer {
    // Convert int16 PCM to samples
    const inputSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);

    const resampleRatio = originalRate / targetRate;
    const outputLength = Math.floor(inputSamples.length / resampleRatio);
    const outputSamples = new Int16Array(outputLength);

    // Linear interpolation resampling
    for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * resampleRatio;
        const srcFloor = Math.floor(srcIndex);
        const srcCeil = Math.min(srcFloor + 1, inputSamples.length - 1);
        const fraction = srcIndex - srcFloor;

        const interpolated = (1 - fraction) * inputSamples[srcFloor] + fraction * inputSamples[srcCeil];
        outputSamples[i] = Math.round(interpolated);
    }

    return Buffer.from(outputSamples.buffer);
}

/**
 * Generate speech audio stream from text using OpenAI TTS
 *
 * IMPORTANT: OpenAI TTS with PCM format returns 24kHz PCM
 * We resample to 32kHz to match ESP32 speaker configuration (matching reference project)
 */
export async function generateSpeechStream(text: string): Promise<Readable> {
    try {
        const response = await openaiClient.audio.speech.create({
            model: 'tts-1',
            voice: 'nova',  // Child-friendly voice
            input: text,
            response_format: 'pcm',  // 24kHz, 16-bit, mono, little-endian PCM
            speed: 1.0
        });

        const webStream = response.body;
        if (!webStream) {
            throw new Error('No audio stream from TTS');
        }

        // Use native 24kHz output (matches working backup configuration)
        // Backup that worked used 24kHz with no resampling
        console.log('[TTS] Using native 24kHz output (matching working backup)');
        return Readable.from(webStream as any);
    } catch (error: any) {
        console.error('[TTS] Generation error:', error.message);
        throw error;
    }
}

/**
 * Simple linear gain boost for TTS output (no normalization — just amplify)
 */
export function boostAudioBuffer(buffer: Buffer, gain: number): Buffer {
    const numSamples = Math.floor(buffer.length / 2);
    const output = Buffer.alloc(buffer.length);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-32768, Math.min(32767, Math.round(buffer.readInt16LE(i * 2) * gain)));
        output.writeInt16LE(s, i * 2);
    }
    return output;
}

/**
 * Complete speech processing pipeline: Groq Whisper-3 → Groq Llama → TTS (configurable)
 *
 * TTS provider can be switched via TTS_PROVIDER environment variable:
 * - TTS_PROVIDER=cartesia (default) - Uses Cartesia Sonic
 * - TTS_PROVIDER=openai - Uses OpenAI TTS (saves Cartesia credits)
 */
export async function processSpeechPipeline(audioBuffer: Buffer, conversationHistory: HistoryMessage[] = []): Promise<{
    transcription: string;
    responseText: string;
    emotion: string;
    caption: string;
    icons: string[];
    song: boolean;
    friend: boolean;
    audioStream: Readable;
}> {
    const t0 = Date.now();

    // Step 1: Transcription with Groq Whisper-3 Turbo
    console.log('[PIPELINE] Step 1/3: Transcribing with Groq Whisper-3...');
    const transcription = await transcribeWithGroqWhisper(audioBuffer);
    const t1 = Date.now();
    console.log(`[PIPELINE] Transcription: "${transcription}"`);
    console.log(`[TIMING] Groq Whisper took ${t1 - t0}ms`);

    // Step 2: Text generation with Groq Llama-3.3-70b (returns response + emotion)
    console.log('[PIPELINE] Step 2/3: Generating response with Groq Llama...');
    const { responseText, emotion, caption, icons, action } = await generateTextResponseGroq(transcription, conversationHistory);
    const t2 = Date.now();
    console.log(`[PIPELINE] Response: "${responseText}" | emotion: ${emotion} | caption: "${caption}" | icons: ${icons.join(',')} | action: ${action}`);
    console.log(`[TIMING] Groq Llama took ${t2 - t1}ms`);

    // The LLM recognised a request to sing (any wording): play the pre-converted clip instead of TTS
    if (action === 'sing') {
        const song = pickSong();
        if (song) {
            console.log(`[PIPELINE] Singing ${song.name} (${(song.pcm.length / 48000).toFixed(1)}s)`);
            return {
                transcription, responseText: 'Meow meow meow!', emotion: 'excited',
                caption: 'MEOW MEOW', icons: ['music', 'music'], song: true, friend: false, audioStream: pcmStream(song.pcm)
            };
        }
        console.warn('[PIPELINE] Sing request but songs/ has no .pcm clips, answering normally');
    }

    // Step 3: TTS (configurable via TTS_PROVIDER env variable)
    const ttsProvider = process.env.TTS_PROVIDER || 'cartesia';
    let audioStream: Readable;

    if (ttsProvider === 'openai') {
        console.log('[PIPELINE] Step 3/3: Generating speech with OpenAI TTS...');
        audioStream = await generateSpeechStream(responseText);
        const t3 = Date.now();
        console.log('[PIPELINE] ✓ Complete (Groq + OpenAI TTS pipeline)');
        console.log(`[TIMING] OpenAI TTS took ${t3 - t2}ms`);
        console.log(`[TIMING] Total pipeline: ${t3 - t0}ms`);
    } else {
        console.log('[PIPELINE] Step 3/3: Generating speech with Cartesia...');
        audioStream = await generateSpeechStreamCartesia(responseText);
        const t3 = Date.now();
        console.log('[PIPELINE] ✓ Complete (Groq + Cartesia pipeline)');
        console.log(`[TIMING] Cartesia took ${t3 - t2}ms`);
        console.log(`[TIMING] Total pipeline: ${t3 - t0}ms`);
    }

    // action "friend": spoken normally, the tower brings in Tim the Beaver next to SamSam
    return { transcription, responseText, emotion, caption, icons, song: false, friend: action === 'friend', audioStream };
}

// /**
//  * BACKUP: OpenAI-only pipeline (manually uncomment to switch)
//  * Replace processSpeechPipeline above with this function to use OpenAI
//  */
// export async function processSpeechPipeline(audioBuffer: Buffer): Promise<{
//     transcription: string;
//     responseText: string;
//     audioStream: Readable;
// }> {
//     const t0 = Date.now();
//     console.log('[PIPELINE] Step 1/3: Transcribing with OpenAI Whisper...');
//     const transcription = await transcribeWithWhisper(audioBuffer);
//     const t1 = Date.now();
//     console.log(`[PIPELINE] Transcription: "${transcription}"`);
//     console.log(`[TIMING] OpenAI Whisper took ${t1 - t0}ms`);
//
//     console.log('[PIPELINE] Step 2/3: Generating response with GPT-4...');
//     const responseText = await generateTextResponse(transcription);
//     const t2 = Date.now();
//     console.log(`[PIPELINE] Response: "${responseText}"`);
//     console.log(`[TIMING] GPT-4 took ${t2 - t1}ms`);
//
//     console.log('[PIPELINE] Step 3/3: Generating speech with OpenAI TTS...');
//     const audioStream = await generateSpeechStream(responseText);
//     const t3 = Date.now();
//     console.log('[PIPELINE] ✓ Complete (OpenAI pipeline)');
//     console.log(`[TIMING] OpenAI TTS took ${t3 - t2}ms`);
//     console.log(`[TIMING] Total pipeline: ${t3 - t0}ms`);
//
//     return { transcription, responseText, audioStream };
// }
