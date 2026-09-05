"""Local review export. Inputs originate only from registered production outputs."""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from .media_tools import inspect_media


def assembly_command(params, executable, output):
    clips = params.get("clips", [])
    width, height, fps = int(params["width"]), int(params["height"]), int(params["fps"])
    if not 1 <= len(clips) <= 12 or (width, height, fps) != (1344, 768, 24):
        raise ValueError("审片合成参数超出已验证范围")
    total = sum(float(clip["seconds"]) for clip in clips)
    if not 4 <= total <= 60 or any(not 4 <= float(clip["seconds"]) <= 15 for clip in clips):
        raise ValueError("审片时长无效")
    command = [str(executable), "-hide_banner", "-nostdin", "-y", "-filter_complex_threads", "2"]
    filters, concat = [], []
    for index, clip in enumerate(clips):
        path = Path(clip["path"]).resolve()
        metadata = inspect_media(path, executable)
        seconds = float(clip["seconds"])
        if metadata.get("kind") != "video" or float(metadata.get("duration_seconds", 0)) + 1 / fps < seconds:
            raise ValueError("输入镜头损坏或短于计划；不通过静帧补足时长")
        command.extend(["-i", str(path)])
        frames = round(seconds * fps)
        filters.append(f"[{index}:v]fps={fps},trim=end_frame={frames},setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{index}]")
        if metadata.get("audio_codec"):
            filters.append(f"[{index}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={seconds},asetpts=PTS-STARTPTS[a{index}]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={seconds},asetpts=PTS-STARTPTS[a{index}]")
        concat.extend([f"[v{index}]", f"[a{index}]"])
    filters.append("".join(concat) + f"concat=n={len(clips)}:v=1:a=1[video][sound]")
    audio = "[sound]"
    if params.get("score_path"):
        score = Path(params["score_path"]).resolve()
        if inspect_media(score, executable).get("kind") != "audio":
            raise ValueError("配乐输出无效")
        command.extend(["-i", str(score)])
        filters.append(f"[{len(clips)}:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.25,apad,atrim=duration={total}[score]")
        filters.append("[sound][score]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[audio]")
        audio = "[audio]"
    command.extend(["-filter_complex", ";".join(filters), "-map", "[video]", "-map", audio,
                    "-c:v", "libx264", "-threads", "2", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
                    "-t", str(total), "-movflags", "+faststart", str(output)])
    return command, total


def assemble_video(job, settings, progress, cancelled):
    from .providers import JobCancelled
    root = Path(settings["artifact_root"]) / job["id"]
    root.mkdir(parents=True, exist_ok=True)
    output, log = root / "review-cut.mp4", root / "assembly.log"
    command, total = assembly_command(job["params"], settings["ffmpeg_executable"], output)
    started = time.monotonic()
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            while process.poll() is None:
                if cancelled():
                    raise JobCancelled("审片合成已取消")
                if time.monotonic() - started > 1200:
                    raise TimeoutError("审片合成超过 20 分钟，已停止")
                progress(min(.9, .1 + (time.monotonic() - started) / 1200), "assembling_review_cut", str(process.pid))
                time.sleep(.2)
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
    if process.returncode != 0 or not output.is_file():
        raise RuntimeError(log.read_text(encoding="utf-8", errors="replace")[-3000:])
    metadata = inspect_media(output, settings["ffmpeg_executable"])
    if abs(float(metadata.get("duration_seconds", 0)) - total) > 1 / 24 + .02 or (metadata.get("width"), metadata.get("height"), metadata.get("frame_rate")) != (1344, 768, 24):
        raise ValueError("成片时长、分辨率或帧率未通过验收")
    return {"provider": "ffmpeg-local-review", "outputs": [str(output)], "duration_seconds": total,
            "metadata": metadata, "profile": {"width": 1344, "height": 768, "fps": 24, "crf": 14}, "log": str(log)}
