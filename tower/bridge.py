"""Bridge: SamSam toy server events -> live SamSam on the Green Building simulator.

Listens to the toy server's monitor WebSocket and streams frames through the Display interface.

usage: python bridge.py <instance> [--monitor ws://localhost:8899/monitor] [--no-intro]
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time

# gbsim is vendored next to this file so the whole tower runs from one repo and
# one deploy. The sibling-checkout path is kept as a fallback for the original
# layout, where the simulator was cloned beside the mascot folder.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(1, os.path.join(_HERE, "..", "sundai-greenbuilding-sim", "poc", "python"))

import websockets
from gbsim import WebDisplay

import font
import icons
import logo
from canvas import Canvas, hsv
from samsam import expression, PALETTE
from talk import Talker, FPS

EMOTIONS = {"neutral", "excited", "love", "sad", "angry"}
MAX_WORDS = 6        # fallback caption length; the tower scrolls ~3 letters/s
BYTES_PER_SEC = 48000  # PCM16 mono @ 24 kHz, which the toy plays natively
PLAY_DELAY = 0.3     # seconds between the server streaming audio and the toy speaker playing it
MAX_PASSES = 1       # the full reply scrolls once, paced to the voice
SING_LINE = "MEOW MEOW {music} {music}"
SING_SPEED = 11.0    # columns per second for the looping song line
CHARS_PER_SEC = 14   # speech rate estimate until the real audio length is known
MIN_SPEED, MAX_SPEED = 9.0, 15.0  # columns per second: readable .. keeps up with fast talk


def caption(text):
    """Fallback when the server sends no caption: first sentence, first few words."""
    first = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]
    words = first.split()
    line = " ".join(words[:MAX_WORDS]) + ("..." if len(words) > MAX_WORDS else "")
    return re.sub(r"[^A-Za-z0-9 .,!?'\-:]", "", line)


def ticker_line(ev):
    """Short tower caption plus pixel icons; the toy speaks the full reply.

    Uses server-tetris's caption and icons, falling back to the first words and keyword icons.
    """
    text = ev.get("response", "")
    cap = re.sub(r"[^A-Za-z0-9 .,!?'\-:]", "", ev.get("caption") or "").strip() or caption(text)
    names = [n for n in (ev.get("icons") or []) if n in icons.ICONS] or icons.from_text(text)
    return (cap + " " + " ".join("{%s}" % n for n in names)).strip()


class Scene:
    """Idle / listening / thinking / talking, on top of the Talker."""

    def __init__(self):
        self.talker = Talker()
        self.state = "idle"
        self.pending = None      # (line, emotion) waiting for audio to start
        self.line = ""
        self.passes = 0
        self.audio_t0 = None     # wall time the voice starts playing on the toy
        self.audio_end = None    # wall time it stops (known once streaming completes)
        self.levels = []         # (seconds into the audio, rms)
        self.audio_pos = 0.0
        self.peak = 0.05
        self.t = 0
        self.singing = False     # song clip playing: the line loops until the song ends
        self.friend = False      # Tim the Beaver joins SamSam for this reply
        self.live = False        # set by the first conversation event; cuts the boot logo short

    def on_event(self, ev):
        kind = ev.get("type")
        now = time.perf_counter()
        if kind in ("vad_speech_start", "vad_real_start", "processing_started", "response_generated",
                    "tts_streaming_started", "processing_error"):
            self.live = True
        # The toy listens all the time, so only show "listening" once the server hears speech.
        if kind in ("vad_speech_start", "vad_real_start"):
            if self.state != "talking":
                self.state = "listening"
        elif kind == "vad_misfire" and self.state == "listening":
            self.state = "idle"
        elif kind in ("processing_started", "transcription_complete"):
            if self.state != "talking":
                self.state = "thinking"
        elif kind == "response_generated":
            emotion = ev.get("emotion") if ev.get("emotion") in EMOTIONS else "neutral"
            self.singing = bool(ev.get("song"))
            self.friend = bool(ev.get("friend"))
            if self.singing:
                self.pending = (SING_LINE, "excited")
            elif self.friend:
                self.pending = ((ev.get("caption") or "MY FRIEND TIM") + " {heart}", "love")
            else:
                self.pending = (ticker_line(ev), emotion)
            self.talker.effect = "sing" if self.singing else ("friend" if self.friend else None)
        elif kind == "tts_streaming_started":
            self.audio_t0, self.audio_end = now + PLAY_DELAY, None
            self.levels, self.audio_pos, self.peak = [], 0.0, 0.05
            self._start_talking()
        elif kind == "tts_level":
            rms = float(ev.get("rms", 0))
            self.levels.append((self.audio_pos, rms))
            self.audio_pos += ev.get("bytes", 0) / BYTES_PER_SEC
            self.peak = max(self.peak, rms)
        elif kind == "tts_streaming_complete":
            seconds = ev.get("audioBytes", 0) / BYTES_PER_SEC or self.audio_pos
            self.audio_end = (self.audio_t0 or now) + seconds
            if self.talker.busy() and not self.singing:
                self._pace(self.audio_end - now)
        elif kind == "processing_error":
            self.state = "idle"
            self.talker.say("Oops! {question}", "sad")
        elif kind == "device_connected":
            self.talker.say("I'm SamSam! {star}", "excited")  # toy (re)connected: greet like at boot
        elif kind in ("response_complete", "ready") and self.pending:
            self._start_talking()  # audio events missing: still show the reply
        if kind != "tts_level":
            print(f"[event] {kind}" + (f"  {self.pending}" if kind == "response_generated" else ""))

    def _start_talking(self):
        if self.pending:
            self.line, emotion = self.pending
            self.pending = None
            self.passes = 1
            self.talker.say(self.line, emotion)
            self.talker.friend_since = 0 if self.friend else None
            if self.singing:
                self.talker.speed = SING_SPEED
            else:
                self._pace(len(self.line) / CHARS_PER_SEC)
        self.state = "talking"

    def _pace(self, seconds):
        """Scroll speed so the rest of the reply leaves the tower about when the voice ends."""
        width, _ = font.layout(self.talker.queue)
        remaining = self.talker.x + width
        speed = remaining / max(seconds, 0.5)
        self.talker.speed = min(MAX_SPEED, max(MIN_SPEED, speed))

    def _voice_playing(self, now):
        if self.audio_t0 is None:
            return False
        return self.audio_end is None or now < self.audio_end

    def _mouth(self, now):
        """Open when the voice at this playback moment is loud; None = no level data."""
        if not self.levels or self.audio_t0 is None:
            return None
        pos = now - self.audio_t0
        rms = 0.0
        for at, level in self.levels:
            if at > pos:
                break
            rms = level
        return rms > 0.35 * self.peak

    def tick(self):
        self.t += 1
        now = time.perf_counter()
        if self.state == "talking":
            playing = self._voice_playing(now)
            if playing and not self.talker.busy() and self.line and (self.singing or self.passes < MAX_PASSES):
                self.passes += 1
                self.talker.say(self.line, self.talker.emotion)
            self.talker.hold = playing
            self.talker.mouth = self._mouth(now) if playing else None
            if not playing and not self.talker.busy():
                self.state, self.audio_t0 = "idle", None
                self.talker.effect, self.singing = None, False
                self.friend, self.talker.friend_since = False, None
        if self.state in ("listening", "thinking") and not self.talker.busy() and self.talker.dy == 0:
            return self._waiting_frame()
        return self.talker.tick()

    def _waiting_frame(self):
        """Face stays put; listening = soft sound dots, thinking = three dots taking turns."""
        cv = Canvas()
        blink = self.t % 90 < 3
        cv.sprite(expression("neutral", False, blink), PALETTE)
        if self.state == "listening":
            for c, phase in ((1, 0), (4, 10), (7, 20)):
                k = (((self.t + phase) % 30) / 30)
                cv.add(1, c, hsv(0.5, 0.6), 0.9 * (1 - abs(2 * k - 1)))
        else:
            for i, c in enumerate((2, 4, 6)):
                k = 1.0 if (self.t // 10) % 3 == i else 0.35
                cv.set(0, c, (255 * k, 255 * k, 255 * k))
        return cv.frame()


async def listen(url, scene):
    while True:
        try:
            async with websockets.connect(url) as ws:
                print(f"[bridge] connected to {url}")
                async for msg in ws:
                    if isinstance(msg, (bytes, bytearray)):
                        continue
                    try:
                        scene.on_event(json.loads(msg))
                    except ValueError:
                        pass
        except (OSError, websockets.WebSocketException) as e:
            print(f"[bridge] monitor unavailable ({e}); retrying in 2 s")
            await asyncio.sleep(2)


async def render(display, scene, intro):
    period = 1 / FPS
    # Boot: logo, then SamSam introduces itself. A conversation starting mid-logo takes over at once.
    queue = []  # boot logo removed; SamSam greets straight away
    greeted = not intro
    next_t = time.perf_counter()
    while True:
        if queue and scene.live:
            queue, greeted = [], True
        if queue:
            frame = queue.pop(0)
        else:
            if not greeted:
                greeted = True
                scene.talker.say("I'm SamSam! {star}", "excited")
            frame = scene.tick()
        display.send(frame)
        next_t += period
        await asyncio.sleep(max(0.0, next_t - time.perf_counter()))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("instance")
    ap.add_argument("--monitor", default="ws://localhost:8899/monitor")
    ap.add_argument("--no-intro", action="store_true")
    ap.add_argument("--say", help="skip the server: show one line and exit after it scrolls")
    ap.add_argument("--emotion", default="excited")
    args = ap.parse_args()

    display = WebDisplay(args.instance)
    scene = Scene()
    print(f"[bridge] watch at https://sundai.willsarg.com/{args.instance}?view=river")

    if args.say:
        scene.talker.say(args.say, args.emotion)
        while scene.talker.busy() or scene.talker.dy > 0:
            display.send(scene.tick())
            await asyncio.sleep(1 / FPS)
        display.flush()
        return

    await asyncio.gather(listen(args.monitor, scene), render(display, scene, not args.no_intro))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
