from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


RESULT_PREFIX = "WORKBENCH_RESULT="


def load_request(path: Path) -> dict:
    request = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(request, dict):
        raise ValueError("request file must contain a JSON object")
    return request


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline MiniMax Music 3 workbench adapter")
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()

    request = load_request(Path(args.request_file).resolve())
    model_root = Path(request["model_root"]).resolve()
    output_path = Path(request["output_path"]).resolve()
    prompt = str(request.get("prompt", "")).strip()
    lyrics = str(request.get("lyrics", "")).strip()
    duration = float(request.get("duration_seconds", 30.0))
    seed = int(request.get("seed", 0))

    if not model_root.is_dir():
        raise FileNotFoundError(f"MiniMax Music 3 model directory is missing: {model_root}")
    if not prompt:
        raise ValueError("prompt must not be empty")
    if not lyrics:
        raise ValueError("lyrics must not be empty; use section tags for instrumental direction")
    if not 5.0 <= duration <= 300.0:
        raise ValueError("duration_seconds must be between 5 and 300")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["DIFFUSERS_OFFLINE"] = "1"

    import soundfile as sf
    import numpy as np
    import torch
    from diffusers import ModularPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to MiniMax Music 3")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pipe = ModularPipeline.from_pretrained(str(model_root))
    pipe.load_components(
        dtype=torch.bfloat16,
        pretrained_model_name_or_path=str(model_root),
        local_files_only=True,
        fix_mistral_regex={"tokenizer": True},
    )
    pipe.to("cuda")
    audio = pipe(
        prompt=prompt,
        lyrics=lyrics,
        audio_duration=duration,
        generator=torch.Generator("cuda").manual_seed(seed),
        output="audios",
    )[0]
    if torch.is_tensor(audio):
        waveform = audio.T.float().cpu().numpy()
    else:
        waveform = np.asarray(audio, dtype=np.float32).T
    sf.write(str(output_path), waveform, pipe.sampling_rate)

    if not output_path.is_file() or output_path.stat().st_size < 1024:
        raise RuntimeError("MiniMax Music 3 returned without producing a valid WAV file")
    result = {
        "provider": "minimax-music-3",
        "outputs": [str(output_path)],
        "duration_seconds": duration,
        "sample_rate": int(pipe.sampling_rate),
        "seed": seed,
        "bytes": output_path.stat().st_size,
        "gpu": torch.cuda.get_device_name(0),
    }
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
