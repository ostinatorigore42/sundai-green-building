"""Float RGB canvas for blending effects, converted to a Frame only when sending."""
import colorsys

from gbsim import Frame, Color

ROWS, COLS = 17, 9


def hsv(h, s=1.0, v=1.0):
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (r * 255, g * 255, b * 255)


class Canvas:
    def __init__(self):
        self.px = [[(0.0, 0.0, 0.0) for _ in range(COLS)] for _ in range(ROWS)]

    def set(self, r, c, rgb, alpha=1.0):
        """Blend rgb over the cell; out-of-bounds cells are ignored."""
        if 0 <= r < ROWS and 0 <= c < COLS:
            old = self.px[r][c]
            self.px[r][c] = tuple(o + (n - o) * alpha for o, n in zip(old, rgb))

    def add(self, r, c, rgb, k=1.0):
        """Additive light, for sparkles and particles."""
        if 0 <= r < ROWS and 0 <= c < COLS:
            self.px[r][c] = tuple(o + n * k for o, n in zip(self.px[r][c], rgb))

    def sprite(self, art, palette, dy=0, dx=0, alpha=1.0):
        for r, line in enumerate(art):
            for c, ch in enumerate(line):
                if ch in palette:
                    col = palette[ch]
                    self.set(r + dy, c + dx, (col.r, col.g, col.b), alpha)

    def frame(self):
        f = Frame()
        for r in range(ROWS):
            for c in range(COLS):
                f[r][c] = Color(*self.px[r][c])  # Color clamps to 0..255
        return f
