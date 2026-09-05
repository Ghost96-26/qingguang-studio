from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from services.orchestrator.workbench.providers import ProviderRegistry
from services.orchestrator.workbench.store import JobStore
from services.orchestrator.workbench.image_workflows import build_krea_t2i, build_krea_edit, build_ideogram_t2i


class ProjectManagementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.store = JobStore(Path(self.temp.name) / "workbench.db")
        self.store.initialize()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_project_group_move_trash_and_restore_are_recoverable(self) -> None:
        group = self.store.create_project_group("分镜制作")
        project = self.store.create_project("镜头 A")
        moved = self.store.update_project(project["id"], group_id=group["id"])
        self.assertEqual(moved["group_id"], group["id"])

        trashed = self.store.trash_project(project["id"])
        self.assertIsNotNone(trashed["deleted_at"])
        self.assertIsNone(self.store.get_project(project["id"]))
        self.assertTrue(any(item["id"] == project["id"] for item in self.store.list_projects(include_deleted=True)))

        restored = self.store.restore_project(project["id"])
        self.assertIsNone(restored["deleted_at"])
        self.assertEqual(self.store.get_canvas(project["id"])["state"]["nodes"], [])

    def test_default_project_cannot_be_trashed(self) -> None:
        with self.assertRaisesRegex(ValueError, "default demonstration"):
            self.store.trash_project("default")

    def test_asset_folders_classify_and_recover_assets_without_moving_files(self) -> None:
        project = self.store.create_project("资产分类")
        folders = self.store.list_asset_folders(project["id"])
        self.assertEqual({item["system_key"] for item in folders}, {"scene", "character", "prop", "unfiled"})
        source = Path(self.temp.name) / "hero.png"
        source.write_bytes(b"png-placeholder")
        asset = self.store.register_asset(project["id"], "image", "主人公.png", source, "image/png")
        self.assertEqual(next(item for item in folders if item["system_key"] == "unfiled")["id"], asset["folder_id"])

        custom = self.store.create_asset_folder(project["id"], "第一场", parent_id=next(item for item in folders if item["system_key"] == "scene")["id"])
        moved = self.store.update_asset(asset["id"], folder_id=custom["id"])
        self.assertEqual(custom["id"], moved["folder_id"])
        self.assertTrue(self.store.delete_asset_folder(custom["id"]))
        recovered = self.store.get_asset(asset["id"])
        self.assertEqual(next(item for item in folders if item["system_key"] == "unfiled")["id"], recovered["folder_id"])
        self.assertEqual(source.resolve(), Path(recovered["source_path"]))


