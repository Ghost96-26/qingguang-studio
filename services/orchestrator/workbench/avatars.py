"""Small, local-only identity images; never retain supplied URLs or metadata."""
from __future__ import annotations

import base64
import binascii
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError


def normalize_avatar(value: str) -> str:
    if not value:
        return ""
    if len(value) > 400_000 or "," not in value:
        raise ValueError("头像文件过大或格式无效")
    header, encoded = value.split(",", 1)
    if header not in {"data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"}:
        raise ValueError("头像仅支持 PNG、JPEG 或 WebP，不支持网址与 SVG")
    try:
        payload = base64.b64decode(encoded, validate=True)
        with Image.open(BytesIO(payload)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"} or source.width * source.height > 4_000_000:
                raise ValueError("头像尺寸过大或格式无效")
            image = ImageOps.fit(ImageOps.exif_transpose(source).convert("RGB"), (128, 128), method=Image.Resampling.LANCZOS)
            # A new pixel-only image strips EXIF, filenames and embedded metadata.
            clean = Image.new("RGB", image.size)
            clean.paste(image)
            output = BytesIO()
            clean.save(output, format="PNG")
    except (binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("无法读取头像图片") from exc
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
