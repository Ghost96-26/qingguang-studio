from __future__ import annotations

import base64
import tempfile
import unittest
from contextlib import ExitStack
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from services.orchestrator.workbench import api
from services.orchestrator.workbench.auth import AuthStore
from services.orchestrator.workbench.avatars import normalize_avatar
from services.orchestrator.workbench.store import JobStore


class AccountHttpTests(unittest.TestCase):
    """Exercise real HTTP guards with isolated DB/files and no worker or GPU."""

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.jobs = JobStore(root / "test.sqlite3", root / "tenants")
        self.jobs.initialize()
        self.auth = AuthStore(root / "test.sqlite3")
        self.auth.initialize()
        self.stack.enter_context(patch.object(api, "store", self.jobs))
        self.stack.enter_context(patch.object(api, "auth_store", self.auth))
        self.owner = self.session_client(self.auth.local_owner_session())

    def session_client(self, session=None):
        # Deliberately don't enter TestClient's lifespan: never start JobWorker.
        client = TestClient(api.app)
        self.stack.callback(client.close)
        if session:
            client.cookies.set(api.SESSION_COOKIE, session["session_token"])
            client.headers["X-CSRF-Token"] = session["csrf_token"]
        return client

    def register(self, email="artist@example.com", role="viewer"):
        invite = self.owner.post("/v1/admin/invitations", json={"email": email, "project_id": "default", "project_role": role})
        self.assertEqual(invite.status_code, 201, invite.text)
        client = self.session_client()
        response = client.post("/v1/auth/register", json={"invitation_code": invite.json()["code"], "email": email, "name": "创作者", "password": "test-only-long-password"})
        self.assertEqual(response.status_code, 200, response.text)
        client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
        return client, response.json()["user"]

    def upload(self, client, project):
        with patch.object(api, "inspect_media", return_value={"kind": "text"}):
            response = client.post("/v1/assets/upload", data={"project_id": project, "kind": "text"}, files={"file": ("reference.txt", b"private reference", "text/plain")})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_registration_private_projects_storage_and_download_guards(self):
        artist, user = self.register()
        projects = artist.get("/v1/projects").json()
        personal = next(p for p in projects if p["project_kind"] == "personal")
        self.assertEqual(personal["current_user_role"], "owner")
        self.assertIn(user["id"], personal["storage_root"])
        self.assertTrue(Path(personal["storage_root"], "inputs").is_dir())
        created = artist.post("/v1/projects", json={"name": "我的独立项目"})
        self.assertEqual(created.status_code, 201, created.text)
        project = created.json()["id"]
        asset = self.upload(artist, project)
        self.assertTrue(Path(asset["source_path"]).is_relative_to(self.jobs.project_storage_root(project) / "inputs"))
        visible = {p["id"] for p in self.owner.get("/v1/projects").json()}
        self.assertNotIn(project, visible)  # Platform owner is not a project member.
        for url in [f"/v1/projects/{project}/canvas", f"/v1/projects/{project}/usage", f"/v1/assets?project_id={project}", f"/v1/assets/{asset['id']}/content"]:
            self.assertEqual(self.owner.get(url).status_code, 403, url)
        self.assertEqual(self.owner.post(f"/v1/assets/{asset['id']}/download-tickets", json={}).status_code, 403)
        grant = artist.post(f"/v1/assets/{asset['id']}/download-tickets", json={"minutes": 1})
        self.assertEqual(grant.status_code, 201)
        anonymous = self.session_client()
        download = anonymous.get(grant.json()["url"])
        self.assertEqual(download.content, b"private reference")
        self.assertIn("attachment", download.headers["content-disposition"])
        self.assertEqual(anonymous.get(f"/v1/assets/{asset['id']}/content").status_code, 401)

    def test_viewer_reviewer_and_existing_user_team_invitation(self):
        viewer, user = self.register()
        job = self.jobs.create("h3.t2v", {"profile": "native"}, priority=100, project_id="default")
        self.jobs.finish(job["id"], "succeeded", {})
        approval = f"/v1/jobs/{job['id']}/approval"
        self.assertEqual(viewer.post(approval, json={"status": "approved"}).status_code, 403)
        self.assertEqual(viewer.put("/v1/projects/default/canvas", json={"state": {}}).status_code, 403)
        self.assertEqual(viewer.post("/v1/jobs", json={"type": "h3.t2v", "project_id": "default"}).status_code, 403)
        change = self.owner.patch(f"/v1/projects/default/members/{user['id']}", json={"role": "reviewer", "monthly_compute_minutes_limit": 60, "max_active_jobs": 2, "queue_priority": 4})
        self.assertEqual(change.status_code, 200, change.text)
        self.assertEqual(change.json()["monthly_compute_seconds_limit"], 3600)
        self.assertEqual(viewer.post(approval, json={"status": "approved"}).status_code, 200)
        self.assertEqual(viewer.put("/v1/projects/default/canvas", json={"state": {}}).status_code, 403)
        team = self.owner.post("/v1/projects", json={"name": "第二个团队项目"}).json()
        invite = self.owner.post("/v1/admin/invitations", json={"email": user["email"], "project_id": team["id"], "project_role": "editor"}).json()
        accepted = viewer.post("/v1/auth/invitations/accept", json={"code": invite["code"]})
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(viewer.put(f"/v1/projects/{team['id']}/canvas", json={"state": {"nodes": [], "edges": []}}).status_code, 200)
        self.assertEqual(viewer.patch(f"/v1/projects/{team['id']}", json={"max_active_jobs": 99}).status_code, 403)

    def test_cookie_mutations_require_csrf_and_last_owner_is_protected(self):
        client = self.session_client()
        client.cookies.update(self.owner.cookies)
        self.assertEqual(client.post("/v1/projects", json={"name": "CSRF blocked"}).status_code, 403)
        self.assertEqual(self.owner.patch("/v1/projects/default/members/local-owner", json={"role": "viewer"}).status_code, 422)

    def test_avatar_upload_is_sanitized_persisted_and_role_protected(self):
        source = BytesIO()
        Image.new("RGB", (240, 180), "#654321").save(source, format="PNG")
        value = "data:image/png;base64," + base64.b64encode(source.getvalue()).decode()
        response = self.owner.patch("/v1/auth/profile", json={"avatar_image": value})
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()["user"]["avatar_image"]
        with Image.open(BytesIO(base64.b64decode(saved.split(",", 1)[1]))) as image:
            self.assertEqual(image.size, (128, 128))
            self.assertFalse(image.getexif())
        self.assertEqual(self.owner.get("/v1/auth/me").json()["user"]["avatar_image"], saved)
        response = self.owner.patch("/v1/projects/default", json={"avatar_image": value})
        self.assertEqual(response.status_code, 200, response.text)
        viewer, _ = self.register()
        self.assertEqual(viewer.patch("/v1/projects/default", json={"avatar_image": value}).status_code, 403)
        for invalid in ["https://example.com/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,not base64"]:
            self.assertEqual(self.owner.patch("/v1/auth/profile", json={"avatar_image": invalid}).status_code, 422)
        self.assertEqual(normalize_avatar(""), "")
        cleared = self.owner.patch("/v1/auth/profile", json={"avatar_image": ""}).json()
        self.assertEqual(cleared["user"]["avatar_image"], "")
