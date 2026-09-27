"""Friend scene: SamSam shrinks to the left half of the tower and Tim the Beaver (MIT's mascot)
slides in on the right. Both are small enough to share the 9 columns under the scrolling words.
"""
from samsam import PALETTE

TIM = {
    "D": (125, 75, 35),    # brown fur
    "T": (205, 150, 95),   # tan muzzle
    "K": (25, 15, 20),     # eyes, nose
    "W": (245, 245, 235),  # buck teeth
    "R": (175, 30, 50),    # MIT cardinal shirt
}

# 5 wide: ears, stripe, eyes, blush + nose, mouth, chin, suit.
MINI_CAT = [
    "Y...Y",
    "YYOYY",
    "YKYKY",
    "BYNYB",
    "YYKYY",
    ".YYY.",
    ".WWW.",
    "WWWWW",
    "WW.WW",
]
MINI_CAT_TALK = MINI_CAT[:4] + ["YKKKY"] + MINI_CAT[5:]

# 4 wide: round ears, eyes, nose on a tan muzzle, buck teeth, red shirt, feet.
TIM_ART = [
    "D..D",
    "DDDD",
    "KDDK",
    "TKKT",
    "TWWT",
    "RRRR",
    "DRRD",
    "RRRR",
    "D..D",
]
# Tim waves: one arm raised beside his head.
TIM_WAVE = TIM_ART[:5] + ["RRRD", "DRRR"] + TIM_ART[7:]

TOP = 7  # first floor of the characters; words scroll on floors 0-4


def _sprite(cv, art, palette, dy, dx, alpha=1.0):
    for r, line in enumerate(art):
        for c, ch in enumerate(line):
            if ch in palette:
                col = palette[ch]
                rgb = (col.r, col.g, col.b) if hasattr(col, "r") else col
                cv.set(dy + r, dx + c, rgb, alpha)


def draw(cv, t, since, mouth_open):
    """since = frames since the friend scene began; SamSam slides left, Tim slides in from the right."""
    k = min(1.0, since / 15)
    cat_dx = round(2 * (1 - k))            # starts centred, settles at the left edge
    tim_dx = 5 + round(5 * (1 - k))        # starts off the right edge, settles at column 5
    _sprite(cv, MINI_CAT_TALK if mouth_open else MINI_CAT, PALETTE, TOP, cat_dx)
    _sprite(cv, TIM_WAVE if (t // 12) % 2 else TIM_ART, TIM, TOP, tim_dx)
