"""Durable, bounded storyboard execution on the existing single-GPU queue."""
from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path
from typing import Any

from .storyboard import validate_plan
from .store import utc_now
from .video_options import video_options


class ProductionService:
    def __init__(self, store, auth):
        self.store, self.auth = store, auth
        self.lock = threading.RLock()

    def initialize(self):
        with self.store.connect() as connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS production_runs (
                id TEXT PRIMARY KEY, plan_job_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
                created_by TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
                error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")

    def get(self, run_id):
        with self.store.connect() as connection:
            row = connection.execute("SELECT * FROM production_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        run = dict(row)
        run["payload"] = json.loads(run.pop("payload_json"))
        run["jobs"] = [self.store.get(self.job_id(run, key)) for key in self.keys(run)]
        return run

    @staticmethod
    def keys(run):
        return [shot["id"] for shot in run["payload"]["plan"]["shots"]] + (["score"] if run["payload"]["include_score"] else []) + ["assembly"]

    @staticmethod
    def job_key(run, key):
        attempt = run["payload"].get("attempts", {}).get(key, 0)
        return f"clsf:production:{run['id']}:{key}:{attempt}"

    def job_id(self, run, key):
        return str(uuid.uuid5(uuid.NAMESPACE_URL, self.job_key(run, key)))

    def save(self, run, status, error=None):
        with self.store.connect() as connection:
            connection.execute("UPDATE production_runs SET status=?,payload_json=?,error=?,updated_at=? WHERE id=?",
                               (status, json.dumps(run["payload"], ensure_ascii=False), error, utc_now(), run["id"]))

    def create(self, plan_job, principal, include_score):
        with self.lock:
            if plan_job["type"] != "agent.storyboard" or plan_job["status"] != "succeeded":
                raise ValueError("只能执行已完成且校验通过的分镜方案")
            plan = validate_plan((plan_job.get("result") or {}).get("storyboard"), plan_job["params"])
            if include_score and not plan["music_prompt"]:
                raise ValueError("方案缺少配乐描述，请关闭配乐或重新规划")
            run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "clsf:production:" + plan_job["id"]))
            existing = self.get(run_id)
            if existing:
                if existing["payload"]["include_score"] != include_score:
                    raise ValueError("该方案已按另一配乐设置提交；请使用原任务，避免重复生成")
                return existing
            self.auth.job_submission_policy(principal, plan_job["project_id"])
            payload = {"plan": plan, "include_score": include_score, "attempts": {}, "references": plan_job["params"].get("references", [])}
            now = utc_now()
            with self.store.connect() as connection:
                if connection.execute("SELECT COUNT(*) FROM production_runs WHERE status='active' AND created_by=?", (principal.user_id,)).fetchone()[0] >= 3:
                    raise ValueError("每个账号最多同时制作 3 个分镜方案，请先完成或停止现有制作")
                connection.execute("INSERT INTO production_runs VALUES(?,?,?,?,?,?,?,?,?)", (run_id, plan_job["id"], plan_job["project_id"], principal.user_id, "active", json.dumps(payload, ensure_ascii=False), None, now, now))
            return self.get(run_id)

    def list(self, project_id):
        with self.store.connect() as connection:
            ids = [row["id"] for row in connection.execute("SELECT id FROM production_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 100", (project_id,))]
        return [self.get(run_id) for run_id in ids]

    def cancel(self, run_id):
        with self.lock:
            run = self.get(run_id)
            if not run or run["status"] == "succeeded":
                return run
            # Persist stop intent first: recovery must never dispatch the next shot.
            self.save(run, "cancelled", "用户已停止后续制作；已完成素材保留")
            for job in run["jobs"]:
                if job and job["status"] in {"queued", "running"}:
                    self.store.cancel(job["id"])
            return self.get(run_id)

    def resume(self, run_id):
        with self.lock:
            run = self.get(run_id)
            if not run or run["status"] not in {"paused", "cancelled"}:
                return run
            with self.store.connect() as connection:
                if connection.execute("SELECT COUNT(*) FROM production_runs WHERE status='active' AND created_by=?", (run["created_by"],)).fetchone()[0] >= 3:
                    raise ValueError("每个账号最多同时制作 3 个分镜方案，请先完成或停止现有制作")
            for key, job in zip(self.keys(run), run["jobs"]):
                if job and job["status"] in {"failed", "cancelled"}:
                    count = run["payload"]["attempts"].get(key, 0)
                    if count >= 1:
                        raise ValueError("该步骤已重试一次；请检查原因后重新规划，不再自动重试")
                    run["payload"]["attempts"][key] = count + 1
            self.save(run, "active")
            return self.get(run_id)

    def _asset(self, run, asset_id, kind):
        asset = self.store.get_asset(asset_id)
        if not asset or asset["project_id"] != run["project_id"]:
            raise PermissionError("引用素材不属于当前项目")
        if asset["kind"] != kind or not Path(asset["source_path"]).is_file():
            raise ValueError("素材类型不匹配或文件已丢失")
        return asset

    def _output(self, run, key, kind):
        job_id = self.job_id(run, key)
        assets = self.store.list_assets(run["project_id"], limit=2000)
        asset = next((item for item in assets if item["origin_job_id"] == job_id and item["kind"] == kind), None)
        if not asset:
            raise ValueError(f"{key} 已完成但没有登记有效的 {kind} 输出")
        return self._asset(run, asset["id"], kind)["source_path"]

    def tick(self):
        with self.lock:
            with self.store.connect() as connection:
                ids = [row["id"] for row in connection.execute("SELECT id FROM production_runs WHERE status='active' ORDER BY created_at LIMIT 100")]
            for run_id in ids:
                run = self.get(run_id)
                try:
                    with self.auth.connect() as connection:
                        principal = self.auth._principal_for_user(connection, run["created_by"])
                    if not principal or not self.auth.can_project(principal, run["project_id"], "editor"):
                        raise PermissionError("账号或项目权限已变更，后续生成已暂停")
                    plan = run["payload"]["plan"]
                    keys = self.keys(run)
                    for key, job in zip(keys, run["jobs"]):
                        if job and job["status"] == "succeeded":
                            continue
                        if job and job["status"] in {"failed", "cancelled"}:
                            raise ValueError(f"{key} 未完成；保留其他镜头，请检查该任务后手动继续")
                        if job:
                            break
                        if key == "assembly":
                            params = {"clips": [{"path": self._output(run, shot["id"], "video"), "seconds": shot["duration_seconds"]} for shot in plan["shots"]],
                                      "width": plan["settings"]["width"], "height": plan["settings"]["height"], "fps": 24,
                                      "score_path": self._output(run, "score", "audio") if run["payload"]["include_score"] else None}
                            job_type = "video.assemble"
                        elif key == "score":
                            params = {"prompt": plan["music_prompt"], "lyrics": "[Instrumental]", "duration_seconds": plan["duration_seconds"]}
                            job_type = "music.generate"
                        else:
                            shot = next(item for item in plan["shots"] if item["id"] == key)
                            paths = [self._asset(run, asset_id, "image")["source_path"] for asset_id in shot["reference_asset_ids"]]
                            params = {**plan["settings"], "prompt": shot["prompt"], "duration_seconds": shot["duration_seconds"],
                                      "mode": "reference" if paths else "t2v", "reference_images": paths, "scheduler": "simple", "seed": 20260904 + keys.index(key), "h3_ir_enabled": True,
                                      "director_json": json.dumps({"version": 1, "references": [], "shots": [{"id": "shot-1", "start": 0, "action": "", "performance": "", "camera": "", "dialogue": []}], "soundscape": shot["sound"], "music": ""}, ensure_ascii=False)}
                            video_options(params["mode"], params)
                            job_type = "h3.t2v"
                        self.store.create(job_type, params, 120, project_id=run["project_id"], organization_id=principal.organization_id, created_by=principal.user_id,
                                          admission_check=lambda connection: self.auth.job_submission_policy(principal, run["project_id"], connection=connection), idempotency_key=self.job_key(run, key))
                        break
                    else:
                        self.save(run, "succeeded")
                except Exception as exc:
                    if isinstance(exc, PermissionError):
                        for queued in run["jobs"]:
                            if queued and queued["status"] == "queued": self.store.cancel(queued["id"])
                    self.save(run, "paused", str(exc))
