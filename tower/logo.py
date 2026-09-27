"""SamSam logo for the tower: white teddy bear on black, then the SAMSAM wordmark on one screen
(SAM over SAM, with the orange rocket A).
"""
from canvas import Canvas

FPS = 30
WHITE = (255, 250, 250)
ORANGE = (255, 150, 20)

# '#' is white; '.' stays dark, like the logo's cut-outs.
BEAR = [
    ".##...##.",   # short round ears (tall ears read as a bunny)
    "#########",   # wide head
    "#########",
    "##.###.##",   # eyes
    "#########",
    "###.#.###",   # nose inside the muzzle
    ".##...##.",
    "..#####..",   # chin
    ".##.#.##.",   # heart
    "###...###",
    "####.####",
    ".###.###.",
    "####.####",   # feet, heart tip runs down between them
]

# SAMSAM fits one screen as two lines of SAM. Letters are 2 + 3 + 3 columns with a gap after the S;
# the A and M touch, so the A is orange to keep them apart.
WORD_S = ["##", "#.", "##", ".#", "##"]
WORD_A = [".#.", "#.#", "###", "#.#", "#.#"]
WORD_M = ["#.#", "###", "###", "#.#", "#.#"]
WORD_LINES = (2, 10)  # top floor of each SAM


def wordmark_cells():
    """(row, col, letter) for both lines; letter is 'S', 'A' or 'M'."""
    cells = []
    for top in WORD_LINES:
        for glyph, left, letter in ((WORD_S, 0, "S"), (WORD_A, 3, "A"), (WORD_M, 6, "M")):
            for r, line in enumerate(glyph):
                for c, ch in enumerate(line):
                    if ch == "#":
                        cells.append((top + r, left + c, letter))
    return cells


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def bear(cv, art, dy, alpha=1.0):
    for r, line in enumerate(art):
        for c, ch in enumerate(line):
            if ch == "#":
                cv.set(r + dy, c, WHITE, alpha)


def wordmark(cv, alpha=1.0):
    for r, c, letter in wordmark_cells():
        cv.set(r, c, ORANGE if letter == "A" else WHITE, alpha)


def card():
    cv = Canvas()
    bear(cv, BEAR, dy=2)
    return cv.frame()


def wordmark_card():
    cv = Canvas()
    wordmark(cv)
    return cv.frame()


def frames():
    """Bear fades in and holds, cross-fades to SAMSAM, holds, fades out. About 8 seconds."""
    out = []

    def add(fn, n):
        for i in range(n):
            cv = Canvas()
            fn(cv, i, n)
            out.append(cv.frame())

    add(lambda cv, i, n: bear(cv, BEAR, 2, ease(i / 25)), 75)                      # fade in + hold
    add(lambda cv, i, n: (bear(cv, BEAR, 2, 1 - ease(i / (n - 1))),
                          wordmark(cv, ease(i / (n - 1)))), 20)                      # cross-fade
    add(lambda cv, i, n: wordmark(cv), 90)                                           # hold SAMSAM
    add(lambda cv, i, n: wordmark(cv, 1 - ease(i / (n - 1))), 30)                    # fade out
    return out
