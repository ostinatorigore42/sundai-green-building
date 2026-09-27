import Groq from 'groq-sdk';

export const groqClient = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Transcribe audio using Groq Whisper-3 (faster than OpenAI)
 */
export async function transcribeWithGroqWhisper(audioBuffer: Buffer): Promise<string> {
    try {
        const file = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

        const transcription = await groqClient.audio.transcriptions.create({
            file: file,
            model: 'whisper-large-v3-turbo',  // Whisper-3 Turbo (fastest)
            language: 'en',
            response_format: 'text',
            temperature: 0.0  // Deterministic
        });

        return typeof transcription === 'string' ? transcription : transcription.text;
    } catch (error: any) {
        console.error('[GROQ-WHISPER] Transcription error:', error.message);
        throw error;
    }
}

// Tower display extras (server-tetris): emotion is validated, icons come from the pixel icon set
// the building mascot can draw, caption is a short line for the 9-window-wide tower.
export const EMOTIONS = ['neutral', 'excited', 'love', 'sad', 'angry'] as const;
export const ICONS = ['heart', 'star', 'rocket', 'planet', 'moon', 'sun', 'music', 'paw', 'sparkle', 'smile', 'question', 'exclaim'] as const;

export type TextResponse = { responseText: string; emotion: string; caption: string; icons: string[]; action: 'sing' | 'friend' | 'none' };

const SYSTEM_PROMPT =
    'You are a helpful, friendly AI assistant in a children\'s toy. Keep responses short (1-2 short sentences), simple, and encouraging; you may end with a short follow-up question. Be expressive and warm.\n\n' +
    'Your reply is spoken aloud by the toy AND shown on a giant pixel sign, so:\n' +
    '- "response" is the spoken sentence: plain words only, never emojis or symbols.\n' +
    '- "caption" is what the sign shows instead of the full reply: 2-5 punchy words capturing it, no question (letters, digits and ! only).\n' +
    `- "icons" is 2-3 picture names that fit the reply (always at least 2), chosen ONLY from: ${ICONS.join(', ')}.\n` +
    '- "action" is "sing" whenever the child wants you to sing, hum, or play a song or music, in any wording; ' +
    '"friend" whenever the child wants to see, meet, or hear about your friend or friends, in any wording; otherwise "none". ' +
    'When "sing", the toy plays its meow song, so keep "response" to a tiny lead-in like "Here comes my song!". ' +
    'When "friend", your best friend is Tim the Beaver, MIT\'s mascot: introduce him warmly in "response" ' +
    '(e.g. "Meet my best friend, Tim the Beaver!") and use caption "MY FRIEND TIM".\n\n' +
    'You MUST respond with valid JSON only, no other text:\n' +
    '{"response": "your spoken response here", "emotion": "neutral|excited|love|sad|angry", "caption": "SHORT SIGN TEXT", "icons": ["star", "rocket"], "action": "none"}';

function parseResponse(raw: string): TextResponse {
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);  // tolerate text or code fences around the JSON
        try { parsed = match ? JSON.parse(match[0]) : null; } catch { parsed = null; }
    }
    if (!parsed || typeof parsed.response !== 'string') {
        console.warn('[GROQ] Response was not valid JSON, using raw text');
        return { responseText: raw, emotion: 'neutral', caption: '', icons: [], action: 'none' };
    }
    const emotion = (EMOTIONS as readonly string[]).includes(parsed.emotion) ? parsed.emotion : 'neutral';
    const icons = Array.isArray(parsed.icons)
        ? parsed.icons.map((i: unknown) => String(i).toLowerCase()).filter((i: string) => (ICONS as readonly string[]).includes(i)).slice(0, 3)
        : [];
    const caption = typeof parsed.caption === 'string' ? parsed.caption.replace(/[^A-Za-z0-9 !?'.,-]/g, '').trim().slice(0, 32) : '';
    const action = parsed.action === 'sing' || parsed.action === 'friend' ? parsed.action : 'none';
    return { responseText: parsed.response, emotion, caption, icons, action };
}

/**
 * Generate text response using Groq Llama (5-10x faster than GPT-4)
 * Returns spoken response text, emotion, and tower caption + icons (no extra API call).
 */
export async function generateTextResponseGroq(
    transcription: string,
    conversationHistory: HistoryMessage[] = []
): Promise<TextResponse> {
    try {
        const completion = await groqClient.chat.completions.create({
            model: 'openai/gpt-oss-120b',  // llama-3.3-70b-versatile was removed from Groq
            reasoning_effort: 'low',
            messages: [
                {
                    role: 'system',
                    content: SYSTEM_PROMPT
                },
                ...conversationHistory,
                {
                    role: 'user',
                    content: transcription
                }
            ],
            temperature: 0.9,
            max_tokens: 350,  // was 200; room for caption + icons so the JSON isn't truncated
            stream: false
        });

        const raw = completion.choices[0]?.message?.content;
        if (!raw) throw new Error('No response from Groq');

        return parseResponse(raw);
    } catch (error: any) {
        console.error('[GROQ] Generation error:', error.message);
        throw error;
    }
}