class H3CapabilityContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = object.__new__(ProviderRegistry)

    def test_reference_limits_are_enforced_before_file_staging(self) -> None:
        with self.assertRaisesRegex(ValueError, "9 images, 3 videos"):
            self.registry._stage_h3_inputs("job", "reference", {
                "reference_images": [f"image-{index}.png" for index in range(10)],
            })

    def test_mode_rejects_stale_incompatible_inputs(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not accept"):
            self.registry._stage_h3_inputs("job", "i2v", {
                "first_frame": "first.png",
                "reference_audios": ["voice.wav"],
            })

    def test_reference_collections_must_be_lists(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be a list"):
            self.registry._stage_h3_inputs("job", "reference", {"reference_images": "image.png"})

    def test_clean_runtime_does_not_restart_before_first_model_family(self) -> None:
        self.registry._comfy_state_known = True
        self.registry._last_comfy_model_family = None
        restarts: list[str] = []
        self.registry._restart_comfy_runtime = restarts.append

        self.registry._prepare_comfy_family("h3-fl2va")

        self.assertEqual(restarts, [])

    def test_runtime_probe_marks_externally_started_worker_clean(self) -> None:
        self.registry.settings = SimpleNamespace(raw={"comfyui_base_url": "http://127.0.0.1:8188"})
        self.registry._comfy_state_known = False
        self.registry._last_h3_model_family = "stale"
        self.registry._last_comfy_model_family = "image-krea"
        self.registry.capabilities = lambda: {"status": "ready"}

        with patch("services.orchestrator.workbench.providers.http_json", return_value={"nodes": {}}):
            result = self.registry.ensure_comfy_runtime()

        self.assertEqual(result, {"status": "ready"})
        self.assertTrue(self.registry._comfy_state_known)
        self.assertIsNone(self.registry._last_h3_model_family)
        self.assertIsNone(self.registry._last_comfy_model_family)

    def test_reference_quality_is_native_and_preview8_is_never_silently_downgraded(self) -> None:
        profile, steps, lora = self.registry._h3_sampling_profile("reference", {"profile": "quality", "steps": 20})
        self.assertEqual((profile, steps, lora), ("quality", 20, None))
        with self.assertRaisesRegex(ValueError, "no matching reference LoRA"):
            self.registry._h3_sampling_profile("reference", {"profile": "preview8"})

    def test_custom_native_steps_reach_scheduler_without_lora(self) -> None:
        for steps in (20, 25, 30, 40, 50, 60):
            profile, actual, lora = self.registry._h3_sampling_profile("reference", {"profile": "quality", "steps": steps})
            graph = self.registry._h3_workflow("job", "reference", "test", 832, 480, 124, 7, actual, lora, {}, {})
            self.assertEqual(graph["10"]["inputs"]["steps"], steps)
            self.assertEqual(graph["6"]["inputs"]["width"], 832)
            self.assertFalse(any(node["class_type"] == "LoraLoaderModelOnly" for node in graph.values()))

    def test_invalid_steps_and_turbo_mismatch_are_rejected(self) -> None:
        for value in (0, -1, 61, 30.5, True, "bad"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.registry._h3_sampling_profile("t2v", {"profile": "quality", "steps": value})
        with self.assertRaisesRegex(ValueError, "requires 8 steps"):
            self.registry._h3_sampling_profile("t2v", {"profile": "preview8", "steps": 30})

    def test_image_selected_steps_reach_each_sampler_and_result_profile(self) -> None:
        graph, profile = build_krea_t2i("job", "krea2-raw-bf16", "test", 1536, 1024, 7, steps=50)
        self.assertEqual(graph["8"]["inputs"]["steps"], 50)
        self.assertEqual(profile["steps"], 50)
        graph, profile = build_krea_edit("job", "krea2-turbo-bf16", "test", 1024, 1024, 7, "input.png", None, None, 4, steps=16)
        self.assertEqual(graph["14"]["inputs"]["steps"], 16)
        self.assertEqual(profile["steps"], 16)
        graph, profile = build_ideogram_t2i("job", "test", 1024, 1024, 7, steps=60)
        self.assertEqual(graph["12"]["inputs"]["steps"], 60)
        self.assertEqual(profile["steps"], 60)
        with self.assertRaises(ValueError):
            build_krea_t2i("job", "krea2-turbo-bf16", "test", 1024, 1024, 7, steps=60)

    def test_dialogue_contract_supports_multilingual_turn_taking(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            voice_a = Path(directory) / "voice-a.wav"
            voice_b = Path(directory) / "voice-b.wav"
            voice_a.write_bytes(b"RIFF-test-a")
            voice_b.write_bytes(b"RIFF-test-b")
            lines = self.registry._dialogue_lines({
                "seed": 9,
                "lines": [
                    {"speaker": "甲", "text": "先走这边。", "language": "ZH", "reference_audio": str(voice_a), "gap_seconds": .25},
                    {"speaker": "乙", "text": "I will follow.", "language": "EN", "reference_audio": str(voice_b), "gap_seconds": .6},
                ],
            })
            self.assertEqual([line["speaker"] for line in lines], ["甲", "乙"])
            self.assertEqual([line["language"] for line in lines], ["ZH", "EN"])
            self.assertEqual([line["seed"] for line in lines], [9, 10])
            self.assertEqual([line["gap_seconds"] for line in lines], [.25, .6])
            self.assertIn("dialogue.generate", ProviderRegistry.SUPPORTED_TYPES)
            self.assertIn("foley.generate", ProviderRegistry.SUPPORTED_TYPES)

    def test_dialogue_contract_rejects_missing_voice_or_empty_line(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-empty text"):
            self.registry._dialogue_lines({"lines": [{"text": "", "reference_audio": "missing.wav"}]})
        with self.assertRaisesRegex(ValueError, "existing reference_audio"):
            self.registry._dialogue_lines({"lines": [{"text": "有效台词", "reference_audio": "missing.wav"}]})

    def test_single_dialogue_line_skips_ffmpeg_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "python.exe"
            adapter = root / "adapter.py"
            ready = root / "ready.json"
            reference = root / "voice.wav"
            for path in (executable, adapter, ready, reference):
                path.write_bytes(b"ready")
            self.registry.settings = SimpleNamespace(raw={
                "tts_python": str(executable),
                "tts_adapter": str(adapter),
                "tts_ready_file": str(ready),
                "tts_model_root": str(root / "model"),
                "tts_source_root": str(root / "source"),
                "artifact_root": str(root / "artifacts"),
            })
            self.registry._free_comfy_memory = lambda: None

            def synthesize(_job, command, _log, _stage, line_progress, _cancelled):
                request = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
                Path(request["output_path"]).write_bytes(b"RIFF-single-line")
                line_progress(1.0, "succeeded", None)

            self.registry._run_adapter = synthesize
            self.registry._audio_sequence = lambda *_args: self.fail("single line must not enter FFmpeg sequence")
            result = self.registry._dialogue_generate({
                "id": "single-line",
                "params": {"lines": [{"speaker": "甲", "text": "只说一句。", "language": "ZH", "reference_audio": str(reference)}]},
            }, lambda *_args: None, lambda: False)
            self.assertEqual(result["provider"], "indextts2.5")
            self.assertEqual(result["profile"]["assembly"], "direct-copy")
            self.assertEqual(Path(result["outputs"][0]).read_bytes(), b"RIFF-single-line")


if __name__ == "__main__":
    unittest.main()
