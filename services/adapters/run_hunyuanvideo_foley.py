from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path


RESULT_PREFIX = "WORKBENCH_RESULT="


def load_request(path: Path) -> dict:
    request = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(request, dict):
        raise ValueError("request file must contain a JSON object")
    return request


def require_file(path: Path, label: str, minimum_bytes: int = 1) -> None:
    if not path.is_file() or path.stat().st_size < minimum_bytes:
        raise FileNotFoundError(f"{label} is missing or incomplete: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline HunyuanVideo-Foley XXL workbench adapter")
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()

    request = load_request(Path(args.request_file).resolve())
    source_root = Path(request["source_root"]).resolve()
    model_root = Path(request["model_root"]).resolve()
    siglip_root = Path(request["siglip_root"]).resolve()
    clap_root = Path(request["clap_root"]).resolve()
    video_path = Path(request["video_path"]).resolve()
    output_path = Path(request["output_path"]).resolve()
    config_path = Path(request.get("config_path") or model_root / "config.yaml").resolve()
    prompt = str(request.get("prompt", "")).strip()
    negative_prompt = str(request.get("negative_prompt", "noisy, harsh, music, speech, dialogue")).strip()
    steps = int(request.get("steps", 50))
    guidance_scale = float(request.get("guidance_scale", 4.5))
    seed = int(request.get("seed", 1))
    enable_offload = bool(request.get("enable_offload", True))

    if not source_root.is_dir():
        raise FileNotFoundError(f"HunyuanVideo-Foley source directory is missing: {source_root}")
    require_file(model_root / "hunyuanvideo_foley.pth", "XXL checkpoint", 10_000_000_000)
    require_file(model_root / "synchformer_state_dict.pth", "Synchformer checkpoint", 900_000_000)
    require_file(model_root / "vae_128d_48k.pth", "48 kHz audio VAE", 1_000_000_000)
    require_file(config_path, "XXL configuration")
    require_file(siglip_root / "model.safetensors", "SigLIP2 visual encoder", 100_000_000)
    require_file(clap_root / "pytorch_model.bin", "CLAP text encoder", 100_000_000)
    require_file(video_path, "source video", 1024)
    if not prompt:
        raise ValueError("foley.generate requires a non-empty sound-effect description")
    if not 10 <= steps <= 100:
        raise ValueError("steps must be between 10 and 100")
    if not 1.0 <= guidance_scale <= 10.0:
        raise ValueError("guidance_scale must be between 1.0 and 10.0")

    cache_root = source_root.parent / "cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DIFFUSERS_OFFLINE": "1",
        "HF_HOME": str(cache_root),
        "HUGGINGFACE_HUB_CACHE": str(cache_root / "hub"),
        "HUNYUAN_FOLEY_SIGLIP_ROOT": str(siglip_root),
        "HUNYUAN_FOLEY_CLAP_ROOT": str(clap_root),
    })
    sys.path.insert(0, str(source_root))

    import numpy as np
    import torch
    import soundfile as sf
    from hunyuanvideo_foley.utils.feature_utils import feature_process
    from hunyuanvideo_foley.utils.model_utils import denoise_process, load_model

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to HunyuanVideo-Foley XXL")

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.cuda.empty_cache()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    model_dict, cfg = load_model(
        str(model_root),
        str(config_path),
        torch.device("cuda:0"),
        enable_offload=enable_offload,
        model_size="xxl",
    )
    visual_feats, text_feats, duration_seconds = feature_process(
        str(video_path),
        prompt,
        model_dict,
        cfg,
        neg_prompt=negative_prompt or None,
    )
    audio, sample_rate = denoise_process(
        visual_feats,
        text_feats,
        duration_seconds,
        model_dict,
        cfg,
        guidance_scale=guidance_scale,
        num_inference_steps=steps,
    )
    waveform = audio[0].float().cpu()
    sf.write(str(output_path), waveform.transpose(0, 1).numpy(), int(sample_rate), subtype="PCM_24")

    require_file(output_path, "generated Foley WAV", 1024)
    result = {
        "provider": "hunyuanvideo-foley-xxl",
        "model": "HunyuanVideo-Foley-XXL BF16",
        "outputs": [str(output_path)],
        "source_video": str(video_path),
        "duration_seconds": round(float(waveform.shape[-1]) / float(sample_rate), 3),
        "sample_rate": int(sample_rate),
        "steps": steps,
        "guidance_scale": guidance_scale,
        "seed": seed,
        "offload": enable_offload,
        "bytes": output_path.stat().st_size,
        "gpu": torch.cuda.get_device_name(0),
    }
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
