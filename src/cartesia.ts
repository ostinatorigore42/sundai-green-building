import { CartesiaClient } from '@cartesia/cartesia-js';
import { Readable } from 'stream';

export const cartesiaClient = new CartesiaClient({
    apiKey: process.env.CARTESIA_API_KEY!,
});

/**
 * Generate speech stream using Cartesia Sonic - TRUE STREAMING
 *
 * Output: 24kHz PCM16 mono (matches ESP32 speaker configuration)
 * Voice: 32b3f3c5-7171-46aa-abe7-b598964aa793 (user-selected voice)
 */
export async function generateSpeechStreamCartesia(text: string): Promise<Readable> {
    try {
        console.log('[CARTESIA] Generating speech with Sonic (streaming)...');

        // Get stream from Cartesia HTTP API
        const audioStream = await cartesiaClient.tts.bytes({
            modelId: 'sonic-3.5',  // sonic-english was sunsetted by Cartesia
            transcript: text,
            voice: {
                mode: 'id',
                id: '32b3f3c5-7171-46aa-abe7-b598964aa793'
            },
            language: 'en',
            outputFormat: {
                container: 'raw',
                encoding: 'pcm_s16le',
                sampleRate: 24000
            }
        });

        console.log('[CARTESIA] Converting stream for compatibility...');

        // The Cartesia stream needs to be properly consumed and re-emitted
        // Create a new Readable that properly handles the data
        const outputStream = new Readable({ read() {} });

        (async () => {
            try {
                for await (const chunk of audioStream) {
                    outputStream.push(Buffer.from(chunk));
                }
                outputStream.push(null); // Signal end
                console.log('[CARTESIA] Streaming complete');
            } catch (error) {
                outputStream.destroy(error as Error);
            }
        })();

        return outputStream;

    } catch (error: any) {
        console.error('[CARTESIA] Generation error:', error.message);
        throw error;
    }
}
