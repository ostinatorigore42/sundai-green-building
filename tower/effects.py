"""Emotion ambience around SamSam, drawn only on unlit windows so the face and words stay clean.

Everything moves or fades slowly (no on/off flashing): photosensitivity rule for the tower.
"""
import math

from canvas import ROWS, COLS, hsv

SIDES = (0, COLS - 1)


def _free(cv, r, c):
    return 0 <= r < ROWS and 0 <= c < COLS and sum(cv.px[r][c]) < 60


def _put(cv, r, c, rgb, k):
    if _free(cv, r, c):
        cv.add(r, c, rgb, k)


def _rise(cv, t, rgb, speed, spacing, fade_top=True):
    """Particles drifting up both side columns, staggered."""
    for side_i, c in enumerate(SIDES):
        for n in range(3):
            y = ROWS - 1 - ((t * speed + n * spacing + side_i * spacing / 2) % (ROWS + 2))
            r = math.floor(y)
            frac = y - r
            k = 0.9 * (min(1.0, (y + 1) / 4) if fade_top else 1.0)
            _put(cv, r, c, rgb, k * (1 - frac))
            _put(cv, r + 1, c, rgb, k * frac)


def _fall(cv, t, rgb, speed, spacing):
    for side_i, c in enumerate(SIDES):
        for n in range(3):
            y = (t * speed + n * spacing + side_i * spacing / 2) % (ROWS + 2) - 1
            r = math.floor(y)
            frac = y - r
            _put(cv, r, c, rgb, 0.8 * (1 - frac))
            _put(cv, r + 1, c, rgb, 0.8 * frac)


def draw(cv, emotion, t, strength=1.0):
    if strength <= 0:
        return
    if emotion == "love":        # pink hearts float up the sides
        _rise(cv, t, tuple(v * strength for v in (255, 80, 150)), speed=0.12, spacing=6)
    elif emotion == "excited":   # rainbow sparkles twinkling in free windows
        for i in range(10):
            r = (i * 7 + 3) % ROWS
            c = (i * 5 + 1) % COLS
            k = max(0.0, math.sin(2 * math.pi * (t / 40 + i / 10))) ** 2
            _put(cv, r, c, hsv(i / 10 + t / 200, 0.8), k * strength)
    elif emotion == "sad":       # slow blue raindrops down the sides
        _fall(cv, t, tuple(v * strength for v in (70, 150, 255)), speed=0.18, spacing=6)
    elif emotion == "angry":     # red-orange steam puffs rising
        _rise(cv, t, tuple(v * strength for v in (255, 70, 20)), speed=0.2, spacing=5)
    elif emotion == "sing":      # rainbow notes floating up both sides
        for side_i, c in enumerate(SIDES):
            for n in range(4):
                y = ROWS - 1 - ((t * 0.15 + n * 4.5 + side_i * 2.25) % (ROWS + 2))
                r = round(y)
                _put(cv, r, c, hsv(n / 4 + side_i / 8 + t / 120, 0.8), 0.9 * strength * min(1.0, (y + 1) / 4))
