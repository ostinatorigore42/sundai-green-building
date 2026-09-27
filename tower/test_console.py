"""Interactive stand-in for server-tetris's /monitor socket, with a web console.

fake_monitor.py replays one fixed script. This does the same job but driven by
hand: open the page, type a line, pick an emotion and icons, and watch it scroll
up the tower. The point is that the whole display path becomes testable by
someone who has none of the server side — no toy, no API keys, no backend.

It emits the SAME event sequence the real server does, with the same field names
and speech-paced timing, so anything that works here works against the real
backend unchanged. If you add a field to the server's monitor broadcast, add it
here too or this stops being a faithful stand-in.

usage: python test_console.py [--port 8898] [--http-port 8897]
then:  python bridge.py <instance> --monitor ws://localhost:8898/monitor --no-intro
and:   open http://localhost:8897
"""
import argparse
import asyncio
import functools
import http.server
import json
import math
import os
import threading

import websockets

import icons as icon_art

HERE = os.path.dirname(os.path.abspath(__file__))

# Mirrors bridge.EMOTIONS. Not imported from bridge, because bridge pulls in
# gbsim and that needs the sibling simulator checkout — this tool has to run
# even when that is missing, since "is my checkout right" is one of the things
# people use it to work out.
EMOTIONS = ["neutral", "excited", "love", "sad", "angry"]

# Imported rather than retyped: icons.py only needs `re`, so it is safe to load
# standalone, and a hand-copied list would drift the moment a glyph is added.
ICONS = sorted(icon_art.ICONS)

BYTES_PER_SEC = 48000  # PCM16 mono @ 24 kHz, matching bridge.py
CHAR_SECONDS = 0.065   # rough speech rate, used to fake the audio length
CHUNK_SECONDS = 0.07   # one tts_level event per chunk
CAPTION_MAX = 32       # server-tetris truncates captions here (groq.ts)

SCRIPT = [
    ("Hi SamSam, what's your favourite thing?", "I love flying my rocket past the stars!",
     "excited", "ROCKET TIME!", ["rocket", "star"]),
    ("I love you SamSam", "Aww, I love you too, you make my whiskers wiggle!",
     "love", "LOVE YOU TOO", ["heart"]),
    ("My ice cream fell", "Oh no, that is so sad, I am sorry about your ice cream.",
     "sad", "OH NO", ["moon"]),
    ("I pulled your tail", "Hey! That is not nice, please be gentle with my tail!",
     "angry", "NOT NICE!", ["exclaim"]),
    ("Let's play a game", "Yes! Let's play a space game together!",
     "neutral", "LETS PLAY", ["smile", "planet"]),
]

monitors = set()  # bridge.py connections
consoles = set()  # browser UI connections


async def broadcast(clients, payload):
    """Send to every client, dropping the ones that have gone away."""
    dead = []
    for ws in list(clients):
        try:
            await ws.send(payload)
        except websockets.WebSocketException:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def emit(**ev):
    """One monitor event, to the bridge and to the console log."""
    payload = json.dumps(ev)
    await broadcast(monitors, payload)
    # tts_level fires ~14x a second; logging it would bury everything else.
    if ev.get("type") != "tts_level":
        await broadcast(consoles, json.dumps({"log": ev}))


async def announce():
    """Tell the console how many bridges are attached.

    This is the first question anyone wiring this up has — did bridge.py
    actually connect? — and the answer belongs on screen rather than in a
    terminal they may not be looking at.
    """
    await broadcast(consoles, json.dumps({"bridges": len(monitors)}))


