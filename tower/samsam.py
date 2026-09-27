"""SamSam, the astronaut cat, pixelled for the Green Building's 17 x 9 window display.

Only uses Frame and Color, so it runs unchanged on the real building.
"""
import math

from gbsim import Frame, Color

from canvas import Canvas

# Palette sampled from the plush. '.' is an unlit window.
PALETTE = {
    "Y": Color(245, 170, 20),   # fur
    "O": Color(230, 90, 10),    # forehead stripes
    "W": Color(235, 235, 225),  # suit, headphone band, whites of the eyes
    "A": Color(170, 170, 160),  # sleeves, a shade darker so arms separate from the body
    "G": Color(110, 110, 120),  # headphone cups, cuffs, paw pads, zipper
    "K": Color(20, 10, 30),     # pupils, mouth (reads as a dark window)
    "P": Color(240, 110, 90),   # nose
    "S": Color(90, 60, 200),    # space mission patch
    "R": Color(220, 40, 40),    # rocket badge
    "B": Color(255, 90, 160),   # blush cheeks, inner ears, tongue
    "N": Color(200, 70, 60),    # small nose on the cute face
    "C": Color(90, 180, 255),   # tear
}

# Row 0 is the top floor. The last row stays empty so SamSam can bob.
IDLE = [
    ".Y.WWW.Y.",
    "WYOYOYOYW",
    "GYYYYYYYG",
    "GYWKYWKYG",
    "WYKKYKKYW",
    ".YYYPYYY.",
    ".YYKYKYY.",
    "..WWWWW..",
    ".AWWWWWA.",
    "AWSWWGWWA",
    "AWWWWGWWA",
    "GWWWRWWWG",
    "WWWWWWWWW",
    ".WWWWWWW.",
    ".WWW.WWW.",
    ".WGW.WGW.",
    ".........",
]

# Eyes closed: pupils become a line of fur with a dark lid.
BLINK = IDLE[:3] + [
    "GYYYYYYYG",
    "WYKKYKKYW",
] + IDLE[5:]

# Mouth open for talking.
TALK = IDLE[:6] + [
    ".YYKKKYY.",
] + IDLE[7:]

# --- Face-only variations: no suit, so the face can use the full 9 columns.

# Compact face centred on the tower; headphone band over the head, cups hidden.
FACE = [
    ".........",
    ".........",
    ".........",
    ".Y.....Y.",
    "YYWWWWWYY",
    "YYOYOYOYY",
    "YYYYYYYYY",
    "YWKYYYWKY",
    "YKKYYYKKY",
    "YYYYPYYYY",
    "YYYKYKYYY",
    ".YYYYYYY.",
    "..WWWWW..",
    ".........",
    ".........",
    ".........",
    ".........",
]

FACE_BLINK = FACE[:7] + [
    "YYYYYYYYY",
    "YKKYYYKKY",
] + FACE[9:]

FACE_TALK = FACE[:10] + [
    "YYYKKKYYY",
] + FACE[11:]

# Tall face filling the tower: headphone arc and cups, big 3-floor eyes.
FACE_TALL = [
    "..WWWWW..",
    ".W.....W.",
    "WYY...YYW",
    "GYYYYYYYG",
    "GYOYOYOYG",
    "GYYYYYYYG",
    "YWKYYYWKY",
    "YKKYYYKKY",
    "YKKYYYKKY",
    "YYYYPYYYY",
    "YYYKYKYYY",
    "YYYYYYYYY",
    ".YYYYYYY.",
    "..WWWWW..",
    ".........",
    ".........",
    ".........",
]

FACE_TALL_BLINK = FACE_TALL[:6] + [
    "YYYYYYYYY",
    "YYYYYYYYY",
    "YKKYYYKKY",
] + FACE_TALL[9:]

# --- Cute face: pink inner ears, blush, cat "w" mouth under the nose, rounder chin, tiny shoulders.
CUTE = [
    ".........",
    ".........",
    ".Y.....Y.",
    ".YB...BY.",
    "YYYYYYYYY",   # was a white headphone band; all-orange head reads better
    "YYOYOYOYY",
    "YYYYYYYYY",
    "YWKYYYWKY",
    "YKKYYYKKY",
    "YBYYNYYBY",
    "YYKYKYKYY",
    ".YYKYKYY.",
    "..YYYYY..",
    "..WWWWW..",
    ".WWWWWWW.",
    ".........",
    ".........",
]
CUTE_EYES = 7    # first eye row
CUTE_MOUTH = 10  # first mouth row

