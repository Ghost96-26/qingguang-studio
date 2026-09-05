from __future__ import annotations

import copy
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from services.orchestrator.workbench import api
from services.orchestrator.workbench.auth import AuthStore
from services.orchestrator.workbench.production import ProductionService
from services.orchestrator.workbench.providers import ProviderRegistry
from services.orchestrator.workbench.store import JobStore
from services.orchestrator.workbench.storyboard import validate_plan, planning_instruction


def fixture_plan(ref="hero"):
    return {"version": 1, "title": "逃亡测试", "music_prompt": "低沉弦乐，无歌词",
            "shots": [{"title": str(index), "duration_seconds": 5, "prompt": "<Picture 1> 回头，随后沿走廊奔跑。", "sound": "屏息、脚步", "reference_asset_ids": [ref]} for index in range(2)]}


class PlanTests(unittest.TestCase):
    def test_strict_plan_rejects_unsupported_duration_refs_and_steps(self):
        request = {"duration_seconds": 10, "steps": 30, "references": [{"id": "hero"}]}
        plan = fixture_plan()
        normalized = validate_plan(json.dumps(plan), request)
        self.assertEqual(normalized["settings"]["steps"], 30)
        self.assertEqual(normalized["settings"]["profile"], "quality")
        self.assertIn("没有图片像素", planning_instruction(request))
        for mutation in [lambda p: p["shots"][0].update(duration_seconds=6),
                         lambda p: p["shots"][0].update(reference_asset_ids=["other-project"]),
                         lambda p: p["shots"][0].update(reference_asset_ids=[]),
                         lambda p: p["shots"][0].update(prompt="<Picture 3> 奔跑"),
                         lambda p: p["shots"][0].update(duration_seconds=float("nan")),
                         lambda p: p["shots"][0].update(duration_seconds=True)]:
            broken = copy.deepcopy(plan); mutation(broken)
            with self.assertRaises(ValueError): validate_plan(broken, request)
        for raw in ["not JSON", "{}", "[]", '{"version":2}']:
            with self.assertRaises(ValueError): validate_plan(raw, request)
        with self.assertRaises(ValueError): validate_plan(plan, {**request, "steps": 50})
        plan["arbitrary_code"] = "never executed"
        self.assertNotIn("arbitrary_code", validate_plan(plan, request))

    def test_provider_consumes_validated_llm_data_without_dispatching_media(self):
        registry = object.__new__(ProviderRegistry)
        request = {"duration_seconds": 10, "steps": 40, "references": [{"id": "hero"}], "model_id": "fixture"}
        with patch.object(registry, "_agent", return_value={"text": json.dumps(fixture_plan()), "outputs": []}) as llm:
            result = registry.execute({"id": "plan", "type": "agent.storyboard", "params": request}, lambda *args: None, lambda: False)
        self.assertEqual(result["storyboard"]["settings"]["steps"], 40)
        self.assertEqual(llm.call_count, 1)
        self.assertIn("逃亡测试", result["text"])

    def test_continuity_is_present_in_every_independent_shot_and_not_duplicated(self):
        request = {"duration_seconds": 10, "steps": 30, "references": [{"id": "hero"}], "require_continuity": True}
        raw = {**fixture_plan(), "continuity": "黑色短发、灰色外套的成年女性。保持写实夜景。"}
        plan = validate_plan(raw, request)
        self.assertTrue(all(shot["prompt"].startswith("【全片连续性】黑色短发") for shot in plan["shots"]))
        self.assertEqual(validate_plan(plan, request), plan)
        with self.assertRaises(ValueError): validate_plan(fixture_plan(), request)
        with self.assertRaises(ValueError): validate_plan({**raw, "continuity": "<Picture 9>"}, request)


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.store = JobStore(self.root / "db.sqlite", self.root / "tenants"); self.store.initialize()
        self.auth = AuthStore(self.root / "db.sqlite"); self.auth.initialize()
        self.production = ProductionService(self.store, self.auth); self.production.initialize()
        self.principal = self.auth.local_owner_principal()
        image = self.root / "fixture.png"; image.write_bytes(b"fixture only; no model input")
        self.asset = self.store.register_asset("default", "image", "人物", image, "image/png")
        self.request = {"brief": "逃亡", "model_id": "fixture", "duration_seconds": 10, "steps": 30, "references": [{"id": self.asset["id"], "name": "人物"}]}
        plan = self.store.create("agent.storyboard", self.request, 120, project_id="default", created_by=self.principal.user_id)
        self.store.finish(plan["id"], "succeeded", {"storyboard": validate_plan(fixture_plan(self.asset["id"]), self.request)})
        self.plan = self.store.get(plan["id"])

    def complete(self, job, suffix="mp4"):
        output = self.root / f"{job['id']}.{suffix}"; output.write_bytes(b"test output, no GPU")
        self.store.finish(job["id"], "succeeded", {"outputs": [str(output)]})

    def test_serial_execution_persists_outputs_and_is_idempotent_across_recovery(self):
        run = self.production.create(self.plan, self.principal, False)
        self.assertEqual(self.production.create(self.plan, self.principal, False)["id"], run["id"])
        self.assertFalse(any(run["jobs"]))
        self.production.tick(); self.production.tick()
        run = self.production.get(run["id"])
        self.assertEqual(sum(job is not None for job in run["jobs"]), 1)
        first = run["jobs"][0]
        self.assertEqual(first["params"]["steps"], 30)
        self.assertEqual(first["params"]["profile"], "quality")
        self.assertEqual(len(first["params"]["reference_images"]), 1)
        self.complete(first)
        recovered = ProductionService(self.store, self.auth); recovered.initialize(); recovered.tick()
        run = recovered.get(run["id"])
        self.complete(run["jobs"][1]); recovered.tick()
        run = recovered.get(run["id"])
        self.assertEqual(run["jobs"][2]["type"], "video.assemble")
        self.assertEqual(len(run["jobs"][2]["params"]["clips"]), 2)
        self.complete(run["jobs"][2]); recovered.tick()
        self.assertEqual(recovered.get(run["id"])["status"], "succeeded")
        self.assertEqual(len(self.store.list_assets("default")), 4)
        self.assertEqual(len(self.store.list(project_id="default")), 4)  # plan, 2 clips, review

    def test_failure_pause_manual_retry_cancel_and_permission_revocation(self):
        run = self.production.create(self.plan, self.principal, False); self.production.tick()
        first = self.production.get(run["id"])["jobs"][0]
        self.store.finish(first["id"], "failed", error="fixture failure")
        self.production.tick(); self.assertEqual(self.production.get(run["id"])["status"], "paused")
        self.production.resume(run["id"]); self.production.tick()
        retry = self.production.get(run["id"])["jobs"][0]; self.assertNotEqual(first["id"], retry["id"])
        self.production.cancel(run["id"]); self.production.tick()
        self.assertEqual(self.store.get(retry["id"])["status"], "cancelled")
        with self.assertRaisesRegex(ValueError, "重试一次"): self.production.resume(run["id"])

    def test_quota_and_revocation_do_not_dispatch_successors(self):
        run = self.production.create(self.plan, self.principal, False)
        with patch.object(self.auth, "job_submission_policy", side_effect=PermissionError("quota")):
            self.production.tick()
        self.assertEqual(self.production.get(run["id"])["status"], "paused")
        self.assertFalse(any(self.production.get(run["id"])["jobs"]))
        self.production.resume(run["id"]); self.production.tick()
        first = self.production.get(run["id"])["jobs"][0]
        with patch.object(self.auth, "can_project", return_value=False): self.production.tick()
        self.assertEqual(self.store.get(first["id"])["status"], "cancelled")
        self.assertEqual(self.production.get(run["id"])["status"], "paused")

    def test_optional_score_is_separate_step(self):
        run = self.production.create(self.plan, self.principal, True)
        for index in range(2):
            self.production.tick(); self.complete(self.production.get(run["id"])["jobs"][index])
        self.production.tick(); run = self.production.get(run["id"])
        self.assertEqual(run["jobs"][2]["type"], "music.generate")
        self.complete(run["jobs"][2], "wav"); self.production.tick()
        self.assertTrue(self.production.get(run["id"])["jobs"][3]["params"]["score_path"])

    def test_active_production_cap_also_applies_to_resume(self):
        stopped = self.production.create(self.plan, self.principal, False)
        self.production.cancel(stopped["id"])
        plans = []
        for _ in range(4):
            job = self.store.create("agent.storyboard", self.request, 120, project_id="default", created_by=self.principal.user_id)
            self.store.finish(job["id"], "succeeded", self.plan["result"])
            plans.append(self.store.get(job["id"]))
        for plan in plans[:3]: self.production.create(plan, self.principal, False)
        with self.assertRaisesRegex(ValueError, "最多同时制作 3"):
            self.production.create(plans[3], self.principal, False)
        with self.assertRaisesRegex(ValueError, "最多同时制作 3"):
            self.production.resume(stopped["id"])
        self.assertEqual(self.production.get(stopped["id"])["status"], "cancelled")

    def test_job_admission_idempotency_does_not_recharge_or_cross_scope(self):
        first = self.store.create("agent.chat", {}, 120, project_id="default", created_by="local-owner", idempotency_key="once")
        with patch.object(self.auth, "job_submission_policy", side_effect=AssertionError("duplicate must not admit")):
            again = self.store.create("agent.chat", {}, 120, project_id="default", created_by="local-owner", idempotency_key="once", admission_check=self.auth.job_submission_policy)
        self.assertEqual(again["id"], first["id"])
        with self.assertRaises(ValueError): self.store.create("h3.t2v", {}, 120, project_id="default", created_by="local-owner", idempotency_key="once")

    def test_http_auth_confirm_and_project_isolation(self):
        self.stack.enter_context(patch.object(api, "store", self.store))
        self.stack.enter_context(patch.object(api, "auth_store", self.auth))
        self.stack.enter_context(patch.object(api, "production", self.production))
        client = TestClient(api.app); self.stack.callback(client.close)  # No worker/lifespan.
        body = {"project_id": "default", "brief": "逃亡", "model_id": "fixture", "duration_seconds": 10, "steps": 30, "reference_asset_ids": [self.asset["id"]]}
        self.assertEqual(client.post("/v1/agent/storyboards", json=body).status_code, 401)
        session = self.auth.local_owner_session(); client.cookies.set(api.SESSION_COOKIE, session["session_token"])
        self.assertEqual(client.post("/v1/agent/storyboards", json=body).status_code, 403)
        client.headers["X-CSRF-Token"] = session["csrf_token"]
        self.assertEqual(client.post("/v1/agent/storyboards", json={**body, "brief": " "}).status_code, 422)
        self.assertEqual(client.post("/v1/agent/storyboards", json=body).status_code, 202)
        url = f"/v1/agent/storyboards/{self.plan['id']}/execute"
        self.assertEqual(client.post(url, json={}).status_code, 422)
        executed = client.post(url, json={"confirmed": True}); self.assertEqual(executed.status_code, 202, executed.text)
        self.assertEqual(client.post("/v1/jobs", json={"project_id":"default", "type":"video.assemble", "params":{}}).status_code, 422)
        with patch.object(self.auth, "can_project", return_value=False):
            self.assertEqual(client.post(url, json={"confirmed": True}).status_code, 403)
            self.assertEqual(client.get("/v1/projects/default/productions").status_code, 403)
            self.assertEqual(client.post(f"/v1/productions/{executed.json()['id']}/cancel").status_code, 403)


if __name__ == "__main__": unittest.main()
