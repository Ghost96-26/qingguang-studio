from __future__ import annotations

import json
from typing import Any
from .sampling import validated_steps


KREA_MODELS = {
    "krea2-turbo-bf16": {
        "filename": "krea2_turbo_bf16.safetensors",
        "steps_t2i": 8,
        "steps_edit": 10,
        "cfg": 1.0,
    },
    "krea2-raw-bf16": {
        "filename": "krea2_raw_bf16.safetensors",
        "steps_t2i": 40,
        "steps_edit": 40,
        "cfg": 3.5,
    },
}

KREA_STYLE_LORAS = {
    "none": (None, ""),
    "darkbrush": ("krea2_darkbrush.safetensors", "monochrome ink wash style"),
    "dotmatrix": ("krea2_dotmatrix.safetensors", "monochrome stippling style"),
    "kidsdrawing": ("krea2_kidsdrawing.safetensors", "naive expressive sketch style"),
    "neondrip": ("krea2_neondrip.safetensors", "textured abstract style"),
    "rainywindow": ("krea2_rainywindow.safetensors", "rainy window style"),
    "retroanime": ("krea2_retroanime.safetensors", "purple retro anime style"),
    "softwatercolor": ("krea2_softwatercolor.safetensors", "art deco watercolor style"),
    "sunsetblur": ("krea2_sunsetblur.safetensors", "ethereal motion blur style"),
    "vintagetarot": ("krea2_vintagetarot.safetensors", "vintage tarot style"),
}

STYLE_SUFFIXES = {
    "auto": "",
    "portrait": "professional portrait photography, natural skin texture, controlled studio lighting, accurate facial anatomy",
    "food": "premium food photography, appetizing texture, realistic ingredients, refined plating, soft directional light",
    "landscape": "high-detail landscape and architectural photography, atmospheric depth, natural light, coherent perspective",
    "product": "commercial product photography, precise materials, clean silhouette, controlled reflections, premium advertising finish",
    "poster": "professional poster composition, clear visual hierarchy, intentional typography area, graphic-design finish",
}


def _append_prompt(prompt: str, addition: str) -> str:
    prompt = prompt.strip()
    addition = addition.strip()
    if not addition:
        return prompt
    return f"{prompt}, {addition}" if prompt else addition


def _decode_node(samples: list[Any], vae: list[Any], width: int, height: int) -> dict[str, Any]:
    if max(width, height) >= 1536:
        return {
            "class_type": "VAEDecodeTiled",
            "inputs": {
                "samples": samples,
                "vae": vae,
                "tile_size": 512,
                "overlap": 64,
                "temporal_size": 64,
                "temporal_overlap": 8,
            },
        }
    return {"class_type": "VAEDecode", "inputs": {"samples": samples, "vae": vae}}


