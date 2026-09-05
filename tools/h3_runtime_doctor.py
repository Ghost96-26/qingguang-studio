from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT_ROOT / "config" / "runtime.json"
OUTPUT_PATH = PROJECT_ROOT / "manifests" / "runtime-doctor-latest.json"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def http_json(url: str, timeout: int = 8) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the local MiniMax H3 runtime.")
    parser.add_argument("--json", action="store_true", help="Print the full report as JSON.")
    parser.add_argument("--require-server", action="store_true", help="Fail when ComfyUI is not reachable.")
    args = parser.parse_args()

    config = read_json(CONFIG_PATH)
    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: Any, critical: bool = True) -> None:
        checks.append({"name": name, "ok": bool(ok), "critical": critical, "detail": detail})

    model_root = Path(config["model_root"])
    required_models = {
        "h3_fl2va_int8": (model_root / "video/minimax-h3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", 19_000_000_000),
        "h3_ref2va_int8": (model_root / "video/minimax-h3/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", 19_000_000_000),
        "h3_text_encoder_32b": (model_root / "video/minimax-h3/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", 24_000_000_000),
        "h3_video_vae": (model_root / "video/minimax-h3/vae/minimax_h3_video_vae_fp16.safetensors", 4_000_000_000),
        "h3_audio_vae": (model_root / "video/minimax-h3/vae/minimax_h3_audio_vae_fp32.safetensors", 500_000_000),
        "h3_fl2v_turbo_8step": (model_root / "video/minimax-h3/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", 1_000_000_000),
        "h3_ref2v_turbo_4step": (model_root / "video/minimax-h3/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", 1_000_000_000),
        "h3_fl2v_turbo_4step": (model_root / "video/minimax-h3/loras/minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors", 1_000_000_000),
    }
    for name, (path, minimum_bytes) in required_models.items():
        size = path.stat().st_size if path.exists() else 0
        add(name, path.is_file() and size >= minimum_bytes, {"path": str(path), "bytes": size})

    try:
        import torch

        cuda_ok = torch.cuda.is_available()
        detail: dict[str, Any] = {
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "cuda_available": cuda_ok,
        }
        if cuda_ok:
            detail.update(
                {
                    "device": torch.cuda.get_device_name(0),
                    "capability": list(torch.cuda.get_device_capability(0)),
                    "vram_bytes": torch.cuda.get_device_properties(0).total_memory,
                }
            )
            x = torch.randn((512, 512), device="cuda", dtype=torch.float16)
            _ = x @ x
            torch.cuda.synchronize()
        add("torch_cuda", cuda_ok, detail)
    except Exception as exc:  # diagnostic boundary
        add("torch_cuda", False, repr(exc))

    try:
        import comfy_kitchen as ck
        import importlib.metadata

        backends = ck.list_backends()
        cuda_backend = backends.get("cuda", {})
        detail = {
            "version": importlib.metadata.version("comfy-kitchen"),
            "backends": backends,
            "int8_attention": ck.int8_attention_is_available(),
        }
        add("comfy_kitchen_cuda", bool(cuda_backend.get("available")), detail)
    except Exception as exc:  # diagnostic boundary
        add("comfy_kitchen_cuda", False, repr(exc))

    try:
        raw = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total,memory.free", "--format=csv,noheader"],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        ).strip()
        add("nvidia_smi", "RTX 5090" in raw, raw)
    except Exception as exc:
        add("nvidia_smi", False, repr(exc))

    base_url = f"http://{config['listen']}:{config['port']}"
    try:
        system_stats = http_json(f"{base_url}/system_stats")
        node_names = [
            "MiniMaxH3ImageToVideo",
            "MiniMaxH3ReferenceToVideo",
            "MiniMaxH3AddGuide",
            "MiniMaxH3SigmaShift",
        ]
        node_results = {}
        for node_name in node_names:
            node_results[node_name] = bool(http_json(f"{base_url}/object_info/{node_name}"))
        add("comfyui_api", all(node_results.values()), {"base_url": base_url, "nodes": node_results, "system_stats": system_stats}, args.require_server)
    except (OSError, urllib.error.URLError, TimeoutError, ValueError) as exc:
        add("comfyui_api", False, {"base_url": base_url, "error": repr(exc)}, args.require_server)

    report = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "project_root": str(PROJECT_ROOT),
        "config": config,
        "checks": checks,
    }
    report["ok"] = all(item["ok"] for item in checks if item["critical"])
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for item in checks:
            mark = "OK" if item["ok"] else ("WARN" if not item["critical"] else "FAIL")
            print(f"[{mark:4}] {item['name']}")
        print(f"Report: {OUTPUT_PATH}")
        print("RESULT: READY" if report["ok"] else "RESULT: NOT READY")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
