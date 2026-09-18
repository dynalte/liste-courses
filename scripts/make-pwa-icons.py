#!/usr/bin/env python3
"""Génère les icônes PWA (192/512 + maskable + apple-touch + favicon).

Panier stylisé : fond dégradé émeraude→cyan, panier blanc, pastille ambre.
Usage : python3 scripts/make-pwa-icons.py  (sortie dans public/)
"""
from PIL import Image, ImageDraw

OUT = "public"

BG_TOP = (52, 211, 153)      # émeraude
BG_BOTTOM = (34, 211, 238)   # cyan
DARK = (15, 17, 32)          # fond app
WHITE = (255, 255, 255)
AMBER = (251, 191, 36)


def rounded_bg(size: int, radius_ratio: float = 0.225) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # dégradé vertical en bandes fines
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel((0, y), tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=int(size * radius_ratio), fill=255)
    img.paste(grad.resize((size, size)), (0, 0), mask)
    return img


def draw_cart(draw: ImageDraw.ImageDraw, s: int, white=WHITE) -> None:
    u = s / 100.0  # unité
    # anse
    draw.line([28 * u, 30 * u, 20 * u, 18 * u], fill=white, width=int(6 * u))
    draw.line([20 * u, 18 * u, 30 * u, 18 * u], fill=white, width=int(6 * u))
    # panier (trapèze)
    draw.polygon([(26 * u, 32 * u), (74 * u, 32 * u), (66 * u, 66 * u), (34 * u, 66 * u)], fill=white)
    # rainures du panier (fond transparent -> on repeint avec la couleur du fond via masque : simplifié en foncé)
    for x in (40, 50, 60):
        draw.line([x * u, 36 * u, (x - 4) * u, 62 * u], fill=DARK, width=int(3.5 * u))
    # roues
    for cx in (38, 62):
        draw.ellipse([cx * u - 5 * u, 70 * u - 5 * u, cx * u + 5 * u, 70 * u + 5 * u], fill=white)
    # pastille "plein" ambre
    draw.ellipse([66 * u, 14 * u, 84 * u, 32 * u], fill=AMBER)
    draw.ellipse([71.5 * u, 19.5 * u, 78.5 * u, 26.5 * u], fill=DARK)


def make_icon(size: int, maskable: bool = False) -> Image.Image:
    if maskable:
        # fond plein (safe zone : motif centré à 66 %)
        img = Image.new("RGBA", (size, size), BG_TOP + (255,))
        grad = Image.new("RGB", (1, size))
        for y in range(size):
            t = y / max(size - 1, 1)
            grad.putpixel((0, y), tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
        img.paste(grad.resize((size, size)), (0, 0))
        inner = int(size * 0.66)
        off = (size - inner) // 2
        art = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
        draw_cart(ImageDraw.Draw(art), inner)
        img.alpha_composite(art, (off, off))
        return img.convert("RGB")
    img = rounded_bg(size)
    draw_cart(ImageDraw.Draw(img), size)
    return img


def main() -> None:
    import os
    os.makedirs(OUT, exist_ok=True)
    make_icon(192).save(f"{OUT}/pwa-192x192.png")
    make_icon(512).save(f"{OUT}/pwa-512x512.png")
    make_icon(512, maskable=True).save(f"{OUT}/pwa-maskable-512x512.png")
    make_icon(180).save(f"{OUT}/apple-touch-icon.png")
    make_icon(64).save(f"{OUT}/favicon.png")
    print("icônes PWA générées dans public/")


if __name__ == "__main__":
    main()
