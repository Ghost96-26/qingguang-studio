"""Explicit local H3 variants and shared, reversible prompt-only art direction."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any
from .h3_ir import compile_ir


@lru_cache(maxsize=1)
def video_catalog() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[2] / "shared" / "video-presets.json"
    return json.loads(path.read_text(encoding="utf-8"))


def video_options(mode: str, params: dict[str, Any]) -> dict[str, Any]:
    catalog = video_catalog()
    profile = str(params.get("profile", "quality"))
    inferred = next((model for model in catalog["models"] if model["profile"] == profile), None)
    model_id = params.get("model_id") or (inferred or {}).get("id")
    model = next((model for model in catalog["models"] if model["id"] == model_id), None)
    if not model or model["profile"] != profile or mode not in model["modes"]:
        raise ValueError("H3 model variant does not support the selected mode/profile; BF16 is not enabled")
    scheduler = params.get("scheduler") or "simple"
    if scheduler not in ("simple", "beta", "normal"):
        raise ValueError("H3 scheduler must be simple, beta, or normal")
    if profile != "quality" and scheduler != "simple":
        raise ValueError("Turbo LoRA requires the matching simple scheduler")
    guidance = []
    selected = {}
    for group in catalog["groups"]:
        value = params.get(group["key"]) or "none"
        option = next((option for option in group["options"] if option["id"] == value), None)
        if option is None:
            raise ValueError(f"Unknown video preset: {group['key']}={value}")
        selected[group["key"]] = option["id"]
        if option["text"]:
            guidance.append(option["text"])
    prompt = str(params.get("prompt", "")).strip()
    effective = prompt + "\n\n" + catalog["guidance_header"] + "\n" + "\n".join(guidance) if guidance else prompt
    family = "ref2va" if mode == "reference" else "fl2va"
    result = {
        "model_id": model["id"], "precision": "INT8 ConvRot", "scheduler": scheduler,
        "checkpoint": f"minimax_h3_{family}_pruned_int8_convrot.safetensors",
        "effective_prompt": effective, "creative_presets": selected, "preset_version": catalog["version"],
    }
    if params.get("h3_ir_enabled") is True:
        result["h3_ir"] = compile_ir(mode, params, effective)
        result["effective_prompt"] = result["h3_ir"]["effective_prompt"]
    return result
