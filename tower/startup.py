"""Colourful SamSam intro for the 17 x 9 tower, rendered as a list of Frames at 30 fps.

sparkles -> rainbow rises -> rainbow drains leaving SAM / SAM on one screen
-> letters burst into confetti -> SamSam fades in.

Photosensitivity: every change is a fade or a slide; no full-tower on/off flashing.
"""
import math
import random

from canvas import Canvas, hsv, ROWS, COLS
from logo import wordmark_cells
from samsam import CUTE, CUTE_HAPPY, PALETTE

FPS = 30

# One hue per letter: top SAM pink / amber / cyan, bottom SAM green / orange / violet.
HUES = {(0, "S"): 0.92, (0, "A"): 0.14, (0, "M"): 0.50, (1, "S"): 0.33, (1, "A"): 0.07, (1, "M"): 0.76}


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def sam_cells():
    """Lit cells of SAM / SAM as (row, col, hue)."""
    return [(r, c, HUES[(0 if r < 9 else 1, letter)]) for r, c, letter in wordmark_cells()]


def draw_sam(cv, t, alpha=1.0):
    """Both SAMs, each letter's hue drifting gently."""
    for r, c, hue in sam_cells():
        h = hue + 0.04 * math.sin(2 * math.pi * (t / 45 + hue))
        cv.set(r, c, hsv(h, 0.85), alpha)


def rainbow(r, c, t):
    return hsv((r + 0.5 * c) / 17 - t / 60, 0.9)


def frames(seed=54):
    rng = random.Random(seed)
    twinkle = [[(rng.random(), rng.random()) for _ in range(COLS)] for _ in range(ROWS)]
    out = []

    def phase(n, fn):
        for i in range(n):
            cv = Canvas()
            fn(cv, i, n, len(out))
            out.append(cv.frame())

    # 1. Sparkles: every window twinkles in its own colour, slowly fading up.
    def sparkles(cv, i, n, t, fade=None):
        env = ease(i / 20) if fade is None else fade
        for r in range(ROWS):
            for c in range(COLS):
                hue, ph = twinkle[r][c]
                k = max(0.0, math.sin(2 * math.pi * (t / 36 + ph))) ** 3
                cv.add(r, c, hsv(hue, 0.8), 0.9 * k * env)
    phase(40, sparkles)

    # 2. Rainbow rises from the plaza to the roof, sparkles fade out behind it.
    def rise(cv, i, n, t):
        sparkles(cv, i, n, t, fade=1 - ease(i / n))
        front = ROWS - (ROWS + 2) * ease(i / n)
        for r in range(ROWS):
            k = ease(r - front + 1)
            for c in range(COLS):
                cv.set(r, c, rainbow(r, c, t), k)
    phase(30, rise)

    # 3. Rainbow drains top to bottom, leaving SAM / SAM cut out of it.
    def drain(cv, i, n, t):
        line = (ROWS + 2) * ease(i / n)
        draw_sam(cv, t)
        for r in range(ROWS):
            k = ease(r - line + 1)  # 1 = still rainbow, 0 = drained
            for c in range(COLS):
                cv.set(r, c, rainbow(r, c, t), k)
    phase(30, drain)

    # 4. Hold SAMSAM on one screen.
    phase(90, lambda cv, i, n, t: draw_sam(cv, t))

    # 5. Letters burst into confetti that drifts down and fades; SamSam fades in underneath.
    particles = []
    for r, c, hue in sam_cells():
        angle = rng.uniform(0, 2 * math.pi)
        speed = rng.uniform(0.15, 0.45)
        particles.append([r, c, math.sin(angle) * speed - 0.2, math.cos(angle) * speed * 0.6, hue])

    def burst(cv, i, n, t):
        cv.sprite(CUTE, PALETTE, alpha=ease((i - 25) / 30))
        fade = 1 - ease((i - 20) / 40)
        for p in particles:
            p[0] += p[2]
            p[1] += p[3]
            p[2] += 0.012  # gravity
            cv.add(round(p[0]), round(p[1]), hsv(p[4] + i / 90, 0.85), fade)
    phase(60, burst)

    # 6. SamSam smiles ^^ for a beat, then settles into the normal face.
    def hello(cv, i, n, t):
        cv.sprite(CUTE_HAPPY if i < 30 else CUTE, PALETTE)
    phase(45, hello)

    return out
