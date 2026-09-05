from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from services.orchestrator.workbench.providers import ProviderRegistry
from services.orchestrator.workbench.video_options import video_catalog, video_options


class VideoOptionsTests(unittest.TestCase):
    def test_invalid_dimensions_fail_before_loading_or_gpu_submission(self):
        registry = object.__new__(ProviderRegistry)
        registry._stage_h3_inputs = Mock()
        registry._prepare_comfy_family = Mock()
        for width, height, reason in ((1534,768,"multiples of 32"),(1536,768,"exceeds the validated H3 native area")):
            with self.subTest(width=width), patch("services.orchestrator.workbench.providers.http_json") as request:
                with self.assertRaisesRegex(ValueError, reason):
                    registry._h3_t2v({"id":"invalid-size","params":{"prompt":"同条件对照","mode":"reference","width":width,"height":height}},lambda *_:None,lambda:False)
                request.assert_not_called()
        registry._stage_h3_inputs.assert_not_called()
        registry._prepare_comfy_family.assert_not_called()

    def test_legacy_params_keep_exact_prompt_simple_scheduler_and_model_family(self):
        for mode, family in (("t2v","fl2va"),("reference","ref2va")):
            value = video_options(mode, {"prompt":"原始提示词"})
            self.assertEqual(value["effective_prompt"], "原始提示词")
            self.assertEqual(value["scheduler"], "simple")
            self.assertIn(family, value["checkpoint"])

    def test_all_presets_reach_conditioning_not_just_the_ui(self):
        catalog = video_catalog()
        for group in catalog["groups"]:
            for option in group["options"]:
                with self.subTest(group=group["key"], preset=option["id"]):
                    params = {"prompt":"两人平稳交谈。",group["key"]:option["id"],"scheduler":"beta"}
                    original = copy.deepcopy(params)
                    graph = ProviderRegistry._h3_workflow("test", "reference", params["prompt"], 1344,768,124,7,40,None,{},params)
                    self.assertEqual(graph["6"]["inputs"]["prompt"],video_options("reference",params)["effective_prompt"])
                    self.assertEqual(graph["10"]["inputs"]["scheduler"],"beta")
                    self.assertEqual(graph["10"]["inputs"]["steps"],40)
                    self.assertEqual(graph["6"]["inputs"]["width"],1344)
                    self.assertEqual(params,original)
                    self.assertFalse(any(n["class_type"] == "LoraLoaderModelOnly" for n in graph.values()))

    def test_composition_is_reversible_and_deterministic(self):
        params = {"prompt":"两人平稳交谈。","video_style":"fuji-classic","camera_lens":"cooke-s4","focal_length":"85mm"}
        catalog = video_catalog()
        texts = [next(o["text"] for o in group["options"] if o["id"] == params[group["key"]]) for group in catalog["groups"] if group["key"] in params]
        expected = params["prompt"] + "\n\n" + catalog["guidance_header"] + "\n" + "\n".join(texts)
        self.assertEqual(video_options("reference",params)["effective_prompt"],expected)
        self.assertEqual(video_options("reference",params)["effective_prompt"],expected)
        cleared = {**params,**{group["key"]:"none" for group in catalog["groups"]}}
        self.assertEqual(video_options("reference",cleared)["effective_prompt"],params["prompt"])

    def test_invalid_model_mode_scheduler_and_style_are_rejected(self):
        cases = [
            {"model_id":"bf16"}, {"video_style":"unknown"}, {"scheduler":"unknown"},
            {"profile":"preview8","model_id":"h3-int8-turbo8"},
            {"profile":"preview4","scheduler":"beta"},
            {"profile":"quality","model_id":"h3-int8-turbo4"},
        ]
        for params in cases:
            with self.subTest(params=params), self.assertRaises(ValueError):
                video_options("reference",params)

    def test_job_submission_and_result_report_the_same_effective_parameters(self):
        registry = object.__new__(ProviderRegistry)
        registry._stage_h3_inputs = Mock(return_value={})
        registry._prepare_comfy_family = Mock()
        params = {"prompt":"两人交谈。","mode":"reference","profile":"quality","model_id":"h3-int8-native","steps":40,"width":768,"height":1344,"duration_seconds":10,"scheduler":"beta","video_style":"woodcut","camera_motion":"locked"}
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,"result.mp4").touch()
            registry.settings = SimpleNamespace(raw={"comfyui_base_url":"http://unused.invalid","comfyui_output_root":directory,"provider_timeout_seconds":60})
            responses = [
                {"queue_running":[],"queue_pending":[]},
                {"prompt_id":"mock-run"},
                {"mock-run":{"status":{"status_str":"success","completed":True},"outputs":{"15":{"videos":[{"filename":"result.mp4"}]}}}},
            ]
            with patch("services.orchestrator.workbench.providers.http_json",side_effect=responses) as request:
                result = registry._h3_t2v({"id":"test","params":params},lambda *_:None,lambda:False)
            graph = request.call_args_list[1].args[2]["prompt"]
            self.assertEqual(graph["6"]["inputs"]["prompt"],result["effective_prompt"])
            self.assertEqual(result["profile"]["steps"],40)
            self.assertEqual(result["profile"]["width"],768)
            self.assertEqual(result["profile"]["scheduler"],"beta")
            self.assertEqual(result["profile"]["creative_presets"]["video_style"],"woodcut")
            self.assertEqual(result["profile"]["model_id"],"h3-int8-native")


if __name__ == "__main__":
    unittest.main()
