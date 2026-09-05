from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import winreg
from pathlib import Path
from typing import Any, Callable

from .config import Settings
from .image_workflows import KREA_MODELS, build_ideogram_t2i, build_krea_edit, build_krea_t2i
from .media_tools import ensure_media_kind, normalize_media
from .sampling import validated_steps
from .video_options import video_catalog, video_options
from .h3_ir import apply_enhancement, enhancement_instruction


class JobCancelled(RuntimeError):
    pass


Progress = Callable[[float, str, str | None], None]
IsCancelled = Callable[[], bool]


def http_json(base_url: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def model_file_ok(path: Path, minimum_bytes: int) -> bool:
    return path.is_file() and path.stat().st_size >= minimum_bytes


def smart_app_control_enforced() -> bool:
    if os.name != "nt":
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\CI\Policy") as key:
            value, _ = winreg.QueryValueEx(key, "VerifiedAndReputablePolicyState")
            return int(value) == 1
    except OSError:
        return False


class ProviderRegistry:
    SUPPORTED_TYPES = {
        "system.noop", "h3.t2v", "image.t2i", "image.i2i", "image.edit",
        "tts.clone", "dialogue.generate", "music.generate", "foley.generate", "audio.sequence", "agent.chat", "agent.h3_ir", "agent.storyboard", "video.assemble", "media.normalize",
    }

    def __init__(self, settings: Settings):
        self.settings = settings
        self._last_h3_model_family: str | None = None
        self._last_comfy_model_family: str | None = None
        # A gateway restart cannot know whether the independently managed
        # ComfyUI process still has a patched model resident.  The first GPU
        # transition therefore establishes a clean, known state.
        self._comfy_state_known = False
        self._runtime_lock = threading.Lock()
        self._recovery_thread: threading.Thread | None = None

    def _model_catalog(self) -> list[dict[str, Any]]:
        raw = self.settings.raw
        registry_path = Path(raw["model_registry"])
        registry = json.loads(registry_path.read_text(encoding="utf-8-sig"))
        roots = {
            "model": Path(raw["model_root"]),
            "workspace": registry_path.parent.parent,
        }
        catalog: list[dict[str, Any]] = []
        for configured in registry.get("models", []):
            item = {key: value for key, value in configured.items() if key != "requirements"}
            missing: list[str] = []
            for requirement in configured.get("requirements", []):
                root = roots.get(str(requirement.get("root", "model")))
                if root is None:
                    missing.append(str(requirement.get("path", "")))
                    continue
                candidate = root / str(requirement["path"])
                if not model_file_ok(candidate, int(requirement.get("minimum_bytes", 1))):
                    missing.append(str(requirement["path"]))
            weights_ready = not missing and bool(configured.get("requirements"))
            runtime_enabled = bool(configured.get("runtime_enabled", False))
            item["weights_ready"] = weights_ready
            item["ready"] = weights_ready and runtime_enabled
            item["missing_files"] = missing
            catalog.append(item)
        return catalog

    def _prompt_catalog(self) -> list[dict[str, Any]]:
        catalog = [model for model in self._model_catalog() if model.get("modality") == "prompt"]
        try:
            tags = http_json(self.settings.raw["ollama_base_url"], "/api/tags", timeout=5)
            ollama_models = {str(item.get("name") or item.get("model")) for item in tags.get("models", [])}
        except Exception:
            ollama_models = set()
        for model in catalog:
            if model.get("backend") != "ollama":
                continue
            present = str(model.get("ollama_model", "")) in ollama_models
            model["weights_ready"] = present
            model["ready"] = present and bool(model.get("runtime_enabled"))
            model["availability"] = "local_ollama" if present else "ollama_offline_or_missing"
        return catalog

    def capabilities(self) -> dict[str, Any]:
        raw = self.settings.raw
        model_root = Path(raw["model_root"])
        catalog = self._model_catalog()
        image_models = [model for model in catalog if model.get("modality") == "image"]
        prompt_models = self._prompt_catalog()
        h3_files = [
            model_root / "video/minimax-h3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            model_root / "video/minimax-h3/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
            model_root / "video/minimax-h3/vae/minimax_h3_video_vae_fp16.safetensors",
            model_root / "video/minimax-h3/vae/minimax_h3_audio_vae_fp32.safetensors",
        ]
        try:
            node_ok = bool(http_json(raw["comfyui_base_url"], "/object_info/MiniMaxH3ImageToVideo", timeout=5))
        except Exception:
            node_ok = False
        try:
            krea_node_ok = all(
                bool(http_json(raw["comfyui_base_url"], f"/object_info/{node}", timeout=5))
                for node in ("UNETLoader", "CLIPLoader", "EmptyLatentImage", "KSampler", "VAEDecodeTiled")
            )
            identity_node_ok = all(
                bool(http_json(raw["comfyui_base_url"], f"/object_info/{node}", timeout=5))
                for node in ("Krea2EditModelPatch", "Krea2EditGroundedEncode", "EmptySD3LatentImage")
            )
            ideogram_node_ok = all(
                bool(http_json(raw["comfyui_base_url"], f"/object_info/{node}", timeout=5))
                for node in ("Ideogram4Scheduler", "DualModelGuider", "CFGOverride", "EmptyFlux2LatentImage")
            )
        except Exception:
            krea_node_ok = identity_node_ok = ideogram_node_ok = False
        for model in image_models:
            if model["id"] == "krea2-identity-edit-v1.2":
                model["node_ready"] = krea_node_ok and identity_node_ok
            elif model["id"] == "ideogram4-fp8":
                model["node_ready"] = ideogram_node_ok
            else:
                model["node_ready"] = krea_node_ok
            model["ready"] = bool(model["ready"] and model["node_ready"])

        tts_root = Path(raw["tts_model_root"])
        tts_files = [tts_root / "gpt.pth", tts_root / "s2mel.pth", tts_root / "codec.pth"]
        music_root = Path(raw["music_model_root"])
        music_files = [music_root / "modular_model_index.json", music_root / "flowmatching_vae.pth"]
        foley_root = Path(raw["foley_model_root"])
        foley_files = [
            foley_root / "hunyuanvideo_foley.pth",
            foley_root / "synchformer_state_dict.pth",
            foley_root / "vae_128d_48k.pth",
            foley_root / "config.yaml",
            Path(raw["foley_siglip_root"]) / "model.safetensors",
            Path(raw["foley_clap_root"]) / "pytorch_model.bin",
        ]
        return {
            "scheduler": {"policy": "single_gpu_exclusive", "resource": "gpu0"},
            "providers": {
                "h3": {
                    "ready": node_ok and all(path.is_file() for path in h3_files),
                    "job_types": ["h3.t2v"],
                    "modes": ["t2v", "i2v", "fl2v", "reference", "audio_drive"],
                    "models": video_catalog()["models"],
                    "creative_presets_version": video_catalog()["version"],
                    "backend": raw["comfyui_base_url"],
                },
                "image": {
                    "ready": any(model["ready"] for model in image_models),
                    "weights_ready": any(model["weights_ready"] for model in image_models),
                    "job_types": ["image.t2i", "image.i2i", "image.edit"],
                    "models": image_models,
                    "backend": raw["comfyui_base_url"],
                    "status_note": "Local Krea 2 BF16, Identity Edit and Ideogram 4 workflows are enabled.",
                },
                "tts": {
                    "ready": Path(raw["tts_ready_file"]).is_file() and all(path.is_file() for path in tts_files),
                    "weights_ready": all(path.is_file() for path in tts_files),
                    "job_types": ["tts.clone", "dialogue.generate"],
                    "languages": ["ZH", "EN", "JA", "ES", "AR"],
                },
                "music": {
                    "ready": Path(raw["music_ready_file"]).is_file() and all(path.is_file() for path in music_files),
                    "weights_ready": all(path.is_file() for path in music_files),
                    "job_types": ["music.generate"],
                },
                "foley": {
                    "ready": Path(raw["foley_ready_file"]).is_file() and all(path.is_file() for path in foley_files),
                    "weights_ready": all(path.is_file() for path in foley_files),
                    "job_types": ["foley.generate"],
                    "model": "HunyuanVideo-Foley-XXL BF16",
                    "sample_rate": 48000,
                    "max_duration_seconds": 15,
                    "requires_video": True,
                },
                "audio_tools": {
                    "ready": Path(raw["ffmpeg_executable"]).is_file(),
                    "job_types": ["audio.sequence"],
                    "max_sequence_inputs": 6,
                },
                "agent": {
                    "ready": any(model.get("ready") for model in prompt_models),
                    "weights_ready": any(model.get("weights_ready") for model in prompt_models),
                    "job_types": ["agent.chat", "agent.h3_ir", "agent.storyboard"],
                    "models": prompt_models,
                    "default_model": "qwen3.6-27b-q4",
                },
            },
        }

    def ensure_comfy_runtime(self) -> dict[str, Any]:
        """Start the managed local GPU runtime only when it is unavailable."""
        base_url = str(self.settings.raw["comfyui_base_url"])
        try:
            http_json(base_url, "/object_info", timeout=5)
        except Exception:
            self._restart_comfy_runtime("h3")
        else:
            # The worker may have been started outside this registry (for
            # example by the explicit UI start action or crash recovery).  A
            # successful probe means it is a clean, usable worker even though
            # no model family has been submitted through this process yet.
            self._last_h3_model_family = None
            self._last_comfy_model_family = None
            self._comfy_state_known = True
        return self.capabilities()

    def execute(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        job_type = job["type"]
        if job_type == "system.noop":
            return self._noop(job, progress, cancelled)
        if job_type == "h3.t2v":
            return self._h3_t2v(job, progress, cancelled)
        if job_type in {"image.t2i", "image.i2i", "image.edit"}:
            return self._image(job, progress, cancelled)
        if job_type == "tts.clone":
            return self._subprocess_provider(job, progress, cancelled, "tts")
        if job_type == "dialogue.generate":
            return self._dialogue_generate(job, progress, cancelled)
        if job_type == "music.generate":
            return self._subprocess_provider(job, progress, cancelled, "music")
        if job_type == "foley.generate":
            return self._subprocess_provider(job, progress, cancelled, "foley")
        if job_type == "audio.sequence":
            return self._audio_sequence(job, progress, cancelled)
        if job_type == "agent.chat":
            return self._agent(job, progress, cancelled)
        if job_type == "agent.storyboard":
            from .storyboard import planning_instruction, validate_plan, plan_text
            params = job["params"]
            response = self._agent({**job, "params": {"prompt": planning_instruction(params), "model_id": params["model_id"], "context": 16384, "max_tokens": 4096, "temperature": 0.2, "reasoning": False}}, progress, cancelled)
            plan = validate_plan(response["text"], params)
            return {**response, "text": plan_text(plan), "storyboard": plan}
        if job_type == "video.assemble":
            from .video_assembly import assemble_video
            return assemble_video(job, self.settings.raw, progress, cancelled)
        if job_type == "agent.h3_ir":
            return self._h3_prompt(job, progress, cancelled)
        if job_type == "media.normalize":
            return self._media_normalize(job, progress, cancelled)
        raise ValueError(f"Unsupported job type: {job_type}")

    def cleanup_failed(self, job: dict[str, Any]) -> None:
        if job["type"].startswith(("h3.", "image.")):
            # Mark the state dirty immediately. A lightweight delayed probe
            # restarts only when the isolated ComfyUI process actually died;
            # ordinary validation errors therefore never churn the GPU worker.
            self._last_h3_model_family = None
            self._last_comfy_model_family = None
            self._comfy_state_known = False
            profile = "h3" if job["type"].startswith("h3.") else "image"
            self._schedule_comfy_recovery(profile)

    def _schedule_comfy_recovery(self, profile: str) -> None:
        """Recover a native ComfyUI crash without resubmitting the failed job."""
        if self._recovery_thread is not None and self._recovery_thread.is_alive():
            return

        def recover() -> None:
            # Give ComfyUI's error handler a moment to either settle or exit.
            time.sleep(3)
            try:
                http_json(self.settings.raw["comfyui_base_url"], "/system_stats", timeout=5)
                return
            except Exception:
                pass
            try:
                self._restart_comfy_runtime(profile)
            except Exception:
                # The canvas exposes an explicit start action if automatic
                # recovery cannot complete (driver reset, reboot required).
                self._comfy_state_known = False

        self._recovery_thread = threading.Thread(
            target=recover,
            name="comfyui-crash-recovery",
            daemon=True,
        )
        self._recovery_thread.start()

    def _free_comfy_memory(self) -> None:
        """Release GPU memory for a non-Comfy provider without unsafe hot unloads."""
        if not self._comfy_state_known or self._last_comfy_model_family is not None:
            self._restart_comfy_runtime("h3")
            return
        # A managed restart has already established an empty Comfy process.
        # Avoid repeatedly restarting it for consecutive LLM/audio jobs.

    def _prepare_comfy_family(self, family: str, progress: Progress | None = None) -> None:
        # ``None`` represents a freshly started, model-free ComfyUI worker.
        # It is already safe for the first family and must not be restarted a
        # second time.  The previous condition only skipped when a family had
        # completed successfully, so the first H3 job after Start/Recovery
        # killed the healthy worker and immediately tried to launch it again.
        if self._comfy_state_known and self._last_comfy_model_family in {None, family}:
            return
        if progress is not None:
            progress(0.02, "switching_comfyui_model_family", None)
        self._restart_comfy_runtime("h3" if family.startswith("h3-") else "image")

    def _restart_comfy_runtime(self, profile: str = "h3") -> None:
        """Restart the managed ComfyUI worker to avoid Windows unpatch crashes.

        Krea Identity Edit applies a model patch.  ComfyUI's /free hot-unload
        path can raise a native access violation when the next family is
        Ideogram/H3.  A process restart is slower but deterministic and keeps
        the API/gateway alive for internal production use.
        """
        project_root = Path(self.settings.raw["database"]).parent.parent
        script = project_root / "scripts" / "Restart-H3Runtime.ps1"
        if not script.is_file():
            raise RuntimeError(f"Managed ComfyUI restart script is missing: {script}")
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not powershell:
            raise RuntimeError("PowerShell is required to restart the managed ComfyUI runtime")
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        restart_log_path = project_root / "logs" / "comfyui.restart.log"
        restart_log_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess_env = dict(os.environ)
        if os.name == "nt":
            # The gateway is launched from PowerShell 7, which can expose the
            # inherited search path as ``PATH``.  Windows PowerShell 5 adds its
            # canonical ``Path`` entry on startup; leaving both spellings in
            # the child environment makes Start-Process fail with a duplicate
            # dictionary-key error before Python is launched.
            path_value = None
            for key in list(subprocess_env):
                if key.casefold() == "path":
                    path_value = subprocess_env.pop(key)
            if path_value is not None:
                subprocess_env["Path"] = path_value
        with self._runtime_lock:
            try:
                with restart_log_path.open("a", encoding="utf-8") as restart_log:
                    restart_log.write(f"\n=== managed restart profile={profile} ===\n")
                    restart_log.flush()
                    completed = subprocess.run(
                        [powershell, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Family", profile],
                        cwd=str(project_root),
                        # A regular file keeps the PowerShell diagnostics without
                        # the inherited PIPE handles that can make this call wait
                        # forever after Start-Process detaches ComfyUI.
                        stdout=restart_log,
                        stderr=subprocess.STDOUT,
                        timeout=360,
                        creationflags=creationflags,
                        env=subprocess_env,
                    )
            except subprocess.TimeoutExpired as exc:
                self._comfy_state_known = False
                raise RuntimeError("Timed out restarting the managed ComfyUI runtime") from exc
        if completed.returncode != 0:
            self._comfy_state_known = False
            log_path = project_root / "logs" / "comfyui.stderr.log"
            try:
                log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-16000:]
            except OSError:
                log_tail = ""
            policy_block = any(marker in log_tail for marker in ("应用程序控制策略", "Smart App Control", "code integrity policy"))
            policy_block = policy_block or ("DLL load failed while importing frame" in log_tail and smart_app_control_enforced())
            if policy_block:
                raise RuntimeError(
                    "Windows 智能应用控制阻止了本地 PyAV 二进制模块，GPU 引擎无法启动。"
                    "工作台没有修改系统安全策略；请在 Windows 安全中心的‘应用和浏览器控制 → 智能应用控制’中处理后重试。"
                )
            raise RuntimeError(
                f"Managed ComfyUI restart failed with exit code {completed.returncode}; "
                f"check {log_path} and {restart_log_path}"
            )
        self._last_h3_model_family = None
        self._last_comfy_model_family = None
        self._comfy_state_known = True

    @staticmethod
    def _noop(job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        seconds = max(0.0, min(5.0, float(job["params"].get("seconds", 0.1))))
        started = time.monotonic()
        while time.monotonic() - started < seconds:
            if cancelled():
                raise JobCancelled("No-op job cancelled")
            elapsed = time.monotonic() - started
            progress(min(0.95, elapsed / max(seconds, 0.01)), "testing_queue", None)
            time.sleep(0.05)
        return {"echo": job["params"].get("echo"), "slept_seconds": seconds}

    def _h3_t2v(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        params = job["params"]
        mode = str(params.get("mode", "t2v")).strip().lower()
        if mode not in {"t2v", "i2v", "fl2v", "reference", "audio_drive"}:
            raise ValueError("H3 mode must be t2v, i2v, fl2v, reference, or audio_drive")
        prompt = str(params.get("prompt", "")).strip()
        if not prompt:
            raise ValueError("h3.t2v requires a non-empty prompt")
        width = int(params.get("width", 1344))
        height = int(params.get("height", 768))
        if width % 32 or height % 32 or width < 256 or height < 256:
            raise ValueError("width and height must be multiples of 32 and at least 256")
        if width * height > 1344 * 768:
            raise ValueError("requested canvas exceeds the validated H3 native area")
        seconds = max(1.0, min(15.0, float(params.get("duration_seconds", 5.0))))
        frames = max(5, round(seconds * 24))
        frames += (5 - frames % 17) % 17
        seed = int(params.get("seed", 0))
        profile, steps, lora = self._h3_sampling_profile(mode, params)
        options = video_options(mode, params)

        model_family = "ref2va" if mode == "reference" else "fl2va"
        comfy_family = f"h3-{model_family}"
        # Validate every role before a family restart or GPU submission.  This
        # prevents an image accidentally wired to a video port from reaching
        # ComfyUI as a LoadVideo graph.
        staged = self._stage_h3_inputs(job["id"], mode, params)

        # Native H3, Krea and Ideogram each stage tens of gigabytes.  Switching
        # families through ComfyUI's hot-unload path is not reliable on Windows,
        # so establish a clean worker before accepting the next graph.
        self._prepare_comfy_family(comfy_family, progress)
        base = self.settings.raw["comfyui_base_url"]
        queue = http_json(base, "/queue", timeout=10)
        if queue.get("queue_running") or queue.get("queue_pending"):
            raise RuntimeError("ComfyUI queue is not empty; external submissions are not allowed while the gateway owns gpu0")

        workflow = self._h3_workflow(job["id"], mode, prompt, width, height, frames, seed, steps, lora, staged, params)
        submission = http_json(base, "/prompt", {"prompt": workflow}, timeout=30)
        prompt_id = submission["prompt_id"]
        progress(0.05, "submitted_to_comfyui", prompt_id)
        started = time.monotonic()
        timeout = int(self.settings.raw["provider_timeout_seconds"])
        while time.monotonic() - started < timeout:
            if cancelled():
                try:
                    http_json(base, "/interrupt", {}, timeout=10)
                finally:
                    raise JobCancelled("H3 job interrupted by user request")
            history = http_json(base, f"/history/{prompt_id}", timeout=30)
            if prompt_id in history:
                item = history[prompt_id]
                status = item.get("status", {})
                if status.get("status_str") not in {None, "success"} or status.get("completed") is False:
                    messages = status.get("messages", [])
                    summary = []
                    for message in messages:
                        if not isinstance(message, list) or len(message) < 2 or not isinstance(message[1], dict):
                            continue
                        payload = message[1]
                        if message[0] == "execution_error":
                            summary.append(
                                {
                                    "node_type": payload.get("node_type"),
                                    "exception_type": payload.get("exception_type"),
                                    "exception_message": payload.get("exception_message"),
                                }
                            )
                    raise RuntimeError(json.dumps(summary or {"status": status.get("status_str")}, ensure_ascii=False))
                media = self._find_media(item.get("outputs", {}))
                output_root = Path(self.settings.raw["comfyui_output_root"])
                outputs = []
                for descriptor in media:
                    candidate = output_root / descriptor.get("subfolder", "") / descriptor["filename"]
                    if candidate.exists():
                        outputs.append(str(candidate))
                if not outputs:
                    raise RuntimeError("ComfyUI completed but returned no local media path")
                progress(1.0, "succeeded", prompt_id)
                self._last_h3_model_family = model_family
                self._last_comfy_model_family = comfy_family
                self._comfy_state_known = True
                return {
                    "provider": "comfyui",
                    "provider_run_id": prompt_id,
                    "outputs": outputs,
                    "profile": {"name": profile, "mode": mode, "width": width, "height": height, "frames": frames, "steps": steps, "seed": seed, "lora": lora,
                                **{key: options[key] for key in ("model_id", "precision", "checkpoint", "scheduler", "creative_presets", "preset_version")}},
                    "effective_prompt": options["effective_prompt"],
                    "h3_ir": options.get("h3_ir"),
                    "inputs": staged,
                }
            elapsed = time.monotonic() - started
            progress(min(0.9, 0.08 + elapsed / max(timeout, 1) * 0.82), "generating", prompt_id)
            time.sleep(3)
        raise TimeoutError(f"H3 job timed out after {timeout} seconds; provider run id: {prompt_id}")

    @staticmethod
    def _h3_sampling_profile(mode: str, params: dict[str, Any]) -> tuple[str, int, str | None]:
        profile = str(params.get("profile", "quality"))
        if mode == "reference" and profile == "preview4":
            steps = 4
            lora = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
        elif mode == "reference" and profile == "preview8":
            raise ValueError("H3 reference mode supports preview4 or quality; preview8 has no matching reference LoRA")
        elif profile == "preview4":
            steps = 4
            lora = "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors"
        elif profile == "preview8":
            steps = 8
            lora = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
        elif profile == "quality":
            steps = validated_steps(params.get("steps"), 30, 8, 60)
            lora = None
        else:
            raise ValueError("profile must be preview4, preview8, or quality")
        if profile != "quality" and params.get("steps") is not None:
            requested = validated_steps(params["steps"], steps, 1, 60)
            if requested != steps:
                raise ValueError(f"{profile} LoRA requires {steps} steps; select quality for custom steps")
        return profile, steps, lora

    @staticmethod
    def _find_media(value: Any) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        if isinstance(value, dict):
            if "filename" in value:
                found.append(value)
            for nested in value.values():
                found.extend(ProviderRegistry._find_media(nested))
        elif isinstance(value, list):
            for nested in value:
                found.extend(ProviderRegistry._find_media(nested))
        return found

    def _stage_image_inputs(self, job_id: str, params: dict[str, Any]) -> dict[str, str | None]:
        input_root = Path(self.settings.raw["comfyui_input_root"])
        target_root = input_root / "workbench" / job_id
        target_root.mkdir(parents=True, exist_ok=True)
        staged: dict[str, str | None] = {}
        for role in ("source_image", "reference_image", "mask_image", "style_image"):
            value = params.get(role)
            if not value:
                staged[role] = None
                continue
            source = Path(str(value))
            if not source.is_file():
                raise ValueError(f"Image input file does not exist: {source}")
            ensure_media_kind(source, "image", self.settings.raw["ffmpeg_executable"], role)
            suffix = source.suffix.lower()[:16]
            target = target_root / f"{role}{suffix}"
            shutil.copy2(source, target)
            staged[role] = target.relative_to(input_root).as_posix()
        return staged

    def _image(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        params = job["params"]
        job_type = str(job["type"])
        prompt = str(params.get("prompt", "")).strip()
        if not prompt:
            raise ValueError(f"{job_type} requires a non-empty prompt")
        width = int(params.get("width", 1024))
        height = int(params.get("height", 1024))
        if width < 512 or height < 512 or width % 16 or height % 16:
            raise ValueError("Image width and height must be multiples of 16 and at least 512")
        if width > 2048 or height > 2048 or width * height > 2048 * 2048:
            raise ValueError("Image canvas exceeds the current 2048-class acceptance boundary")
        seed = int(params.get("seed", 0))
        model_id = str(params.get("model_id", "krea2-turbo-bf16")).strip()
        catalog = {model["id"]: model for model in self._model_catalog() if model.get("modality") == "image"}
        selected = catalog.get(model_id)
        if selected is None:
            raise ValueError(f"Unknown local image model: {model_id}")
        if not selected.get("ready"):
            raise RuntimeError(f"Local image model is not enabled or its files are incomplete: {model_id}")

        staged: dict[str, str | None] = {}
        if job_type == "image.t2i":
            if model_id == "ideogram4-fp8":
                workflow, profile = build_ideogram_t2i(
                    job["id"], prompt, width, height, seed, str(params.get("style", "auto")), steps=params.get("steps")
                )
            elif model_id in KREA_MODELS:
                workflow, profile = build_krea_t2i(
                    job["id"], model_id, prompt, width, height, seed,
                    str(params.get("style", "auto")),
                    str(params.get("style_lora", "none")),
                    max(0.0, min(2.0, float(params.get("lora_strength", 1.0)))), steps=params.get("steps"),
                )
            else:
                raise ValueError(f"{model_id} does not support text-to-image")
        else:
            staged = self._stage_image_inputs(job["id"], params)
            if not staged.get("source_image"):
                raise ValueError(f"{job_type} requires a source_image input")
            if model_id == "ideogram4-fp8":
                raise ValueError("Ideogram 4 is enabled for text-to-image only")
            base_model_id = model_id if model_id in KREA_MODELS else "krea2-turbo-bf16"
            reference = staged.get("reference_image") or staged.get("style_image")
            if job_type == "image.i2i":
                strength = max(0.05, min(1.0, float(params.get("strength", 0.45))))
                ref_boost = 1.0 + strength * 6.0
            else:
                ref_boost = max(0.0, min(20.0, float(params.get("preservation", 4.0))))
            workflow, profile = build_krea_edit(
                job["id"], base_model_id, prompt, width, height, seed,
                str(staged["source_image"]), str(reference) if reference else None,
                str(staged["mask_image"]) if staged.get("mask_image") else None,
                ref_boost, steps=params.get("steps"),
            )
            profile["job_type"] = job_type

        comfy_family = "ideogram4" if model_id == "ideogram4-fp8" else "krea2"
        self._prepare_comfy_family(comfy_family, progress)
        base = self.settings.raw["comfyui_base_url"]
        queue = http_json(base, "/queue", timeout=10)
        if queue.get("queue_running") or queue.get("queue_pending"):
            raise RuntimeError("ComfyUI queue is not empty; external submissions are not allowed while the gateway owns gpu0")
        submission = http_json(base, "/prompt", {"prompt": workflow}, timeout=30)
        prompt_id = submission["prompt_id"]
        progress(0.05, "submitted_to_comfyui", prompt_id)
        started = time.monotonic()
        timeout = int(self.settings.raw["provider_timeout_seconds"])
        while time.monotonic() - started < timeout:
            if cancelled():
                try:
                    http_json(base, "/interrupt", {}, timeout=10)
                finally:
                    raise JobCancelled("Image job interrupted by user request")
            history = http_json(base, f"/history/{prompt_id}", timeout=30)
            if prompt_id in history:
                item = history[prompt_id]
                status = item.get("status", {})
                if status.get("status_str") not in {None, "success"} or status.get("completed") is False:
                    messages = status.get("messages", [])
                    summary = []
                    for message in messages:
                        if not isinstance(message, list) or len(message) < 2 or not isinstance(message[1], dict):
                            continue
                        payload = message[1]
                        if message[0] == "execution_error":
                            summary.append(
                                {
                                    "node_type": payload.get("node_type"),
                                    "exception_type": payload.get("exception_type"),
                                    "exception_message": payload.get("exception_message"),
                                }
                            )
                    raise RuntimeError(json.dumps(summary or {"status": status.get("status_str")}, ensure_ascii=False))
                media = self._find_media(item.get("outputs", {}))
                output_root = Path(self.settings.raw["comfyui_output_root"])
                outputs = []
                for descriptor in media:
                    candidate = output_root / descriptor.get("subfolder", "") / descriptor["filename"]
                    if candidate.exists():
                        outputs.append(str(candidate))
                if not outputs:
                    raise RuntimeError("ComfyUI completed but returned no local image path")
                progress(1.0, "succeeded", prompt_id)
                self._last_h3_model_family = None
                self._last_comfy_model_family = comfy_family
                self._comfy_state_known = True
                return {
                    "provider": "comfyui",
                    "provider_run_id": prompt_id,
                    "outputs": outputs,
                    "profile": profile,
                    "inputs": staged,
                }
            elapsed = time.monotonic() - started
            progress(min(0.9, 0.08 + elapsed / max(timeout, 1) * 0.82), "generating_image", prompt_id)
            time.sleep(2)
        raise TimeoutError(f"Image job timed out after {timeout} seconds; provider run id: {prompt_id}")

    def _stage_h3_inputs(self, job_id: str, mode: str, params: dict[str, Any]) -> dict[str, Any]:
        def string_list(key: str) -> list[str]:
            value = params.get(key, [])
            if value is None:
                return []
            if not isinstance(value, list):
                raise ValueError(f"{key} must be a list of local file paths")
            return [str(item) for item in value if item]

        requested: dict[str, list[str]] = {
            "first_frame": [str(params["first_frame"])] if params.get("first_frame") else [],
            "last_frame": [str(params["last_frame"])] if params.get("last_frame") else [],
            "reference_images": string_list("reference_images"),
            "reference_videos": string_list("reference_videos"),
            "reference_audios": string_list("reference_audios"),
            "guide_audio": [str(params["guide_audio"])] if params.get("guide_audio") else [],
        }
        allowed_roles = {
            "t2v": set(),
            "i2v": {"first_frame"},
            "fl2v": {"first_frame", "last_frame"},
            "reference": {"reference_images", "reference_videos", "reference_audios"},
            "audio_drive": {"guide_audio", "first_frame"},
        }[mode]
        unexpected = [role for role, values in requested.items() if values and role not in allowed_roles]
        if unexpected:
            raise ValueError(f"H3 {mode} mode does not accept: {', '.join(unexpected)}")
        if mode == "i2v" and not requested["first_frame"]:
            raise ValueError("i2v requires a first_frame input")
        if mode == "fl2v" and (not requested["first_frame"] or not requested["last_frame"]):
            raise ValueError("fl2v requires both first_frame and last_frame inputs")
        if mode == "reference" and not any(requested[key] for key in ("reference_images", "reference_videos", "reference_audios")):
            raise ValueError("reference mode requires at least one reference image, video, or audio")
        if len(requested["reference_images"]) > 9 or len(requested["reference_videos"]) > 3 or len(requested["reference_audios"]) > 3:
            raise ValueError("H3 reference limits are 9 images, 3 videos, and 3 standalone audios")
        if mode == "audio_drive" and not requested["guide_audio"]:
            raise ValueError("audio_drive requires guide_audio")

        input_root = Path(self.settings.raw["comfyui_input_root"])
        target_root = input_root / "workbench" / job_id
        target_root.mkdir(parents=True, exist_ok=True)
        staged: dict[str, Any] = {}
        for role, values in requested.items():
            outputs: list[str] = []
            for index, value in enumerate(values, start=1):
                source = Path(value)
                if not source.is_file():
                    raise ValueError(f"H3 input file does not exist: {source}")
                expected = "audio" if role in {"reference_audios", "guide_audio"} else "video" if role == "reference_videos" else "image"
                ensure_media_kind(source, expected, self.settings.raw["ffmpeg_executable"], role)
                suffix = source.suffix.lower()[:16]
                target = target_root / f"{role}_{index}{suffix}"
                shutil.copy2(source, target)
                outputs.append(target.relative_to(input_root).as_posix())
            if role in {"first_frame", "last_frame", "guide_audio"}:
                staged[role] = outputs[0] if outputs else None
            else:
                staged[role] = outputs
        return staged

    def _media_normalize(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        if cancelled():
            raise JobCancelled("Media normalization cancelled before start")
        params = job["params"]
        source = Path(str(params.get("source_path", "")))
        if not source.is_file():
            raise ValueError("media.normalize requires an existing source_path")
        progress(0.08, "inspecting_media", None)
        output_dir = Path(self.settings.raw["artifact_root"]) / job["id"]
        output, metadata = normalize_media(
            source,
            output_dir,
            self.settings.raw["ffmpeg_executable"],
            params,
        )
        if cancelled():
            output.unlink(missing_ok=True)
            raise JobCancelled("Media normalization cancelled")
        progress(1.0, "normalized", None)
        return {
            "provider": "ffmpeg-local",
            "outputs": [str(output)],
            "metadata": metadata,
            "profile": {
                "fit_mode": params.get("fit_mode", "contain"),
                "target_width": params.get("target_width"),
                "target_height": params.get("target_height"),
                "target_frame_rate": params.get("target_frame_rate"),
                "target_sample_rate": params.get("target_sample_rate"),
            },
        }

    @staticmethod
    def _h3_workflow(
        job_id: str,
        mode: str,
        prompt: str,
        width: int,
        height: int,
        frames: int,
        seed: int,
        steps: int,
        lora: str | None,
        staged: dict[str, Any],
        params: dict[str, Any],
    ) -> dict[str, Any]:
        model_node = "1"
        options = video_options(mode, {**params, "prompt": prompt})
        prompt = options["effective_prompt"]
        unet_name = options["checkpoint"]
        workflow: dict[str, Any] = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "type": "minimax", "device": "default"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
            "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        }
        if lora:
            workflow["5"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": lora, "strength_model": 1.0}}
            model_node = "5"
        conditioning_inputs: dict[str, Any]
        if mode == "reference":
            conditioning_inputs = {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "audio_vae": ["4", 0],
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": frames,
                "ref_image_size": str(params.get("ref_image_size", "match")),
            }
            workflow["6"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": conditioning_inputs}
        else:
            conditioning_inputs = {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "width": width, "height": height, "length": frames}
            workflow["6"] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": conditioning_inputs}

        next_node = 20

        def add_node(class_type: str, inputs: dict[str, Any]) -> str:
            nonlocal next_node
            node_id = str(next_node)
            next_node += 1
            workflow[node_id] = {"class_type": class_type, "inputs": inputs}
            return node_id

        if mode in {"i2v", "fl2v", "audio_drive"} and staged.get("first_frame"):
            loader = add_node("LoadImage", {"image": staged["first_frame"]})
            workflow["6"]["inputs"]["first_frame"] = [loader, 0]
        if mode == "fl2v" and staged.get("last_frame"):
            loader = add_node("LoadImage", {"image": staged["last_frame"]})
            workflow["6"]["inputs"]["last_frame"] = [loader, 0]

        if mode == "reference":
            for index, input_name in enumerate(staged.get("reference_images", [])):
                loader = add_node("LoadImage", {"image": input_name})
                workflow["6"]["inputs"][f"ref_images.ref_image_{index}"] = [loader, 0]
            for index, input_name in enumerate(staged.get("reference_videos", [])):
                loader = add_node("LoadVideo", {"file": input_name})
                components = add_node("GetVideoComponents", {"video": [loader, 0]})
                workflow["6"]["inputs"][f"ref_videos.ref_video_{index}"] = [components, 0]
                # Explicit IR audio labels refer to standalone audio inputs only.
                # Preserve legacy soundtrack behavior when the director is off.
                if params.get("h3_ir_enabled") is not True:
                    workflow["6"]["inputs"][f"ref_video_audios.ref_video_audio_{index}"] = [components, 1]
            for index, input_name in enumerate(staged.get("reference_audios", [])):
                loader = add_node("LoadAudio", {"audio": input_name})
                workflow["6"]["inputs"][f"ref_audios.ref_audio_{index}"] = [loader, 0]

        conditioning_node = "6"
        for anchor in options.get("h3_ir", {}).get("anchors", []):
            image = workflow["6"]["inputs"][f"ref_images.ref_image_{anchor['index']}"]
            conditioning_node = add_node("MiniMaxH3AddGuide", {
                "positive": [conditioning_node, 0], "latent": ["6", 1],
                "vae": ["3", 0], "image": image, "frame_idx": anchor["frame"],
            })
        if mode == "audio_drive":
            audio_loader = add_node("LoadAudio", {"audio": staged["guide_audio"]})
            guide_inputs: dict[str, Any] = {
                "positive": ["6", 0],
                "latent": ["6", 1],
                "frame_idx": int(params.get("guide_frame", 0)),
                "audio_vae": ["4", 0],
                "audio": [audio_loader, 0],
            }
            guide = add_node("MiniMaxH3AddGuide", guide_inputs)
            conditioning_node = guide

        workflow.update(
            {
                "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
                "8": {"class_type": "BasicGuider", "inputs": {"model": [model_node, 0], "conditioning": [conditioning_node, 0]}},
                "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
                "10": {"class_type": "BasicScheduler", "inputs": {"model": [model_node, 0], "scheduler": options["scheduler"], "steps": steps, "denoise": 1.0}},
                "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["8", 0], "sampler": ["9", 0], "sigmas": ["10", 0], "latent_image": ["6", 1]}},
                "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
                "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
                "14": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": 24.0, "bit_depth": "auto", "color_space": "sRGB"}},
                "15": {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": f"jobs/{job_id}/h3", "format": "auto", "codec": "auto"}},
            }
        )
        return workflow

    def _subprocess_provider(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled, provider: str) -> dict[str, Any]:
        if cancelled():
            raise JobCancelled(f"{provider} job cancelled before start")
        raw = self.settings.raw
        artifact_dir = Path(raw["artifact_root"]) / job["id"]
        artifact_dir.mkdir(parents=True, exist_ok=True)
        params = job["params"]

        if provider == "tts":
            executable = Path(raw["tts_python"])
            adapter = Path(raw["tts_adapter"])
            reference_audio = Path(str(params.get("reference_audio", "")))
            text = str(params.get("text", "")).strip()
            language = str(params.get("language", "ZH")).upper()
            if not reference_audio.is_file():
                raise ValueError("tts.clone requires an existing reference_audio file")
            if not text:
                raise ValueError("tts.clone requires non-empty text")
            if language not in {"ZH", "EN", "JA", "ES", "AR"}:
                raise ValueError("language must be ZH, EN, JA, ES, or AR")
            request_payload = {
                "model_root": raw["tts_model_root"],
                "source_root": raw["tts_source_root"],
                "reference_audio": str(reference_audio.resolve()),
                "text": text,
                "language": language,
                "output_path": str(artifact_dir / "tts.wav"),
                "seed": int(params.get("seed", 0)),
                "duration_factor": float(params.get("duration_factor", 1.0)),
                "emotion_audio": params.get("emotion_audio"),
                "emotion_vector": params.get("emotion_vector"),
                "use_emotion_text": bool(params.get("use_emotion_text", False)),
                "emotion_text": params.get("emotion_text"),
            }
            stage = "synthesizing_voice"
        elif provider == "music":
            executable = Path(raw["music_python"])
            adapter = Path(raw["music_adapter"])
            prompt_text = str(params.get("prompt", "")).strip()
            lyrics = str(params.get("lyrics", "")).strip()
            if not prompt_text:
                raise ValueError("music.generate requires non-empty prompt")
            if not lyrics:
                raise ValueError("music.generate requires non-empty lyrics")
            request_payload = {
                "model_root": raw["music_model_root"],
                "prompt": prompt_text,
                "lyrics": lyrics,
                "duration_seconds": float(params.get("duration_seconds", 30.0)),
                "seed": int(params.get("seed", 0)),
                "output_path": str(artifact_dir / "music.wav"),
            }
            stage = "generating_music"
        elif provider == "foley":
            executable = Path(raw["foley_python"])
            adapter = Path(raw["foley_adapter"])
            video_path = Path(str(params.get("video_path", "")))
            prompt_text = str(params.get("prompt", "")).strip()
            if not video_path.is_file():
                raise ValueError("foley.generate requires an existing video_path file")
            if not prompt_text:
                raise ValueError("foley.generate requires a non-empty sound-effect description")
            request_payload = {
                "source_root": raw["foley_source_root"],
                "model_root": raw["foley_model_root"],
                "siglip_root": raw["foley_siglip_root"],
                "clap_root": raw["foley_clap_root"],
                "video_path": str(video_path.resolve()),
                "prompt": prompt_text,
                "negative_prompt": str(params.get("negative_prompt", "noisy, harsh, music, speech, dialogue")),
                "steps": int(params.get("steps", 50)),
                "guidance_scale": float(params.get("guidance_scale", 4.5)),
                "seed": int(params.get("seed", 1)),
                "enable_offload": bool(params.get("enable_offload", True)),
                "output_path": str(artifact_dir / "foley.wav"),
            }
            stage = "generating_foley"
        else:
            raise ValueError(f"unknown subprocess provider: {provider}")

        if not executable.is_file():
            raise RuntimeError(f"{provider} Python environment is not installed: {executable}")
        if not adapter.is_file():
            raise RuntimeError(f"{provider} adapter is missing: {adapter}")
        ready_file = Path(raw[f"{provider}_ready_file"])
        if not ready_file.is_file():
            raise RuntimeError(f"{provider} runtime has not passed its local readiness check: {ready_file}")

        request_path = artifact_dir / f"{provider}-request.json"
        request_path.write_text(json.dumps(request_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._free_comfy_memory()
        progress(0.05, "released_comfyui_memory", None)
        command = [str(executable), "-I", str(adapter), "--request-file", str(request_path)]
        return self._run_adapter(job, command, artifact_dir / f"{provider}.log", stage, progress, cancelled)

    def _run_adapter(
        self,
        job: dict[str, Any],
        command: list[str],
        log_path: Path,
        stage: str,
        progress: Progress,
        cancelled: IsCancelled,
    ) -> dict[str, Any]:
        timeout = int(self.settings.raw["provider_timeout_seconds"])
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        started = time.monotonic()
        with log_path.open("w", encoding="utf-8", errors="replace") as stream:
            process = subprocess.Popen(
                command,
                stdout=stream,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            while process.poll() is None:
                elapsed = time.monotonic() - started
                if cancelled():
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    raise JobCancelled(f"{job['type']} process cancelled")
                if elapsed >= timeout:
                    process.kill()
                    process.wait(timeout=10)
                    raise TimeoutError(f"{job['type']} timed out after {timeout} seconds")
                progress(min(0.9, 0.1 + elapsed / max(timeout, 1) * 0.8), stage, str(process.pid))
                time.sleep(1)
            return_code = process.returncode

        log_text = log_path.read_text(encoding="utf-8", errors="replace")
        if return_code != 0:
            raise RuntimeError(log_text[-12000:] or f"adapter exited with code {return_code}")
        marker = "WORKBENCH_RESULT="
        result_line = next((line[len(marker):] for line in reversed(log_text.splitlines()) if line.startswith(marker)), None)
        if not result_line:
            raise RuntimeError(f"adapter completed without a structured result; log: {log_path}")
        result = json.loads(result_line)
        result["log"] = str(log_path)
        progress(1.0, "succeeded", None)
        return result

    @staticmethod
    def _dialogue_lines(params: dict[str, Any]) -> list[dict[str, Any]]:
        raw_lines = params.get("lines")
        if not isinstance(raw_lines, list) or not 1 <= len(raw_lines) <= 16:
            raise ValueError("dialogue.generate requires between 1 and 16 dialogue lines")
        result: list[dict[str, Any]] = []
        for index, raw_line in enumerate(raw_lines):
            if not isinstance(raw_line, dict):
                raise ValueError(f"dialogue line {index + 1} must be an object")
            text = str(raw_line.get("text", "")).strip()
            reference_audio = Path(str(raw_line.get("reference_audio", "")))
            language = str(raw_line.get("language", "ZH")).upper()
            if not text:
                raise ValueError(f"dialogue line {index + 1} requires non-empty text")
            if not reference_audio.is_file():
                raise ValueError(f"dialogue line {index + 1} requires an existing reference_audio file")
            if language not in {"ZH", "EN", "JA", "ES", "AR"}:
                raise ValueError(f"dialogue line {index + 1} has unsupported language: {language}")
            result.append({
                "speaker": str(raw_line.get("speaker", f"角色{index + 1}")).strip() or f"角色{index + 1}",
                "text": text,
                "reference_audio": reference_audio,
                "language": language,
                "gap_seconds": max(0.0, min(5.0, float(raw_line.get("gap_seconds", 0.35)))),
                "seed": int(raw_line.get("seed", params.get("seed", 0))) + index,
            })
        return result

    def _dialogue_generate(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        if cancelled():
            raise JobCancelled("dialogue.generate cancelled before start")
        raw = self.settings.raw
        executable = Path(raw["tts_python"])
        adapter = Path(raw["tts_adapter"])
        ready_file = Path(raw["tts_ready_file"])
        if not executable.is_file():
            raise RuntimeError(f"tts Python environment is not installed: {executable}")
        if not adapter.is_file():
            raise RuntimeError(f"tts adapter is missing: {adapter}")
        if not ready_file.is_file():
            raise RuntimeError(f"tts runtime has not passed its local readiness check: {ready_file}")
        lines = self._dialogue_lines(job["params"])
        artifact_dir = Path(raw["artifact_root"]) / job["id"]
        artifact_dir.mkdir(parents=True, exist_ok=True)
        self._free_comfy_memory()
        progress(0.03, "released_comfyui_memory", None)
        outputs: list[str] = []
        speakers: list[str] = []
        for index, line in enumerate(lines):
            if cancelled():
                raise JobCancelled("dialogue.generate cancelled between lines")
            line_dir = artifact_dir / f"line-{index + 1:02d}"
            line_dir.mkdir(parents=True, exist_ok=True)
            output_path = line_dir / "voice.wav"
            request_payload = {
                "model_root": raw["tts_model_root"],
                "source_root": raw["tts_source_root"],
                "reference_audio": str(line["reference_audio"].resolve()),
                "text": line["text"],
                "language": line["language"],
                "output_path": str(output_path),
                "seed": line["seed"],
                "duration_factor": 1.0,
                "emotion_audio": None,
                "emotion_vector": None,
                "use_emotion_text": False,
                "emotion_text": None,
            }
            request_path = line_dir / "tts-request.json"
            request_path.write_text(json.dumps(request_payload, ensure_ascii=False, indent=2), encoding="utf-8")
            command = [str(executable), "-I", str(adapter), "--request-file", str(request_path)]

            def line_progress(value: float, stage: str, pid: str | None, line_index: int = index) -> None:
                progress(0.04 + ((line_index + min(1.0, value)) / len(lines)) * 0.76, f"dialogue_{stage}", pid)

            self._run_adapter(job, command, line_dir / "tts.log", "synthesizing_dialogue", line_progress, cancelled)
            if not output_path.is_file():
                raise RuntimeError(f"dialogue line {index + 1} completed without audio output")
            outputs.append(str(output_path))
            speakers.append(str(line["speaker"]))

        if len(outputs) == 1:
            final_path = artifact_dir / "dialogue-sequence.wav"
            shutil.copy2(outputs[0], final_path)
            progress(1.0, "succeeded", None)
            return {
                "provider": "indextts2.5",
                "outputs": [str(final_path)],
                "profile": {
                    "input_count": 1,
                    "line_count": 1,
                    "speakers": speakers,
                    "languages": [lines[0]["language"]],
                    "assembly": "direct-copy",
                },
            }

        sequence_job = {
            **job,
            "params": {
                "inputs": outputs,
                "gaps": [line["gap_seconds"] for line in lines[:-1]],
                "_dialogue_internal": True,
            },
        }

        def sequence_progress(value: float, stage: str, pid: str | None) -> None:
            progress(0.8 + min(1.0, value) * 0.2, stage, pid)

        result = self._audio_sequence(sequence_job, sequence_progress, cancelled)
        result["provider"] = "indextts2.5+ffmpeg"
        result["profile"] = {
            **result.get("profile", {}),
            "line_count": len(lines),
            "speakers": speakers,
            "languages": [line["language"] for line in lines],
        }
        return result

    def _audio_sequence(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        params = job["params"]
        inputs = [Path(str(value)) for value in params.get("inputs", []) if value]
        internal_dialogue = bool(params.get("_dialogue_internal"))
        minimum, maximum = (1, 16) if internal_dialogue else (2, 6)
        if len(inputs) < minimum or len(inputs) > maximum:
            raise ValueError(f"audio.sequence requires between {minimum} and {maximum} audio inputs")
        missing = [str(path) for path in inputs if not path.is_file()]
        if missing:
            raise ValueError(f"audio.sequence input does not exist: {missing[0]}")
        gap = max(0.0, min(5.0, float(params.get("gap_seconds", 0.35))))
        raw_gaps = params.get("gaps")
        gaps = [max(0.0, min(5.0, float(value))) for value in raw_gaps] if isinstance(raw_gaps, list) else []
        executable = Path(self.settings.raw["ffmpeg_executable"])
        if not executable.is_file():
            raise RuntimeError(f"FFmpeg executable is missing: {executable}")

        artifact_dir = Path(self.settings.raw["artifact_root"]) / job["id"]
        artifact_dir.mkdir(parents=True, exist_ok=True)
        output_path = artifact_dir / "dialogue-sequence.wav"
        log_path = artifact_dir / "audio-sequence.log"
        command = [str(executable), "-hide_banner", "-nostdin", "-y"]
        for path in inputs:
            command.extend(["-i", str(path.resolve())])
        filters = [f"[{index}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a{index}]" for index in range(len(inputs))]
        concat_inputs: list[str] = []
        for index in range(len(inputs)):
            concat_inputs.append(f"[a{index}]")
            selected_gap = gaps[index] if index < len(gaps) else gap
            if index < len(inputs) - 1 and selected_gap > 0:
                filters.append(f"anullsrc=channel_layout=stereo:sample_rate=44100:d={selected_gap:.3f}[g{index}]")
                concat_inputs.append(f"[g{index}]")
        filters.append("".join(concat_inputs) + f"concat=n={len(concat_inputs)}:v=0:a=1[outa]")
        command.extend(["-filter_complex", ";".join(filters), "-map", "[outa]", "-c:a", "pcm_s16le", str(output_path)])

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        started = time.monotonic()
        with log_path.open("w", encoding="utf-8", errors="replace") as stream:
            process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=creationflags)
            while process.poll() is None:
                if cancelled():
                    process.terminate()
                    raise JobCancelled("audio.sequence process cancelled")
                progress(min(0.9, 0.12 + (time.monotonic() - started) / 60.0), "assembling_dialogue", str(process.pid))
                time.sleep(0.2)
            return_code = process.returncode
        if return_code != 0 or not output_path.is_file():
            log_text = log_path.read_text(encoding="utf-8", errors="replace")
            raise RuntimeError(log_text[-12000:] or f"FFmpeg exited with code {return_code}")
        progress(1.0, "succeeded", None)
        return {
            "provider": "ffmpeg",
            "outputs": [str(output_path)],
            "log": str(log_path),
            "profile": {"input_count": len(inputs), "gap_seconds": gap, "gaps": gaps, "sample_rate": 44100, "channels": 2},
        }

    def _h3_prompt(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        params = job["params"]
        video = params.get("video_params")
        if not isinstance(video, dict) or video.get("h3_ir_enabled") is not True:
            raise ValueError("请先启用H3-IR导演台")
        mode = str(video.get("mode", "t2v"))
        options = video_options(mode, video)
        base = video_options(mode, {**video, "h3_ir_enabled": False})["effective_prompt"]
        model = str(params.get("model_id", "qwen3.6-27b-q4"))
        request = {**job, "params": {"model_id": model, "prompt": enhancement_instruction(options["h3_ir"], video, base), "context": 16384, "max_tokens": 4096, "temperature": 0.15, "reasoning": False}}
        response = self._agent(request, progress, cancelled)
        if cancelled():
            raise JobCancelled("H3 prompt optimization cancelled")
        enhanced = apply_enhancement(response["text"], options["h3_ir"], video, model)
        compiled = video_options(mode, enhanced)["h3_ir"]
        artifact_dir = Path(self.settings.raw["artifact_root"]) / job["id"]
        artifact_dir.mkdir(parents=True, exist_ok=True)
        report = artifact_dir / "h3-ir.txt"
        report.write_text(compiled["effective_prompt"], encoding="utf-8")
        return {**response, "text": compiled["effective_prompt"], "outputs": [str(report)], "director_json": enhanced["director_json"], "h3_ir": compiled}

    def _agent(self, job: dict[str, Any], progress: Progress, cancelled: IsCancelled) -> dict[str, Any]:
        raw = self.settings.raw
        params = job["params"]
        model_id = str(params.get("model_id", "qwen3.6-27b-q4")).strip()
        selected = next((model for model in self._prompt_catalog() if model.get("id") == model_id), None)
        if not selected or not selected.get("ready"):
            raise ValueError(f"Local prompt model is not available: {model_id}")
        prompt_text = str(params.get("prompt", "")).strip()
        if not prompt_text:
            raise ValueError("agent.chat requires prompt")
        context = max(2048, min(32768, int(params.get("context", 8192))))
        max_tokens = max(1, min(4096, int(params.get("max_tokens", 512))))
        temperature = max(0.0, min(2.0, float(params.get("temperature", 0.2))))
        if selected.get("backend") == "ollama":
            return self._agent_ollama(job, selected, prompt_text, context, max_tokens, temperature, progress, cancelled)

        executable = Path(raw["llama_cli"])
        if not executable.is_file():
            raise RuntimeError(f"llama.cpp executable is missing: {executable}")
        artifact_dir = Path(raw["artifact_root"]) / job["id"]
        artifact_dir.mkdir(parents=True, exist_ok=True)
        response_path = artifact_dir / "agent-response.txt"
        log_path = artifact_dir / "agent.log"
        self._free_comfy_memory()
        progress(0.05, "released_comfyui_memory", None)
        command = [
            str(executable), "-m", raw["agent_model"], "-ngl", "99", "-c", str(context),
            "-n", str(max_tokens), "--temp", str(temperature), "--simple-io", "--no-display-prompt",
            "--log-disable", "-fa", "on", "-st", "-rea", "on" if bool(params.get("reasoning", False)) else "off",
            "-o", str(response_path), "-p", prompt_text,
        ]
        timeout = int(raw["provider_timeout_seconds"])
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        started = time.monotonic()
        with log_path.open("w", encoding="utf-8", errors="replace") as stream:
            process = subprocess.Popen(
                command,
                cwd=str(executable.parent),
                stdout=stream,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            while process.poll() is None:
                elapsed = time.monotonic() - started
                if cancelled():
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    raise JobCancelled("agent.chat process cancelled")
                if elapsed >= timeout:
                    process.kill()
                    process.wait(timeout=10)
                    raise TimeoutError(f"agent.chat timed out after {timeout} seconds")
                progress(min(0.9, 0.08 + elapsed / max(timeout, 1) * 0.82), "generating_agent_response", str(process.pid))
                time.sleep(0.5)
            return_code = process.returncode

        log_text = log_path.read_text(encoding="utf-8", errors="replace")
        if return_code != 0:
            raise RuntimeError(log_text[-12000:] or f"llama-cli exited with code {return_code}")
        if not response_path.is_file():
            raise RuntimeError(f"llama-cli completed without an output file; log: {log_path}")
        response_text = response_path.read_text(encoding="utf-8-sig", errors="replace")
        separator = "\nAssistant:\n"
        answer = response_text.rsplit(separator, 1)[-1].strip() if separator in response_text else response_text.strip()
        if not answer:
            raise RuntimeError(f"llama-cli produced an empty answer; log: {log_path}")
        progress(1.0, "succeeded", None)
        return {
            "provider": "llama.cpp",
            "text": answer,
            "outputs": [str(response_path)],
            "log": str(log_path),
            "profile": {"context": context, "max_tokens": max_tokens, "temperature": temperature},
        }

    def _agent_ollama(
        self,
        job: dict[str, Any],
        model: dict[str, Any],
        prompt_text: str,
        context: int,
        max_tokens: int,
        temperature: float,
        progress: Progress,
        cancelled: IsCancelled,
    ) -> dict[str, Any]:
        raw = self.settings.raw
        artifact_dir = Path(raw["artifact_root"]) / job["id"]
        artifact_dir.mkdir(parents=True, exist_ok=True)
        response_path = artifact_dir / "agent-response.txt"
        log_path = artifact_dir / "agent-ollama.json"
        self._free_comfy_memory()
        progress(0.05, "released_comfyui_memory", None)
        payload = {
            "model": model["ollama_model"],
            "prompt": prompt_text,
            "stream": True,
            "keep_alive": 0,
            "think": bool(job["params"].get("reasoning", False)),
            "options": {
                "num_ctx": context,
                "num_predict": max_tokens,
                "temperature": temperature,
            },
        }
        request = urllib.request.Request(
            raw["ollama_base_url"].rstrip("/") + "/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        chunks: list[str] = []
        final: dict[str, Any] = {}
        started = time.monotonic()
        timeout = int(raw["provider_timeout_seconds"])
        with urllib.request.urlopen(request, timeout=min(timeout, 120)) as response:
            while True:
                if cancelled():
                    raise JobCancelled("agent.chat Ollama stream cancelled")
                if time.monotonic() - started >= timeout:
                    raise TimeoutError(f"agent.chat timed out after {timeout} seconds")
                line = response.readline()
                if not line:
                    break
                event = json.loads(line.decode("utf-8"))
                if event.get("error"):
                    raise RuntimeError(str(event["error"]))
                if event.get("response"):
                    chunks.append(str(event["response"]))
                final = event
                count = int(event.get("eval_count") or len(chunks))
                progress(min(0.92, 0.08 + count / max(max_tokens, 1) * 0.84), "generating_agent_response", str(model["ollama_model"]))
                if event.get("done"):
                    break
        answer = "".join(chunks).strip()
        if not answer:
            raise RuntimeError("Ollama completed without response text")
        response_path.write_text(answer, encoding="utf-8")
        log_path.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
        progress(1.0, "succeeded", str(model["ollama_model"]))
        return {
            "provider": "ollama",
            "text": answer,
            "outputs": [str(response_path)],
            "log": str(log_path),
            "profile": {
                "model_id": model["id"],
                "ollama_model": model["ollama_model"],
                "context": context,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "eval_count": final.get("eval_count"),
                "total_duration_ns": final.get("total_duration"),
            },
        }
