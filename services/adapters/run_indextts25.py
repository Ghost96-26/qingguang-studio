from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path


RESULT_PREFIX = "WORKBENCH_RESULT="
SUPPORTED_LANGUAGES = {"ZH", "EN", "JA", "ES", "AR"}


def load_request(path: Path) -> dict:
    request = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(request, dict):
        raise ValueError("request file must contain a JSON object")
    return request


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline IndexTTS 2.5 workbench adapter")
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()

    request = load_request(Path(args.request_file).resolve())
    model_root = Path(request["model_root"]).resolve()
    source_root = Path(request["source_root"]).resolve()
    reference_audio = Path(request["reference_audio"]).resolve()
    output_path = Path(request["output_path"]).resolve()
    emotion_audio = request.get("emotion_audio")
    emotion_audio_path = Path(emotion_audio).resolve() if emotion_audio else None
    text = str(request.get("text", "")).strip()
    language = str(request.get("language", "ZH")).upper()
    seed = int(request.get("seed", 0))
    duration_factor = float(request.get("duration_factor", 1.0))
    emotion_vector = request.get("emotion_vector")
    use_emotion_text = bool(request.get("use_emotion_text", False))
    emotion_text = request.get("emotion_text")

    if not model_root.is_dir():
        raise FileNotFoundError(f"IndexTTS model directory is missing: {model_root}")
    if not (source_root / "indextts" / "infer_v2_5.py").is_file():
        raise FileNotFoundError(f"IndexTTS source directory is missing: {source_root}")
    if not reference_audio.is_file():
        raise FileNotFoundError(f"reference audio is missing: {reference_audio}")
    if emotion_audio_path and not emotion_audio_path.is_file():
        raise FileNotFoundError(f"emotion reference audio is missing: {emotion_audio_path}")
    if not text:
        raise ValueError("text must not be empty")
    if language not in SUPPORTED_LANGUAGES:
        raise ValueError(f"language must be one of {sorted(SUPPORTED_LANGUAGES)}")
    if not 0.5 <= duration_factor <= 2.0:
        raise ValueError("duration_factor must be between 0.5 and 2.0")
    if emotion_vector is not None:
        if not isinstance(emotion_vector, list) or len(emotion_vector) != 8:
            raise ValueError("emotion_vector must contain exactly 8 numbers")
        emotion_vector = [float(value) for value in emotion_vector]

    cache_root = model_root / "hf_cache"
    os.environ.setdefault("HF_HOME", str(cache_root))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(cache_root))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(cache_root))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["NO_ALBUMENTATIONS_UPDATE"] = "1"

    sys.path.insert(0, str(source_root))

    import numpy as np
    import soundfile as sf
    import torch
    from indextts import infer_v2_5 as indextts_infer

    def save_pcm_wav_without_torchcodec(path: str, wav: torch.Tensor, sampling_rate: int) -> None:
        normalized = wav.detach().to(device="cpu", dtype=torch.float32).div_(32767.0).clamp_(-1.0, 1.0)
        sf.write(path, normalized.transpose(0, 1).numpy(), sampling_rate, subtype="PCM_16")

    indextts_infer.save_pcm_wav = save_pcm_wav_without_torchcodec
    IndexTTS2 = indextts_infer.IndexTTS2

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to IndexTTS")

    random.seed(seed)
    np.random.seed(seed & 0xFFFFFFFF)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    tts = IndexTTS2(
        cfg_path=str(model_root / "config.yaml"),
        model_dir=str(model_root),
        use_bf16=True,
        device="cuda:0",
        use_cuda_kernel=False,
        use_deepspeed=False,
        use_accel=False,
        use_torch_compile=False,
        use_qwen_emo=use_emotion_text,
    )
    tts.infer(
        spk_audio_prompt=str(reference_audio),
        text=text,
        output_path=str(output_path),
        lang=language,
        emo_audio_prompt=str(emotion_audio_path) if emotion_audio_path else None,
        emo_vector=emotion_vector,
        use_emo_text=use_emotion_text,
        emo_text=str(emotion_text) if emotion_text else None,
        use_random=False,
        duration_factor=duration_factor,
        verbose=True,
    )

    if not output_path.is_file() or output_path.stat().st_size < 1024:
        raise RuntimeError("IndexTTS returned without producing a valid WAV file")
    result = {
        "provider": "indextts-2.5",
        "outputs": [str(output_path)],
        "language": language,
        "seed": seed,
        "duration_factor": duration_factor,
        "bytes": output_path.stat().st_size,
        "gpu": torch.cuda.get_device_name(0),
    }
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
