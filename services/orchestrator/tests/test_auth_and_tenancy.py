from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from services.orchestrator.workbench.auth import AuthStore
from services.orchestrator.workbench.store import JobStore


class AuthAndTenancyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "workbench.db"
        self.jobs = JobStore(self.database)
        self.jobs.initialize()
        self.auth = AuthStore(self.database)
        self.auth.initialize()
        owner_session = self.auth.local_owner_session(ip_address="127.0.0.1")
        self.owner = self.auth.principal_from_token(owner_session["session_token"])
        assert self.owner

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_invitation_registration_grants_only_selected_project(self) -> None:
        private_project = self.jobs.create_project("仅管理员", organization_id=self.owner.organization_id, owner_user_id=self.owner.user_id)
        self.auth.add_project_owner(private_project["id"], self.owner)
        invitation = self.auth.create_invitation(
            self.owner,
            email="producer@example.com",
            project_id="default",
            project_role="editor",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        session = self.auth.register_with_invitation(
            code=invitation["code"],
            email="producer@example.com",
            name="制作人员",
            password="correct-horse-battery-staple",
        )
        producer = self.auth.principal_from_token(session["session_token"])
        assert producer
        self.assertTrue(self.auth.can_project(producer, "default", "editor"))
        self.assertFalse(self.auth.can_project(producer, private_project["id"], "viewer"))
        self.assertTrue(producer.can_create_projects)

    def test_platform_admin_does_not_implicitly_own_user_projects_after_restart(self) -> None:
        invitation = self.auth.create_invitation(
            self.owner,
            email="owner2@example.com",
            project_id="default",
            project_role="viewer",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        session = self.auth.register_with_invitation(
            code=invitation["code"],
            email="owner2@example.com",
            name="第二位创作者",
            password="correct-horse-battery-staple",
        )
        creator = self.auth.principal_from_token(session["session_token"])
        assert creator
        private_project = self.jobs.create_project(
            "第二位创作者的私人项目",
            organization_id=creator.organization_id,
            owner_user_id=creator.user_id,
            project_kind="personal",
        )
        self.auth.add_project_owner(private_project["id"], creator)
        self.assertFalse(self.auth.can_project(self.owner, private_project["id"], "viewer"))
        self.auth.initialize()
        self.assertFalse(self.auth.can_project(self.owner, private_project["id"], "viewer"))
        self.assertTrue(self.auth.can_project(creator, private_project["id"], "owner"))

    def test_existing_user_can_accept_another_project_invitation(self) -> None:
        first = self.auth.create_invitation(
            self.owner,
            email="editor@example.com",
            project_id="default",
            project_role="viewer",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        session = self.auth.register_with_invitation(
            code=first["code"], email="editor@example.com", name="协作用户", password="correct-horse-battery-staple"
        )
        collaborator = self.auth.principal_from_token(session["session_token"])
        assert collaborator
        shared = self.jobs.create_project("另一个团队项目", organization_id=self.owner.organization_id, owner_user_id=self.owner.user_id)
        self.auth.add_project_owner(shared["id"], self.owner)
        second = self.auth.create_invitation(
            self.owner,
            email="editor@example.com",
            project_id=shared["id"],
            project_role="editor",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        result = self.auth.redeem_invitation(collaborator, second["code"])
        self.assertEqual(result["project_id"], shared["id"])
        self.assertTrue(self.auth.can_project(collaborator, shared["id"], "editor"))
        again = self.auth.redeem_invitation(collaborator, second["code"])
        self.assertTrue(again["already_member"])

    def test_invitation_is_single_use_and_email_bound(self) -> None:
        invitation = self.auth.create_invitation(
            self.owner,
            email="reviewer@example.com",
            project_id="default",
            project_role="reviewer",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        with self.assertRaisesRegex(ValueError, "邮箱"):
            self.auth.register_with_invitation(
                code=invitation["code"], email="wrong@example.com", name="错误账户", password="correct-horse-battery-staple"
            )
        self.auth.register_with_invitation(
            code=invitation["code"], email="reviewer@example.com", name="审核人员", password="correct-horse-battery-staple"
        )
        with self.assertRaisesRegex(ValueError, "使用上限"):
            self.auth.register_with_invitation(
                code=invitation["code"], email="reviewer@example.com", name="再次注册", password="another-correct-long-password"
            )

    def test_login_and_download_grant_are_expiring_bearer_capabilities(self) -> None:
        invitation = self.auth.create_invitation(
            self.owner,
            email="viewer@example.com",
            project_id="default",
            project_role="viewer",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        self.auth.register_with_invitation(
            code=invitation["code"], email="viewer@example.com", name="查看人员", password="correct-horse-battery-staple"
        )
        login = self.auth.authenticate("viewer@example.com", "correct-horse-battery-staple")
        viewer = self.auth.principal_from_token(login["session_token"])
        assert viewer
        source = Path(self.temp.name) / "delivery.txt"
        source.write_text("delivery", encoding="utf-8")
        asset = self.jobs.register_asset("default", "text", "交付.txt", source, "text/plain", organization_id=viewer.organization_id, created_by=self.owner.user_id)
        grant = self.auth.create_download_grant(viewer, asset["id"], minutes=15)
        resolved = self.auth.resolve_download_grant(grant["token"])
        self.assertEqual(resolved["asset_id"], asset["id"])
        self.assertIsNone(self.auth.resolve_download_grant("not-a-real-token"))

    def test_generated_result_is_physically_partitioned_by_organization_and_project(self) -> None:
        tenant_root = Path(self.temp.name) / "tenants"
        partitioned_store = JobStore(self.database, tenant_root=tenant_root)
        source = Path(self.temp.name) / "provider-output.mp4"
        source.write_bytes(b"local-video-result")
        job = partitioned_store.create(
            "h3.text_to_video",
            {"prompt": "test"},
            100,
            project_id="default",
            organization_id=self.owner.organization_id,
            created_by=self.owner.user_id,
        )
        partitioned_store.finish(job["id"], "succeeded", {"outputs": [str(source)], "provider": "h3"})
        generated = next(
            asset for asset in partitioned_store.list_assets("default", 20) if asset.get("origin_job_id") == job["id"]
        )
        generated_path = Path(generated["source_path"])
        self.assertTrue(generated_path.is_relative_to(tenant_root))
        self.assertIn(self.owner.user_id, generated_path.parts)
        self.assertIn("outputs", generated_path.parts)
        self.assertEqual(generated_path.read_bytes(), b"local-video-result")
        self.assertEqual(generated["name"], "provider-output.mp4")
        self.assertTrue(generated["metadata"]["physical_partitioned"])

    def test_project_owner_controls_member_queue_and_compute_limits(self) -> None:
        invitation = self.auth.create_invitation(
            self.owner,
            email="limited-editor@example.com",
            project_id="default",
            project_role="editor",
            can_create_projects=False,
            expires_hours=24,
            max_uses=1,
        )
        session = self.auth.register_with_invitation(
            code=invitation["code"],
            email="limited-editor@example.com",
            name="受限制作人员",
            password="correct-horse-battery-staple",
        )
        editor = self.auth.principal_from_token(session["session_token"])
        assert editor
        member = self.auth.update_project_member(
            self.owner,
            "default",
            editor.user_id,
            max_active_jobs=1,
            queue_priority=5,
            monthly_compute_seconds_limit=60,
        )
        self.assertEqual(member["max_active_jobs"], 1)
        self.assertEqual(self.auth.job_submission_policy(editor, "default")["priority"], 40)
        self.jobs.create(
            "h3.text_to_video",
            {"prompt": "queued"},
            40,
            project_id="default",
            organization_id=editor.organization_id,
            created_by=editor.user_id,
        )
        with self.assertRaisesRegex(ValueError, "排队任务"):
            self.auth.job_submission_policy(editor, "default")
        self.auth.update_project_member(
            self.owner,
            "default",
            editor.user_id,
            max_active_jobs=2,
            monthly_compute_seconds_limit=0,
        )
        with self.assertRaisesRegex(ValueError, "计算额度"):
            self.auth.job_submission_policy(editor, "default")
        with self.assertRaises(PermissionError):
            self.auth.update_project_member(editor, "default", self.owner.user_id, role="viewer")

    def test_usage_summary_honors_period_and_user_scope(self) -> None:
        recent = self.jobs.create(
            "agent.prompt",
            {"prompt": "recent"},
            100,
            project_id="default",
            organization_id=self.owner.organization_id,
            created_by=self.owner.user_id,
        )
        old = self.jobs.create(
            "agent.prompt",
            {"prompt": "old"},
            100,
            project_id="default",
            organization_id=self.owner.organization_id,
            created_by=self.owner.user_id,
        )
        self.jobs.create(
            "agent.prompt",
            {"prompt": "another member"},
            100,
            project_id="default",
            organization_id=self.owner.organization_id,
            created_by="another-user",
        )
        with self.jobs.connect() as connection:
            connection.execute("UPDATE jobs SET created_at='2025-01-01T00:00:00Z' WHERE id=?", (old["id"],))
        scoped = self.jobs.usage_summary(["default"], user_id=self.owner.user_id, days=30)
        team = self.jobs.usage_summary(["default"], days=30)
        self.assertEqual(scoped["job_count"], 1)
        self.assertEqual(team["job_count"], 2)
        self.assertEqual(scoped["daily"][0]["jobs"], 1)
        self.assertEqual(recent["created_by"], self.owner.user_id)

    def test_admission_is_atomic_across_separate_store_instances(self) -> None:
        self.auth.update_project_member(self.owner, "default", self.owner.user_id, max_active_jobs=1)
        def submit(_: int) -> bool:
            try:
                JobStore(self.database).create(
                    "h3.t2v", {}, 999, created_by=self.owner.user_id,
                    admission_check=lambda connection: self.auth.job_submission_policy(self.owner, "default", connection=connection),
                )
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(submit, range(4)))
        self.assertEqual(sum(results), 1)
        jobs = self.jobs.list(project_id="default")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["priority"], 120)

    def test_invitation_and_submission_reject_foreign_organization(self) -> None:
        invite = self.auth.create_invitation(self.owner, email=None, project_id="default", project_role="editor", can_create_projects=True, expires_hours=24, max_uses=1)
        foreign = replace(self.owner, organization_id="another-organization")
        with self.assertRaises(PermissionError):
            self.auth.redeem_invitation(foreign, invite["code"])
        with self.assertRaises(PermissionError):
            self.auth.job_submission_policy(foreign, "default")

    def test_monthly_quota_uses_beijing_month_boundary(self) -> None:
        local_start = datetime.now(timezone(timedelta(hours=8))).replace(day=1, hour=0, minute=1, second=0, microsecond=0)
        job = self.jobs.create("h3.t2v", {}, 100, created_by=self.owner.user_id)
        with self.jobs.connect() as connection:
            connection.execute("UPDATE jobs SET status='succeeded',started_at=?,finished_at=? WHERE id=?", (
                local_start.astimezone(timezone.utc).isoformat(),
                (local_start + timedelta(minutes=2)).astimezone(timezone.utc).isoformat(), job["id"],
            ))
        self.auth.update_project_member(self.owner, "default", self.owner.user_id, monthly_compute_seconds_limit=60)
        with self.assertRaisesRegex(ValueError, "计算额度"):
            self.auth.job_submission_policy(self.owner, "default")


if __name__ == "__main__":
    unittest.main()