def build_krea_t2i(
    job_id: str,
    model_id: str,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    style: str = "auto",
    style_lora: str = "none",
    lora_strength: float = 1.0,
    steps: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    model = KREA_MODELS[model_id]
    steps = validated_steps(steps, model["steps_t2i"], 20 if model_id == "krea2-raw-bf16" else 4, 60 if model_id == "krea2-raw-bf16" else 20)
    lora_name, trigger = KREA_STYLE_LORAS.get(style_lora, KREA_STYLE_LORAS["none"])
    final_prompt = _append_prompt(prompt, STYLE_SUFFIXES.get(style, ""))
    final_prompt = _append_prompt(final_prompt, trigger)
    workflow: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": model["filename"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_bf16.safetensors", "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": final_prompt}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
    }
    model_ref: list[Any] = ["1", 0]
    if lora_name:
        workflow["7"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["1", 0], "lora_name": lora_name, "strength_model": lora_strength},
        }
        model_ref = ["7", 0]
    workflow["8"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_ref,
            "seed": seed,
            "steps": steps,
            "cfg": model["cfg"],
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["4", 0],
            "negative": ["5", 0],
            "latent_image": ["6", 0],
            "denoise": 1.0,
        },
    }
    workflow["9"] = _decode_node(["8", 0], ["3", 0], width, height)
    workflow["10"] = {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": f"jobs/{job_id}/image"}}
    return workflow, {
        "model_id": model_id,
        "width": width,
        "height": height,
        "seed": seed,
        "steps": steps,
        "cfg": model["cfg"],
        "style": style,
        "style_lora": style_lora,
        "lora_strength": lora_strength if lora_name else 0.0,
        "prompt": final_prompt,
    }


def build_krea_edit(
    job_id: str,
    base_model_id: str,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    source_image: str,
    reference_image: str | None,
    mask_image: str | None,
    ref_boost: float,
    steps: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    model = KREA_MODELS[base_model_id]
    steps = validated_steps(steps, model["steps_edit"], 20 if base_model_id == "krea2-raw-bf16" else 4, 60 if base_model_id == "krea2-raw-bf16" else 20)
    workflow: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": model["filename"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_bf16.safetensors", "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "LoadImage", "inputs": {"image": source_image}},
        "5": {"class_type": "VAEEncode", "inputs": {"pixels": ["4", 0], "vae": ["3", 0]}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["1", 0], "lora_name": "Krea2\\krea2_identity_edit_v1_2.safetensors", "strength_model": 1.0},
        },
    }
    patch_inputs: dict[str, Any] = {
        "model": ["7", 0],
        "source_latent": ["5", 0],
        "ref_boost": ref_boost,
        "ref_boost_a": 1.0,
        "fit_mode": "fit",
        "vae": ["3", 0],
        "source_image": ["4", 0],
        "target_latent": ["6", 0],
    }
    encode_inputs: dict[str, Any] = {"clip": ["2", 0], "prompt": prompt, "image": ["4", 0], "grounding_px": 768, "system_prompt": ""}
    negative_inputs: dict[str, Any] = {"clip": ["2", 0], "prompt": "", "image": ["4", 0], "grounding_px": 768, "system_prompt": ""}
    if reference_image:
        workflow["11"] = {"class_type": "LoadImage", "inputs": {"image": reference_image}}
        workflow["12"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}}
        patch_inputs["source_latent_b"] = ["12", 0]
        patch_inputs["source_image_b"] = ["11", 0]
        encode_inputs["image_b"] = ["11", 0]
        negative_inputs["image_b"] = ["11", 0]
    if mask_image:
        workflow["13"] = {"class_type": "LoadImage", "inputs": {"image": mask_image}}
        patch_inputs["ref_boost_mask"] = ["13", 1]
    workflow["8"] = {"class_type": "Krea2EditModelPatch", "inputs": patch_inputs}
    workflow["9"] = {"class_type": "Krea2EditGroundedEncode", "inputs": encode_inputs}
    workflow["10"] = {"class_type": "Krea2EditGroundedEncode", "inputs": negative_inputs}
    workflow["14"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["8", 0],
            "seed": seed,
            "steps": steps,
            "cfg": model["cfg"],
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["9", 0],
            "negative": ["10", 0],
            "latent_image": ["6", 0],
            "denoise": 1.0,
        },
    }
    workflow["15"] = _decode_node(["14", 0], ["3", 0], width, height)
    workflow["16"] = {"class_type": "SaveImage", "inputs": {"images": ["15", 0], "filename_prefix": f"jobs/{job_id}/image_edit"}}
    return workflow, {
        "model_id": "krea2-identity-edit-v1.2",
        "base_model_id": base_model_id,
        "width": width,
        "height": height,
        "seed": seed,
        "steps": steps,
        "cfg": model["cfg"],
        "ref_boost": ref_boost,
        "two_reference": bool(reference_image),
        "mask_guided_reference": bool(mask_image),
    }


def _ideogram_prompt(prompt: str, style: str) -> str:
    try:
        parsed = json.loads(prompt)
        if isinstance(parsed, dict):
            return json.dumps(parsed, ensure_ascii=False)
    except json.JSONDecodeError:
        pass
    suffix = STYLE_SUFFIXES.get(style, "")
    payload: dict[str, Any] = {"high_level_description": prompt}
    if suffix:
        payload["style_description"] = {
            "aesthetics": suffix,
            "lighting": "controlled professional lighting",
            "medium": "graphic_design" if style == "poster" else "photograph",
        }
    return json.dumps(payload, ensure_ascii=False)


def build_ideogram_t2i(
    job_id: str,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    style: str = "auto",
    steps: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    steps = validated_steps(steps, 48, 20, 80)
    final_prompt = _ideogram_prompt(prompt, style)
    workflow: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "ideogram4_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "ideogram4_unconditional_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "ideogram4", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": final_prompt}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "7": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "9": {"class_type": "CFGOverride", "inputs": {"model": ["1", 0], "cfg": 3.0, "start_percent": 0.7, "end_percent": 1.0}},
        "10": {"class_type": "DualModelGuider", "inputs": {"model": ["9", 0], "model_negative": ["2", 0], "positive": ["5", 0], "negative": ["6", 0], "cfg": 7.0}},
        "11": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "12": {"class_type": "Ideogram4Scheduler", "inputs": {"steps": steps, "width": width, "height": height, "mu": 0.0, "std": 1.5}},
        "13": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["10", 0], "sampler": ["11", 0], "sigmas": ["12", 0], "latent_image": ["7", 0]}},
    }
    workflow["14"] = _decode_node(["13", 0], ["4", 0], width, height)
    workflow["15"] = {"class_type": "SaveImage", "inputs": {"images": ["14", 0], "filename_prefix": f"jobs/{job_id}/ideogram4"}}
    return workflow, {
        "model_id": "ideogram4-fp8",
        "width": width,
        "height": height,
        "seed": seed,
        "steps": steps,
        "preset": f"V4_QUALITY_{steps}",
        "style": style,
        "prompt": final_prompt,
    }
