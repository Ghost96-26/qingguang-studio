from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((PROJECT_ROOT / "config" / "runtime.json").read_text(encoding="utf-8-sig"))
BASE_URL = f"http://{CONFIG['listen']}:{CONFIG['port']}"
COMFY_ROOT = Path(CONFIG["comfyui_root"])


def request_json(path: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def build_workflow(prompt: str, seed: int, width: int, height: int, length: int, steps: int) -> dict[str, Any]:
    return {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                "weight_dtype": "default",
            },
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
                "type": "minimax",
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "5": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["1", 0],
                "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
                "strength_model": 1.0,
            },
        },
        "6": {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": length,
            },
        },
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["5", 0], "conditioning": ["6", 0]},
        },
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "10": {
            "class_type": "BasicScheduler",
            "inputs": {"model": ["5", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0},
        },
        "11": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["7", 0],
                "guider": ["8", 0],
                "sampler": ["9", 0],
                "sigmas": ["10", 0],
                "latent_image": ["6", 1],
            },
        },
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "14": {
            "class_type": "CreateVideo",
            "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": 24.0, "bit_depth": "auto", "color_space": "sRGB"},
        },
        "15": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["14", 0],
                "filename_prefix": f"smoke/h3_t2v_{width}x{height}_seed{seed}",
                "format": "auto",
                "codec": "auto",
            },
        },
    }


def find_media_descriptors(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if "filename" in value:
            found.append(value)
        for nested in value.values():
            found.extend(find_media_descriptors(nested))
    elif isinstance(value, list):
        for nested in value:
            found.extend(find_media_descriptors(nested))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a fixed-seed MiniMax H3 T2V smoke test.")
    parser.add_argument("--width", type=int, default=608)
    parser.add_argument("--height", type=int, default=352)
    parser.add_argument("--length", type=int, default=124)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seed", type=int, default=424242)
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()

    prompt = (
        "Single continuous five-second cinematic shot. A small matte red rubber ball enters from the left, "
        "bounces exactly twice on a grey concrete floor, then rolls smoothly out of frame to the right. "
        "Low fixed camera, overcast cool daylight, shallow depth of field, realistic 35mm film texture. "
        "Keep the ball's size, color and material stable. Audio: two clear rubber impacts and a soft rolling sound "
        "on concrete, quiet room ambience. No dialogue, no music, no text, no logo, no cuts."
    )
    workflow = build_workflow(prompt, args.seed, args.width, args.height, args.length, args.steps)
    client_id = str(uuid.uuid4())
    started = time.monotonic()
    started_utc = datetime.now(timezone.utc).isoformat()

    try:
        queue = request_json("/queue", timeout=10)
        if queue.get("queue_running") or queue.get("queue_pending"):
            raise RuntimeError("ComfyUI queue is not empty; refusing to mix the smoke test with another job.")
        submission = request_json("/prompt", {"prompt": workflow, "client_id": client_id})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"Submission failed: HTTP {exc.code}\n{body}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Submission failed: {exc!r}", file=sys.stderr)
        return 2

    prompt_id = submission["prompt_id"]
    print(f"Queued H3 smoke test: {prompt_id}", flush=True)
    deadline = time.monotonic() + args.timeout
    last_update = 0.0
    history_item: dict[str, Any] | None = None

    while time.monotonic() < deadline:
        history = request_json(f"/history/{prompt_id}", timeout=20)
        if prompt_id in history:
            history_item = history[prompt_id]
            break
        now = time.monotonic()
        if now - last_update >= 15:
            queue = request_json("/queue", timeout=10)
            elapsed = int(now - started)
            print(
                f"elapsed={elapsed}s running={len(queue.get('queue_running', []))} "
                f"pending={len(queue.get('queue_pending', []))}",
                flush=True,
            )
            last_update = now
        time.sleep(3)

    elapsed_seconds = round(time.monotonic() - started, 3)
    if history_item is None:
        print(f"Timed out after {elapsed_seconds}s; job remains queryable as {prompt_id}.", file=sys.stderr)
        return 3

    status = history_item.get("status", {})
    if status.get("status_str") not in {"success", None} or status.get("completed") is False:
        print(json.dumps(status, ensure_ascii=False, indent=2), file=sys.stderr)
        return 4

    descriptors = find_media_descriptors(history_item.get("outputs", {}))
    media_files: list[Path] = []
    for item in descriptors:
        subfolder = item.get("subfolder", "")
        media_type = item.get("type", "output")
        root = COMFY_ROOT / ("output" if media_type == "output" else media_type)
        candidate = root / subfolder / item["filename"]
        if candidate.exists() and candidate not in media_files:
            media_files.append(candidate)

    if not media_files:
        print("Generation completed, but no output media descriptor was found.", file=sys.stderr)
        return 5

    media_probe: dict[str, Any] | None = None
    primary = media_files[0]
    try:
        probe_raw = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(primary)],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        media_probe = json.loads(probe_raw)
    except Exception as exc:
        media_probe = {"error": repr(exc)}

    stream_types = {stream.get("codec_type") for stream in media_probe.get("streams", [])}
    media_ok = primary.stat().st_size > 100_000 and {"video", "audio"}.issubset(stream_types)
    manifest = {
        "prompt_id": prompt_id,
        "started_utc": started_utc,
        "completed_utc": datetime.now(timezone.utc).isoformat(),
        "elapsed_seconds": elapsed_seconds,
        "profile": {
            "mode": "t2va",
            "width": args.width,
            "height": args.height,
            "length": args.length,
            "fps": 24,
            "steps": args.steps,
            "seed": args.seed,
            "lora": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        },
        "prompt": prompt,
        "workflow": workflow,
        "status": status,
        "outputs": [str(path) for path in media_files],
        "media_probe": media_probe,
        "media_ok": media_ok,
    }
    manifest_path = PROJECT_ROOT / "manifests" / f"smoke-h3-t2v-{prompt_id}.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Output: {primary}")
    print(f"Elapsed: {elapsed_seconds}s")
    print(f"Manifest: {manifest_path}")
    print("RESULT: PASS" if media_ok else "RESULT: MEDIA CHECK FAILED")
    return 0 if media_ok else 6


if __name__ == "__main__":
    sys.exit(main())

