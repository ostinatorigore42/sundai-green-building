"""Talking SamSam: the face slides down, words and icons scroll right-to-left above it, the mouth
moves and the face shows the reply's emotion with ambient effects. Afterwards it slides back up.
"""
from canvas import Canvas, COLS
import effects
import font
import friends
from samsam import expression, PALETTE

FPS = 30
TALK_DY = 4        # face offset while talking; floors 0-4 carry the words, floor 5 stays dark
SLIDE = 0.25       # floors per frame
LEAD_IN = 6        # blank columns before the words, so they arrive after the face has moved
TEXT_COLOR = (255, 245, 225)  # one warm white for every word: easiest to read from far away


class Talker:
    """Stateful renderer: call say() when a reply arrives, tick() once per frame.

    hold keeps the talking pose while audio is still playing after the words have scrolled;
    mouth, when not None, overrides the timer-driven mouth (e.g. from voice loudness).
    """

    def __init__(self, speed=12.0):
        self.speed = speed      # columns per second
        self.queue = ""
        self.x = float(COLS)    # scroll position of the text's left edge
        self.emotion = "neutral"
        self.dy = 0.0
        self.linger = 0         # frames to keep the emotion after talking ends
        self.hold = False
        self.mouth = None
        self.effect = None      # overrides the emotion's ambient effect, e.g. "sing"
        self.friend_since = None  # frames into the Tim the Beaver scene, None when not showing
        self.t = 0

    def say(self, text, emotion="neutral"):
        """Queue a line; if something is still scrolling it follows after a gap."""
        if self.busy():
            self.queue += "   " + text
        else:
            self.queue, self.x = text, float(COLS + LEAD_IN)
        self.emotion = emotion

    def busy(self):
        width, _ = font.layout(self.queue)
        return bool(self.queue) and self.x > -width

    def tick(self):
        cv = Canvas()
        self.t += 1
        busy = self.busy()
        speaking = busy or self.hold
        if speaking:
            self.linger = FPS
        elif self.linger:
            self.linger -= 1
        elif self.emotion != "neutral":
            self.emotion = "neutral"

        target = TALK_DY if speaking else 0
        self.dy += max(-SLIDE, min(SLIDE, target - self.dy))

        if self.mouth is not None and speaking:
            mouth_open = self.mouth
        else:
            mouth_open = speaking and (self.t // 5) % 2 == 1
        blink = not speaking and self.t % 90 < 3
        if self.friend_since is not None and speaking:
            friends.draw(cv, self.t, self.friend_since, mouth_open)
            self.friend_since += 1
        else:
            cv.sprite(expression(self.emotion, mouth_open, blink), PALETTE, dy=round(self.dy))

        if busy:
            width, cells = font.layout(self.queue)
            for r, c, i, rgb in cells:
                cv.set(r, round(self.x) + c, rgb or TEXT_COLOR)
            self.x -= self.speed / FPS

        effects.draw(cv, self.effect or self.emotion, self.t, strength=1.0 if speaking else self.linger / FPS)
        return cv.frame()


SAMPLE = [
    ("Hi! I'm SamSam! {star}", "excited"),
    ("I love space {heart} {rocket}", "love"),
    ("I lost my rocket... {moon}", "sad"),
    ("Hey! My ears! {exclaim}", "angry"),
    ("Let's play! {smile}", "neutral"),
]


def demo(lines=SAMPLE, pause=45):
    """Frames for a scripted conversation: each line scrolls, SamSam settles, then the next."""
    talker = Talker()
    out = []
    for text, emotion in lines:
        talker.say(text, emotion)
        while talker.busy():
            out.append(talker.tick())
        out.extend(talker.tick() for _ in range(pause))
    return out