async def turn(heard, reply, emotion, caption, names, song=False, friend=False):
    """One full conversation turn, in the real server's event order and timing."""
    await emit(type="recording_started")
    await asyncio.sleep(0.6)
    await emit(type="vad_speech_start")
    await asyncio.sleep(1.2)
    await emit(type="recording_stopped", reason="silence")
    await emit(type="processing_started")
    await asyncio.sleep(0.9)
    await emit(type="transcription_complete", transcription=heard)
    await emit(type="response_generated", response=reply, emotion=emotion,
               caption=caption, icons=names, song=song, friend=friend)
    await emit(type="tts_streaming_started")

    # Speech-like loudness: syllable-rate wobble over a length derived from the
    # reply. The bridge paces the tower scroll off these, so getting the shape
    # roughly right is what makes the timing look real rather than mechanical.
    seconds = max(1.0, len(reply) * CHAR_SECONDS)
    chunks = max(1, int(seconds / CHUNK_SECONDS))
    for i in range(chunks):
        rms = 0.02 + 0.15 * max(0.0, math.sin(i * 1.3)) * (0.6 + 0.4 * math.sin(i * 0.37))
        await emit(type="tts_level", rms=rms, bytes=int(CHUNK_SECONDS * BYTES_PER_SEC))
        await asyncio.sleep(0.02)  # TTS streams faster than real time

    await emit(type="tts_streaming_complete",
               audioBytes=int(chunks * CHUNK_SECONDS * BYTES_PER_SEC), sampleRate=24000)
    await asyncio.sleep(seconds + 1.5)


async def run_command(cmd):
    action = cmd.get("action")
    if action == "say":
        reply = (cmd.get("response") or "").strip() or "Hello from the tower!"
        caption = (cmd.get("caption") or "").strip()[:CAPTION_MAX]
        emotion = cmd.get("emotion") if cmd.get("emotion") in EMOTIONS else "neutral"
        names = [n for n in (cmd.get("icons") or []) if n in icon_art.ICONS]
        await turn(cmd.get("transcription") or "(typed in the test console)",
                   reply, emotion, caption, names,
                   song=bool(cmd.get("song")), friend=bool(cmd.get("friend")))
    elif action == "script":
        for heard, reply, emotion, caption, names in SCRIPT:
            await turn(heard, reply, emotion, caption, names)
    elif action == "error":
        await emit(type="processing_started")
        await asyncio.sleep(0.8)
        await emit(type="processing_error", error="test console")
    elif action == "device_connected":
        await emit(type="device_connected")
    elif action == "misfire":
        # The toy hears a noise that turns out not to be speech. Worth having a
        # button for: it is the one path that takes the tower back to idle
        # without anything being said.
        await emit(type="vad_speech_start")
        await asyncio.sleep(0.7)
        await emit(type="vad_misfire")


async def handler(ws):
    path = getattr(getattr(ws, "request", None), "path", "") or ""
    if path.startswith("/monitor"):
        monitors.add(ws)
        print(f"[console] bridge connected ({len(monitors)} attached)")
        await announce()
        try:
            await ws.wait_closed()
        finally:
            monitors.discard(ws)
            print(f"[console] bridge left ({len(monitors)} attached)")
            await announce()
        return

    consoles.add(ws)
    await announce()
    await ws.send(json.dumps({"emotions": EMOTIONS, "icons": ICONS, "captionMax": CAPTION_MAX}))
    try:
        async for msg in ws:
            try:
                cmd = json.loads(msg)
            except ValueError:
                continue
            # Fire and forget: a long reply takes ten seconds to scroll and the
            # console must stay responsive while it does.
            asyncio.create_task(run_command(cmd))
    except websockets.WebSocketException:
        pass
    finally:
        consoles.discard(ws)


def serve_page(port):
    """The console page, on its own thread. One file, no build step, no deps."""
    handler_cls = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    httpd = http.server.ThreadingHTTPServer(("localhost", port), handler_cls)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8898, help="monitor websocket port")
    ap.add_argument("--http-port", type=int, default=8897, help="console page port")
    args = ap.parse_args()

    serve_page(args.http_port)
    async with websockets.serve(handler, "localhost", args.port):
        print(f"[console] monitor  ws://localhost:{args.port}/monitor")
        print(f"[console] open     http://localhost:{args.http_port}/console.html")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
