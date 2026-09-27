"""Stand-in for server-tetris's /monitor socket: replays a scripted conversation so the bridge can be
tested without the toy or API keys. Uses its own port so it never clashes with the real server.

usage: python fake_monitor.py [--port 8898] [--loop]
then:  python bridge.py <instance> --monitor ws://localhost:8898/monitor --no-intro
"""
import argparse
import asyncio
import json
import math

import websockets

SCRIPT = [
    ("Hi SamSam, what's your favourite thing?", "I love flying my rocket past the stars!", "excited", "ROCKET TIME!", ["rocket", "star"]),
    ("I love you SamSam", "Aww, I love you too, you make my whiskers wiggle!", "love", "LOVE YOU TOO", ["heart"]),
    ("My ice cream fell", "Oh no, that is so sad, I am sorry about your ice cream.", "sad", "OH NO", ["moon"]),
    ("I pulled your tail", "Hey! That is not nice, please be gentle with my tail!", "angry", "NOT NICE!", ["exclaim"]),
    ("Let's play a game", "Yes! Let's play a space game together!", "neutral", "LETS PLAY", ["smile", "planet"]),
]


async def conversation(ws):
    async def send(**ev):
        await ws.send(json.dumps(ev))

    for heard, reply, emotion, caption, icons in SCRIPT:
        await send(type="recording_started")
        await asyncio.sleep(1.0)
        await send(type="vad_speech_start")
        await asyncio.sleep(2.0)
        await send(type="recording_stopped", reason="silence")
        await send(type="processing_started")
        await asyncio.sleep(1.2)
        await send(type="transcription_complete", transcription=heard)
        await send(type="response_generated", response=reply, emotion=emotion, caption=caption, icons=icons)
        await send(type="tts_streaming_started")
        # Speech-like loudness: ~0.07 s chunks, syllable-rate wobble, ~65 ms per character of reply.
        seconds = len(reply) * 0.065
        chunks = int(seconds / 0.07)
        for i in range(chunks):
            rms = 0.02 + 0.15 * max(0.0, math.sin(i * 1.3)) * (0.6 + 0.4 * math.sin(i * 0.37))
            await send(type="tts_level", rms=rms, bytes=int(0.07 * 48000))
            await asyncio.sleep(0.02)  # TTS streams faster than real time
        await send(type="tts_streaming_complete", audioBytes=int(chunks * 0.07 * 48000), sampleRate=24000)
        await asyncio.sleep(seconds + 3)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8898)
    ap.add_argument("--loop", action="store_true")
    args = ap.parse_args()

    async def handler(ws):
        print("[fake] bridge connected, playing script")
        while True:
            await conversation(ws)
            if not args.loop:
                break
        print("[fake] script done")
        await ws.wait_closed()

    async with websockets.serve(handler, "localhost", args.port):
        print(f"[fake] ws://localhost:{args.port}/monitor")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
