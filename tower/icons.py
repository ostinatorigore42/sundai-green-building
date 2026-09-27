"""5x5 pixel icons for the tower ticker, named to match server-tetris's icon list."""
import re

COLORS = {
    "H": (255, 80, 150),   # heart pink
    "Y": (255, 215, 40),   # yellow
    "O": (255, 130, 20),   # orange
    "W": (240, 240, 235),  # white
    "R": (230, 40, 40),    # red
    "C": (60, 200, 255),   # cyan
    "P": (160, 90, 255),   # purple
    "L": (255, 245, 170),  # pale moon
    "K": (30, 20, 40),     # dark detail
    "G": (80, 230, 110),   # green
}

ICONS = {
    "heart":    [".H.H.", "HHHHH", "HHHHH", ".HHH.", "..H.."],
    "star":     ["..Y..", ".YYY.", "YYYYY", ".YYY.", ".Y.Y."],
    "rocket":   ["..W..", ".WWW.", ".WCW.", "RWWWR", "..O.."],
    "planet":   [".PPP.", "PPPPP", "YYYYY", "PPPPP", ".PPP."],
    "moon":     [".LLL.", "LL...", "LL...", "LL...", ".LLL."],
    "sun":      ["Y.Y.Y", ".OOO.", "YOOOY", ".OOO.", "Y.Y.Y"],
    "music":    ["..CCC", "..C..", "..C..", "CCC..", "CCC.."],
    "paw":      ["H.H.H", ".....", ".HHH.", "HHHHH", ".HHH."],
    "sparkle":  ["..Y..", "..Y..", "YYWYY", "..Y..", "..Y.."],
    "smile":    [".YYY.", "YKYKY", "YYYYY", "YKKKY", ".YYY."],
    "question": [".GGG.", "...G.", "..G..", ".....", "..G.."],
    "exclaim":  ["..R..", "..R..", "..R..", ".....", "..R.."],
}

# Fallback when the server sends no icons: pick from words in the reply.
KEYWORDS = {
    "heart": r"love|heart|hug|friend|kind|care",
    "rocket": r"rocket|space|launch|fly|astronaut",
    "star": r"star|great|awesome|amazing|super|wow",
    "planet": r"planet|mars|saturn|jupiter|galaxy|universe",
    "moon": r"moon|night|sleep|dream|bed",
    "sun": r"sun|day|morning|warm|summer|bright",
    "music": r"music|song|sing|dance",
    "paw": r"cat|dog|kitty|puppy|pet|animal|paw",
    "sparkle": r"magic|sparkle|shine|surprise",
    "smile": r"happy|fun|laugh|joke|smile|play",
    "question": r"\?",
}


def from_text(text, limit=3):
    found = []
    for name, pattern in KEYWORDS.items():
        if re.search(pattern, text, re.IGNORECASE):
            found.append(name)
        if len(found) == limit:
            break
    return found
