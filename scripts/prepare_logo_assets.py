from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "dashboard" / "assets"
SOURCE = ASSETS / "maxcellent-logo.png"
THEME_BG = (245, 245, 247, 255)


def content_box(image: Image.Image) -> tuple[int, int, int, int]:
    rgb = image.convert("RGB")
    white = Image.new("RGB", rgb.size, "white")
    diff = ImageChops.difference(rgb, white).convert("L")
    mask = diff.point(lambda value: 255 if value > 16 else 0)
    box = mask.getbbox()
    if not box:
        return (0, 0, image.width, image.height)
    left, top, right, bottom = box
    pad_x = 10
    pad_y = 8
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(image.width, right + pad_x),
        min(image.height, bottom + pad_y),
    )


def make_transparent_logo(cropped: Image.Image, scale: int = 4) -> Image.Image:
    rgba = cropped.convert("RGBA")
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            whiteness = min(r, g, b)
            if r > 235 and g > 235 and b > 235:
                pixels[x, y] = (r, g, b, 0)
            elif whiteness > 215:
                alpha = max(0, min(255, (255 - whiteness) * 6))
                pixels[x, y] = (r, g, b, min(a, alpha))
    size = (rgba.width * scale, rgba.height * scale)
    return rgba.resize(size, Image.Resampling.LANCZOS)


def make_logo_card(wordmark: Image.Image) -> Image.Image:
    width = 760
    height = 220
    canvas = Image.new("RGBA", (width, height), THEME_BG)
    max_w = 660
    max_h = 150
    logo = wordmark.copy()
    logo.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    x = (width - logo.width) // 2
    y = (height - logo.height) // 2
    canvas.alpha_composite(logo, (x, y))
    return canvas


def make_clean_logo(cropped: Image.Image, scale: int = 4) -> Image.Image:
    rgba = cropped.convert("RGBA")
    width, height = rgba.size
    logo = rgba.resize((width * scale, height * scale), Image.Resampling.LANCZOS)
    return logo.filter(ImageFilter.UnsharpMask(radius=1.0, percent=120, threshold=2))


def make_theme_logo(cropped: Image.Image, scale: int = 4) -> Image.Image:
    logo = make_clean_logo(cropped, scale)
    canvas = Image.new("RGBA", logo.size, THEME_BG)
    canvas.alpha_composite(logo)
    return canvas.convert("RGB")


def make_favicon(source: Image.Image) -> Image.Image:
    card = ImageOps.contain(source.convert("RGBA"), (512, 512), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (512, 512), THEME_BG)
    x = (512 - card.width) // 2
    y = (512 - card.height) // 2
    canvas.alpha_composite(card, (x, y))
    return canvas


def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE)
    cropped = source.crop(content_box(source))
    cropped.save(ASSETS / "maxcellent-logo-cropped-source.png")

    clean = make_clean_logo(cropped)
    clean.save(ASSETS / "maxcellent-logo-clean.png")

    theme_logo = make_theme_logo(cropped)
    theme_logo.save(ASSETS / "maxcellent-logo-on-theme.png")
    theme_logo.save(ASSETS / "maxcellent-logo-sharp.png")

    wordmark = make_transparent_logo(cropped)
    wordmark.save(ASSETS / "maxcellent-logo-wordmark.png")

    card = make_logo_card(wordmark)
    card.save(ASSETS / "maxcellent-logo-card.png")

    favicon = make_favicon(source)
    favicon.save(ASSETS / "maxcellent-favicon.png")

    print(f"source: {source.size}")
    print(f"cropped: {cropped.size}")
    print(f"clean: {clean.size}")
    print(f"theme logo: {theme_logo.size}")
    print(f"wordmark: {wordmark.size}")
    print(f"card: {card.size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
