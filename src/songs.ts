import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

/**
 * When the LLM returns action "sing" (any wording), play a pre-recorded clip from songs/ instead of TTS.
 *
 * Clips are stored ready to play: raw PCM s16le mono 24 kHz (.pcm), exactly what the TTS streams,
 * loaded into memory at startup so there is no decoding at request time. Convert a new clip once with:
 *   ffmpeg -i clip.mp3 -f s16le -acodec pcm_s16le -ac 1 -ar 24000 songs/clip.pcm
 */
export const SONGS_DIR = path.join(__dirname, '..', 'songs');  // src/ under ts-node, dist/ when built
const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;

const songs: { name: string; pcm: Buffer }[] = fs.existsSync(SONGS_DIR)
    ? fs.readdirSync(SONGS_DIR)
        .filter(f => f.toLowerCase().endsWith('.pcm'))
        .map(f => ({ name: f, pcm: fs.readFileSync(path.join(SONGS_DIR, f)) }))
    : [];
console.log(`[SONGS] Loaded ${songs.length} song(s) from ${SONGS_DIR}`);

export function pickSong(): { name: string; pcm: Buffer } | null {
    return songs.length ? songs[Math.floor(Math.random() * songs.length)] : null;
}

/** Stream PCM in 100 ms chunks at slightly faster than real time, like a TTS stream. */
export function pcmStream(pcm: Buffer): Readable {
    const chunkBytes = Math.round(SAMPLE_RATE * CHUNK_MS / 1000) * 2;
    let offset = 0;
    return new Readable({
        read() {
            if (offset >= pcm.length) {
                this.push(null);
                return;
            }
            const chunk = pcm.subarray(offset, offset + chunkBytes);
            offset += chunkBytes;
            setTimeout(() => this.push(chunk), CHUNK_MS * 0.8);
        }
    });
}
