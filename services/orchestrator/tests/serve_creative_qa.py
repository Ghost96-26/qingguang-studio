"""Isolated visual fixture on localhost:8092. No worker, no model invocation.

Run as a module from the project root. Never points at the user's database.
"""
import json
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from PIL import Image, ImageDraw
from services.orchestrator.workbench import api
from services.orchestrator.workbench.auth import AuthStore
from services.orchestrator.workbench.production import ProductionService
from services.orchestrator.workbench.store import JobStore
from services.orchestrator.workbench.storyboard import validate_plan, plan_text


def main():
    with tempfile.TemporaryDirectory(prefix="clsf-creative-qa-") as temporary:
        root = Path(temporary)
        api.store = JobStore(root / "qa.db", root / "tenants"); api.store.initialize()
        api.auth_store = AuthStore(root / "qa.db"); api.auth_store.initialize()
        api.production = ProductionService(api.store, api.auth_store); api.production.initialize()
        api.store.update_project("default", name="交互验收 · 隔离数据 / 无 GPU")
        image = Image.new("RGB", (640, 360), "#284653")
        draw = ImageDraw.Draw(image); draw.ellipse((200, 40, 440, 320), fill="#d8b585")
        image_path = root / "reference.png"; image.save(image_path)
        reference = api.store.register_asset("default", "image", "角色参考 QA.png", image_path, "image/png")
        video = root / "preview.mp4"
        subprocess.run([api.settings.raw["ffmpeg_executable"], "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=5", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", str(video)], check=True, timeout=30, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        params = {"mode":"reference", "prompt":"保留参考主体，缓慢回头。", "steps":30,"profile":"quality","width":1344,"height":768,"duration_seconds":5,"h3_ir_enabled":True,
                  "director_json":json.dumps({"version":1,"references":[],"shots":[{"id":"shot-1","start":0,"action":"","performance":"","camera":"","dialogue":[]}],"soundscape":"","music":""})}
        job = api.store.create("h3.t2v", params, 120, project_id="default", created_by="local-owner")
        api.store.finish(job["id"], "succeeded", {"outputs":[str(video)]})
        preview = next(asset for asset in api.store.list_assets("default") if asset["kind"] == "video")
        api.store.save_canvas("default", {"version":4,"nodes":[
            {"id":"qa-source","kind":"asset","title":reference["name"],"assetId":reference["id"],"x":20,"y":40},
            {"id":"qa-video","kind":"video","title":"已完成视频 · QA","assetId":preview["id"],"jobId":job["id"],"params":params,"x":400,"y":50},
        ],"edges":[{"id":"qa-edge","from":"qa-source","to":"qa-video","port":"reference_image_1","output":"image"}],"viewport":{"x":20,"y":30,"zoom":0.85}})
        request = {"brief":"隔离分镜示例，不会调用模型","model_id":"fixture","duration_seconds":10,"steps":30,"references":[{"id":reference["id"],"name":reference["name"]}]}
        plan = validate_plan({"version":1,"title":"逃亡分镜（测试方案）","music_prompt":"低沉弦乐", "shots":[{"title":"发现危险","duration_seconds":5,"prompt":"<Picture 1> 察觉危险，缓慢转身。","sound":"屏息","reference_asset_ids":[reference["id"]]},{"title":"离开现场","duration_seconds":5,"prompt":"<Picture 1> 迅速离开房间。","sound":"脚步声","reference_asset_ids":[reference["id"]]}]}, request)
        planning = api.store.create("agent.storyboard",request,120,project_id="default",created_by="local-owner")
        api.store.finish(planning["id"],"succeeded",{"text":plan_text(plan),"storyboard":plan})
        api.providers.capabilities = lambda: {"providers":{"h3":{"ready":False},"image":{"ready":False,"models":[]},"agent":{"ready":False,"default_model":"fixture","models":[{"id":"fixture","label":"QA 固定数据（不运行模型）"}]}}}
        @asynccontextmanager
        async def no_worker(_): yield
        api.app.router.lifespan_context = no_worker
        print("QA fixture ready: http://localhost:8092/v3 (no worker)", flush=True)
        uvicorn.run(api.app, host="127.0.0.1", port=8092, access_log=False)


if __name__ == "__main__": main()
