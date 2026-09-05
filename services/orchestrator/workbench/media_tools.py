from __future__ import annotations

import json
import mimetypes
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".avif"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpeg", ".mpg"}
AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".wma"}


def ffprobe_path(ffmpeg_executable: str | Path) -> Path:
    ffmpeg = Path(ffmpeg_executable)
    candidate = ffmpeg.with_name("ffprobe.exe" if ffmpeg.suffix.lower() == ".exe" else "ffprobe")
    if not candidate.is_file():
        raise RuntimeError(f"ffprobe is missing beside ffmpeg: {candidate}")
    return candidate


def _fraction(value: Any) -> float | None:
    text = str(value or "").strip()
    if not text or text in {"0/0", "N/A"}:
        return None
    try:
        if "/" in text:
            numerator, denominator = text.split("/", 1)
            return round(float(numerator) / float(denominator), 4) if float(denominator) else None
        return round(float(text), 4)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def inspect_media(path: str | Path, ffmpeg_executable: str | Path) -> dict[str, Any]:
    source = Path(path)
    if not source.is_file():
        raise ValueError(f"Media file does not exist: {source}")
    probe = ffprobe_path(ffmpeg_executable)
    completed = subprocess.run(
        [
            str(probe), "-v", "error", "-show_entries",
            "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,channel_layout,bit_rate",
            "-of", "json", str(source),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=45,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )
    if completed.returncode != 0:
        message = (completed.stderr or "ffprobe could not read this file").strip()
        raise ValueError(f"Unsupported or damaged media file: {source.name}. {message[-500:]}")
    payload = json.loads(completed.stdout or "{}")
    streams = payload.get("streams") or []
    fmt = payload.get("format") or {}
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio_stream = next((item for item in streams if item.get("codec_type") == "audio"), None)
    suffix = source.suffix.lower()
    if video_stream and suffix in IMAGE_SUFFIXES:
        kind = "image"
    elif video_stream:
        kind = "video"
    elif audio_stream:
        kind = "audio"
    else:
        guessed = mimetypes.guess_type(source.name)[0] or ""
        kind = guessed.split("/", 1)[0] if guessed.startswith(("image/", "video/", "audio/", "text/")) else "file"

    width = int(video_stream.get("width") or 0) if video_stream else 0
    height = int(video_stream.get("height") or 0) if video_stream else 0
    duration = _fraction(fmt.get("duration"))
    frame_rate = _fraction((video_stream or {}).get("avg_frame_rate")) or _fraction((video_stream or {}).get("r_frame_rate"))
    metadata: dict[str, Any] = {
        "probed_at": datetime.now(timezone.utc).isoformat(),
        "kind": kind,
        "container": fmt.get("format_name"),
        "size_bytes": int(fmt.get("size") or source.stat().st_size),
        "duration_seconds": duration,
        "bit_rate": int(fmt.get("bit_rate") or 0) or None,
        "width": width or None,
        "height": height or None,
        "aspect_ratio": round(width / height, 4) if width and height else None,
        "video_codec": (video_stream or {}).get("codec_name"),
        "video_profile": (video_stream or {}).get("profile"),
        "pixel_format": (video_stream or {}).get("pix_fmt"),
        "frame_rate": frame_rate,
        "audio_codec": (audio_stream or {}).get("codec_name"),
        "sample_rate": int((audio_stream or {}).get("sample_rate") or 0) or None,
        "channels": int((audio_stream or {}).get("channels") or 0) or None,
        "channel_layout": (audio_stream or {}).get("channel_layout"),
    }
    return {key: value for key, value in metadata.items() if value is not None}


def ensure_media_kind(path: str | Path, expected: str, ffmpeg_executable: str | Path, role: str) -> dict[str, Any]:
    metadata = inspect_media(path, ffmpeg_executable)
    actual = str(metadata.get("kind", "file"))
    if actual != expected:
        labels = {"image": "图片", "video": "视频", "audio": "音频"}
        raise ValueError(
            f"{role} 只接受{labels.get(expected, expected)}，但收到的是{labels.get(actual, actual)}文件：{Path(path).name}。"
            "请将连线接到匹配颜色的端口，或先经过“素材适配”节点。"
        )
    return metadata


def _even(value: int) -> int:
    return max(2, value - value % 2)


def _visual_filter(width: int, height: int, fit_mode: str) -> str:
    flag = "decrease" if fit_mode == "contain" else "increase"
    chain = f"scale={width}:{height}:force_original_aspect_ratio={flag}:flags=lanczos"
    if fit_mode == "contain":
        return f"{chain},pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    return f"{chain},crop={width}:{height}"


def normalize_media(
    source_path: str | Path,
    output_dir: str | Path,
    ffmpeg_executable: str | Path,
    params: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    source = Path(source_path)
    metadata = inspect_media(source, ffmpeg_executable)
    kind = str(metadata.get("kind", "file"))
    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    fit_mode = str(params.get("fit_mode", "contain"))
    if fit_mode not in {"contain", "cover"}:
        raise ValueError("fit_mode must be contain or cover")
    width = _even(int(params.get("target_width") or metadata.get("width") or 1024))
    height = _even(int(params.get("target_height") or metadata.get("height") or 1024))
    ffmpeg = Path(ffmpeg_executable)
    creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0

    if kind == "image":
        output = output_root / "normalized.png"
        args = [str(ffmpeg), "-y", "-i", str(source), "-vf", _visual_filter(width, height, fit_mode), "-frames:v", "1", str(output)]
    elif kind == "video":
        output = output_root / "normalized.mp4"
        frame_rate = float(params.get("target_frame_rate") or 24)
        args = [
            str(ffmpeg), "-y", "-i", str(source), "-vf", _visual_filter(width, height, fit_mode),
            "-r", f"{frame_rate:g}", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-movflags", "+faststart", str(output),
        ]
    elif kind == "audio":
        output = output_root / "normalized.wav"
        sample_rate = int(params.get("target_sample_rate") or 48000)
        channels = int(params.get("target_channels") or metadata.get("channels") or 2)
        channels = 1 if channels <= 1 else 2
        args = [str(ffmpeg), "-y", "-i", str(source), "-vn", "-c:a", "pcm_s24le", "-ar", str(sample_rate), "-ac", str(channels), str(output)]
    else:
        raise ValueError(f"素材适配暂不支持此文件类型：{source.name}")

    completed = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60 * 60,
        creationflags=creationflags,
    )
    if completed.returncode != 0 or not output.is_file():
        raise RuntimeError(f"媒体适配失败：{(completed.stderr or 'ffmpeg failed')[-1200:]}")
    result_metadata = inspect_media(output, ffmpeg_executable)
    result_metadata.update({
        "normalized_from": str(source.resolve()),
        "fit_mode": fit_mode,
        "quality_policy": "lossless_png" if kind == "image" else "crf14_lanczos" if kind == "video" else "pcm_s24le",
    })
    return output, result_metadata