CUTE_BLINK = CUTE[:CUTE_EYES] + [
    "YYYYYYYYY",
    "YKKYYYKKY",
] + CUTE[CUTE_EYES + 2:]

# Open mouth with a pink tongue.
CUTE_TALK = CUTE[:CUTE_MOUTH] + [
    "YYYKKKYYY",
    ".YYKBKYY.",
] + CUTE[CUTE_MOUTH + 2:]

# ^ ^ eyes and open smile.
CUTE_HAPPY = CUTE[:CUTE_EYES] + [
    "YYKYYYKYY",
    "YKYKYKYKY",
] + CUTE[CUTE_EYES + 2:CUTE_MOUTH] + [
    "YYYKKKYYY",
    ".YYKBKYY.",
] + CUTE[CUTE_MOUTH + 2:]

# --- Emotions, matching the toy server's tags: neutral | excited | love | sad | angry.
# Each overrides rows of CUTE: 6 = brow line, 7-8 = eyes, 9 = cheeks + nose, 10-11 = mouth.
_OPEN = ["YYYKKKYYY", ".YYKBKYY."]
EMOTIONS = {
    "neutral": {
        "eyes": ["YWKYYYWKY", "YKKYYYKKY"],
        "closed": ["YYKYKYKYY", ".YYKYKYY."],
        "open": _OPEN,
    },
    "excited": {
        "eyes": ["YYKYYYKYY", "YKYKYKYKY"],      # ^ ^
        "closed": ["YYKYYYKYY", ".YYKKKYY."],    # smile
        "open": _OPEN,
    },
    "love": {
        "eyes": ["YBYBYBYBY", "YYBYYYBYY"],      # pink heart eyes
        "closed": ["YYKYYYKYY", ".YYKKKYY."],
        "open": _OPEN,
    },
    "sad": {
        "eyes": ["YYYYYYYYY", "YKKYYYKKY"],      # lowered lids
        "cheeks": "YCYYNYYBY",                   # tear under the left eye
        "closed": ["YYYYKYYYY", ".YYKYKYY."],    # frown
        "open": ["YYYYKYYYY", ".YYKKKYY."],
    },
    "angry": {
        "brow": "YKYYYYYKY",
        "eyes": ["YYKYYYKYY", "YKKYYYKKY"],      # brows slope down to the middle, squint
        "cheeks": "YRYYNYYRY",
        "closed": ["YYYYYYYYY", ".YYKKKYY."],    # flat line
        "open": ["YYKKKKKYY", ".YYKBKYY."],
    },
}


def expression(emotion="neutral", mouth_open=False, blink=False):
    """Cute face art for an emotion; unknown emotions fall back to neutral."""
    e = EMOTIONS.get(emotion, EMOTIONS["neutral"])
    art = list(CUTE)
    if "brow" in e:
        art[6] = e["brow"]
    art[7:9] = ["YYYYYYYYY", "YKKYYYKKY"] if blink else e["eyes"]
    if "cheeks" in e:
        art[9] = e["cheeks"]
    art[10:12] = e["open"] if mouth_open else e["closed"]
    return art


def draw(art, frame=None, dy=0):
    """Paint a text sprite onto a frame, shifted down by dy floors."""
    frame = frame if frame is not None else Frame()
    for r, line in enumerate(art):
        row = r + dy
        if not 0 <= row < frame.nrows():
            continue
        for c, ch in enumerate(line):
            if ch in PALETTE:
                frame[row][c] = PALETTE[ch]
    return frame


def idle_loop(idle=IDLE, blink=BLINK):
    """Gentle bob with a blink: 60 frames, meant for 12 fps."""
    frames = []
    for t in range(60):
        dy = 1 if (t // 15) % 2 else 0
        art = blink if t in (40, 41) else idle
        frames.append(draw(art, dy=dy))
    return frames


def cute_idle_loop():
    """Cute face bobbing, blinking, with two soft twinkles beside the ears. 60 frames at 12 fps."""
    frames = []
    for t in range(60):
        cv = Canvas()
        dy = 1 if (t // 15) % 2 else 0
        cv.sprite(CUTE_BLINK if t in (40, 41) else CUTE, PALETTE, dy=dy)
        # Twinkles fade in and out slowly (one full cycle per loop), half a cycle apart.
        for (r, c), phase in (((1, 0), 0.0), ((0, 8), 0.5)):
            k = max(0.0, math.sin(2 * math.pi * (t / 60 + phase))) ** 2
            cv.add(r, c, (255, 240, 200), k)
        frames.append(cv.frame())
    return frames
