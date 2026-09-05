from __future__ import annotations

import json
import mimetypes
import os
import shutil
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator


DEFAULT_ASSET_FOLDERS: tuple[tuple[str, str], ...] = (
    ("scene", "场景设定"),
    ("character", "人物设定"),
    ("prop", "道具设定"),
    ("unfiled", "未归档"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, database: Path, tenant_root: Path | None = None):
        self.database = database
        self.tenant_root = tenant_root
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL DEFAULT 'default',
                    type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 100,
                    params_json TEXT NOT NULL,
                    result_json TEXT,
                    error TEXT,
                    progress REAL NOT NULL DEFAULT 0,
                    stage TEXT,
                    provider_run_id TEXT,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    preview_job_id TEXT,
                    approval_status TEXT NOT NULL DEFAULT 'not_required',
                    approval_note TEXT,
                    approved_at TEXT,
                    final_job_id TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_queue
                    ON jobs(status, priority, created_at);
                CREATE TABLE IF NOT EXISTS resource_leases (
                    resource TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    leased_at TEXT NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES jobs(id)
                );
                CREATE TABLE IF NOT EXISTS job_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    detail_json TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES jobs(id)
                );
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    group_id TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    deleted_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(group_id) REFERENCES project_groups(id) ON DELETE SET NULL
                );
                CREATE TABLE IF NOT EXISTS project_groups (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS canvas_states (
                    project_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id)
                );
                CREATE TABLE IF NOT EXISTS asset_folders (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    parent_id TEXT,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'custom',
                    system_key TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(project_id, system_key),
                    FOREIGN KEY(project_id) REFERENCES projects(id),
                    FOREIGN KEY(parent_id) REFERENCES asset_folders(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_asset_folders_project
                    ON asset_folders(project_id, sort_order, name);
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    media_type TEXT,
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    metadata_json TEXT,
                    folder_id TEXT,
                    origin_job_id TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(source_path, origin_job_id),
                    FOREIGN KEY(project_id) REFERENCES projects(id),
                    FOREIGN KEY(folder_id) REFERENCES asset_folders(id) ON DELETE SET NULL,
                    FOREIGN KEY(origin_job_id) REFERENCES jobs(id)
                );
                CREATE INDEX IF NOT EXISTS idx_assets_project_created
                    ON assets(project_id, created_at DESC);
                """
            )
            self._ensure_column(connection, "jobs", "project_id", "TEXT NOT NULL DEFAULT 'default'")
            self._ensure_column(connection, "jobs", "preview_job_id", "TEXT")
            self._ensure_column(connection, "jobs", "approval_status", "TEXT NOT NULL DEFAULT 'not_required'")
            self._ensure_column(connection, "jobs", "approval_note", "TEXT")
            self._ensure_column(connection, "jobs", "approved_at", "TEXT")
            self._ensure_column(connection, "jobs", "final_job_id", "TEXT")
            self._ensure_column(connection, "jobs", "organization_id", "TEXT NOT NULL DEFAULT 'clsf-ai-lab'")
            self._ensure_column(connection, "jobs", "created_by", "TEXT")
            self._ensure_column(connection, "projects", "group_id", "TEXT")
            self._ensure_column(connection, "projects", "sort_order", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(connection, "projects", "deleted_at", "TEXT")
            self._ensure_column(connection, "projects", "organization_id", "TEXT NOT NULL DEFAULT 'clsf-ai-lab'")
            self._ensure_column(connection, "projects", "owner_user_id", "TEXT")
            self._ensure_column(connection, "projects", "project_kind", "TEXT NOT NULL DEFAULT 'standard'")
            self._ensure_column(connection, "projects", "avatar_color", "TEXT NOT NULL DEFAULT '#7C8CFF'")
            self._ensure_column(connection, "projects", "avatar_image", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(connection, "projects", "monthly_compute_seconds_limit", "INTEGER")
            self._ensure_column(connection, "projects", "max_active_jobs", "INTEGER NOT NULL DEFAULT 50")
            self._ensure_column(connection, "project_groups", "owner_user_id", "TEXT")
            self._ensure_column(connection, "assets", "folder_id", "TEXT")
            self._ensure_column(connection, "assets", "organization_id", "TEXT NOT NULL DEFAULT 'clsf-ai-lab'")
            self._ensure_column(connection, "assets", "created_by", "TEXT")
            now = utc_now()
            connection.execute(
                "INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES('default','擎光绘影·示范项目',?,?)",
                (now, now),
            )
            connection.execute(
                "UPDATE projects SET name='擎光绘影·示范项目',updated_at=? WHERE id='default' AND name='首个制作项目'",
                (now,),
            )
            self._ensure_asset_folders(connection)
            stale = connection.execute("SELECT id FROM jobs WHERE status = 'running'").fetchall()
            for row in stale:
                connection.execute(
                    "UPDATE jobs SET status='failed', error=?, stage='interrupted', updated_at=?, finished_at=? WHERE id=?",
                    ("Gateway restarted while this job was running; it was not resubmitted automatically.", now, now, row["id"]),
                )
                self._event(connection, row["id"], "recovered_as_failed", {})
            connection.execute("DELETE FROM resource_leases")
            self._backfill_assets(connection)

    def _ensure_asset_folders(self, connection: sqlite3.Connection, project_id: str | None = None) -> None:
        projects = connection.execute(
            "SELECT id FROM projects WHERE id=?" if project_id else "SELECT id FROM projects",
            (project_id,) if project_id else (),
        ).fetchall()
        now = utc_now()
        for project in projects:
            for sort_order, (system_key, name) in enumerate(DEFAULT_ASSET_FOLDERS):
                folder_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"clsf-asset-folder:{project['id']}:{system_key}"))
                connection.execute(
                    "INSERT OR IGNORE INTO asset_folders(id,project_id,parent_id,name,category,system_key,sort_order,created_at,updated_at) "
                    "VALUES(?,?,NULL,?,?,?,?,?,?)",
                    (folder_id, project["id"], name, system_key, system_key, sort_order, now, now),
                )
            unfiled = connection.execute(
                "SELECT id FROM asset_folders WHERE project_id=? AND system_key='unfiled'",
                (project["id"],),
            ).fetchone()
            if unfiled:
                connection.execute(
                    "UPDATE assets SET folder_id=? WHERE project_id=? AND folder_id IS NULL",
                    (unfiled["id"], project["id"]),
                )

    def _system_folder_id(self, connection: sqlite3.Connection, project_id: str, system_key: str = "unfiled") -> str:
        self._ensure_asset_folders(connection, project_id)
        row = connection.execute(
            "SELECT id FROM asset_folders WHERE project_id=? AND system_key=?",
            (project_id, system_key),
        ).fetchone()
        if not row:
            raise ValueError("Asset folder initialization failed")
        return str(row["id"])

    @staticmethod
    def _ensure_column(connection: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def _backfill_assets(self, connection: sqlite3.Connection) -> None:
        rows = connection.execute(
            "SELECT id,project_id,type,result_json,finished_at FROM jobs WHERE status='succeeded' AND result_json IS NOT NULL"
        ).fetchall()
        for row in rows:
            result = json.loads(row["result_json"])
            self._register_result_assets(connection, dict(row), result)

    @staticmethod
    def _event(connection: sqlite3.Connection, job_id: str, event: str, detail: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO job_events(job_id,event,detail_json,created_at) VALUES(?,?,?,?)",
            (job_id, event, json.dumps(detail, ensure_ascii=False), utc_now()),
        )

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        item = dict(row)
        item["params"] = json.loads(item.pop("params_json"))
        result_json = item.pop("result_json")
        item["result"] = json.loads(result_json) if result_json else None
        item["cancel_requested"] = bool(item["cancel_requested"])
        return item

    def create(
        self,
        job_type: str,
        params: dict[str, Any],
        priority: int,
        project_id: str = "default",
        preview_job_id: str | None = None,
        organization_id: str = "clsf-ai-lab",
        created_by: str | None = None,
        admission_check: Callable[[sqlite3.Connection], dict[str, Any]] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key)) if idempotency_key else str(uuid.uuid4())
        now = utc_now()
        profile = str(params.get("profile", ""))
        approval_status = "pending" if job_type == "h3.t2v" and profile != "quality" and preview_job_id is None else "not_required"
        with self._write_lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            previous = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if previous is not None:
                if previous["project_id"] != project_id or previous["created_by"] != created_by or previous["type"] != job_type:
                    raise ValueError("Idempotency identity mismatch")
                connection.execute("ROLLBACK")
                return self._row(previous)  # type: ignore[return-value]
            # Admission and insertion share the SQLite write transaction so
            # concurrent requests cannot both consume the last queue slot.
            if admission_check is not None:
                priority = int(admission_check(connection)["priority"])
            if not connection.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                connection.execute("ROLLBACK")
                raise ValueError(f"Unknown project: {project_id}")
            connection.execute(
                "INSERT INTO jobs(id,project_id,type,status,priority,params_json,created_at,updated_at,stage,preview_job_id,approval_status,organization_id,created_by) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    project_id,
                    job_type,
                    "queued",
                    priority,
                    json.dumps(params, ensure_ascii=False),
                    now,
                    now,
                    "queued",
                    preview_job_id,
                    approval_status,
                    organization_id,
                    created_by,
                ),
            )
            self._event(connection, job_id, "queued", {"priority": priority})
            connection.execute("COMMIT")
        return self.get(job_id)  # type: ignore[return-value]

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            return self._row(connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    def list(self, limit: int = 100, status: str | None = None, project_id: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM jobs"
        values: list[Any] = []
        clauses: list[str] = []
        if status:
            clauses.append("status=?")
            values.append(status)
        if project_id:
            clauses.append("project_id=?")
            values.append(project_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC LIMIT ?"
        values.append(limit)
        with self.connect() as connection:
            return [self._row(row) for row in connection.execute(query, values).fetchall()]  # type: ignore[misc]

    def events(self, job_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM job_events WHERE job_id=? ORDER BY id", (job_id,)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["detail"] = json.loads(item.pop("detail_json")) if item.get("detail_json") else {}
            result.append(item)
        return result

    def claim(self) -> dict[str, Any] | None:
        with self._write_lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM resource_leases WHERE resource='gpu0'").fetchone():
                connection.execute("ROLLBACK")
                return None
            row = connection.execute(
                "SELECT * FROM jobs WHERE status='queued' AND cancel_requested=0 ORDER BY priority ASC, created_at ASC LIMIT 1"
            ).fetchone()
            if row is None:
                connection.execute("ROLLBACK")
                return None
            now = utc_now()
            connection.execute(
                "UPDATE jobs SET status='running', stage='starting', progress=0.01, started_at=?, updated_at=? WHERE id=?",
                (now, now, row["id"]),
            )
            connection.execute(
                "INSERT INTO resource_leases(resource,job_id,leased_at) VALUES('gpu0',?,?)",
                (row["id"], now),
            )
            self._event(connection, row["id"], "started", {"resource": "gpu0"})
            connection.execute("COMMIT")
        return self.get(row["id"])

    def progress(self, job_id: str, value: float, stage: str, provider_run_id: str | None = None) -> None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "UPDATE jobs SET progress=?, stage=?, provider_run_id=COALESCE(?,provider_run_id), updated_at=? WHERE id=?",
                (max(0.0, min(1.0, value)), stage, provider_run_id, now, job_id),
            )

    def finish(self, job_id: str, status: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
        now = utc_now()
        progress = 1.0 if status == "succeeded" else 0.0
        with self._write_lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE jobs SET status=?, result_json=?, error=?, progress=?, stage=?, updated_at=?, finished_at=? WHERE id=?",
                (status, json.dumps(result, ensure_ascii=False) if result is not None else None, error, progress, status, now, now, job_id),
            )
            connection.execute("DELETE FROM resource_leases WHERE job_id=?", (job_id,))
            self._event(connection, job_id, status, {"error": error} if error else {})
            if status == "succeeded" and result is not None:
                row = connection.execute("SELECT id,project_id,type,finished_at,organization_id,created_by FROM jobs WHERE id=?", (job_id,)).fetchone()
                if row:
                    self._register_result_assets(connection, dict(row), result)
            connection.execute("COMMIT")

    @staticmethod
    def _media_kind(job_type: str, path: Path, media_type: str | None) -> str:
        if job_type.startswith("h3.") or (media_type or "").startswith("video/"):
            return "video"
        if job_type in {"tts.clone", "music.generate"} or (media_type or "").startswith("audio/"):
            return "audio"
        if (media_type or "").startswith("image/"):
            return "image"
        if path.suffix.lower() in {".txt", ".md", ".json"}:
            return "text"
        return "file"

    def _register_result_assets(self, connection: sqlite3.Connection, job: dict[str, Any], result: dict[str, Any]) -> None:
        outputs = result.get("outputs")
        if not isinstance(outputs, list):
            return
        for output in outputs:
            path = Path(str(output))
            if not path.is_file():
                continue
            display_name = path.name
            if connection.execute(
                "SELECT 1 FROM assets WHERE origin_job_id=? AND name=?",
                (job["id"], display_name),
            ).fetchone():
                continue
            original_path = path.resolve()
            physical_partitioned = False
            partition_error: str | None = None
            if self.tenant_root is not None:
                try:
                    organization_id = str(job.get("organization_id") or "clsf-ai-lab")
                    project_id = str(job.get("project_id") or "default")
                    project = connection.execute(
                        "SELECT organization_id,owner_user_id FROM projects WHERE id=?",
                        (project_id,),
                    ).fetchone()
                    organization_id = str(project["organization_id"] if project else organization_id)
                    owner_user_id = str((project["owner_user_id"] if project else None) or "unassigned")
                    generated_root = self.tenant_root / organization_id / "users" / owner_user_id / "projects" / project_id / "outputs" / str(job["id"])
                    generated_root.mkdir(parents=True, exist_ok=True)
                    destination = generated_root / f"{uuid.uuid4()}{path.suffix[:16]}"
                    try:
                        os.link(original_path, destination)
                    except OSError:
                        shutil.copy2(original_path, destination)
                    path = destination
                    physical_partitioned = True
                except OSError as exc:
                    path = original_path
                    partition_error = str(exc)
            media_type, _ = mimetypes.guess_type(display_name)
            asset_id = str(uuid.uuid4())
            project_id = str(job.get("project_id") or "default")
            folder_id = self._system_folder_id(connection, project_id)
            metadata: dict[str, Any] = {
                "provider": result.get("provider"),
                "profile": result.get("profile"),
                "duration_seconds": result.get("duration_seconds"),
                "sample_rate": result.get("sample_rate"),
            }
            if isinstance(result.get("metadata"), dict):
                metadata.update(result["metadata"])
            metadata.update({
                "original_source_path": str(original_path),
                "physical_partitioned": physical_partitioned,
                "partition_error": partition_error,
            })
            connection.execute(
                "INSERT OR IGNORE INTO assets(id,project_id,kind,name,source_path,media_type,size_bytes,metadata_json,folder_id,origin_job_id,created_at,organization_id,created_by) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id,
                    project_id,
                    self._media_kind(str(job.get("type", "")), path, media_type),
                    display_name,
                    str(path.resolve()),
                    media_type,
                    path.stat().st_size,
                    json.dumps(metadata, ensure_ascii=False),
                    folder_id,
                    job["id"],
                    job.get("finished_at") or utc_now(),
                    job.get("organization_id") or "clsf-ai-lab",
                    job.get("created_by"),
                ),
            )

    @staticmethod
    def _asset_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        item = dict(row)
        metadata_json = item.pop("metadata_json")
        item["metadata"] = json.loads(metadata_json) if metadata_json else {}
        return item

    def create_project(
        self,
        name: str,
        *,
        organization_id: str = "clsf-ai-lab",
        owner_user_id: str | None = None,
        project_kind: str = "standard",
        avatar_color: str = "#7C8CFF",
    ) -> dict[str, Any]:
        project_id = str(uuid.uuid4())
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "INSERT INTO projects(id,name,created_at,updated_at,organization_id,owner_user_id,project_kind,avatar_color) VALUES(?,?,?,?,?,?,?,?)",
                (project_id, name.strip(), now, now, organization_id, owner_user_id, project_kind, avatar_color),
            )
            self._ensure_asset_folders(connection, project_id)
        return self.get_project(project_id)  # type: ignore[return-value]

    def get_project(self, project_id: str, include_deleted: bool = False) -> dict[str, Any] | None:
        with self.connect() as connection:
            query = "SELECT * FROM projects WHERE id=?" if include_deleted else "SELECT * FROM projects WHERE id=? AND deleted_at IS NULL"
            row = connection.execute(query, (project_id,)).fetchone()
        return dict(row) if row else None

    def list_projects(self, include_deleted: bool = False) -> list[dict[str, Any]]:
        with self.connect() as connection:
            where = "" if include_deleted else "WHERE deleted_at IS NULL"
            rows = connection.execute(
                f"SELECT * FROM projects {where} ORDER BY group_id IS NULL, group_id, sort_order, updated_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def update_project(
        self,
        project_id: str,
        *,
        name: str | None = None,
        group_id: str | None | object = ...,
        avatar_color: str | None = None,
        avatar_image: str | None = None,
        monthly_compute_seconds_limit: int | None | object = ...,
        max_active_jobs: int | None = None,
    ) -> dict[str, Any] | None:
        now = utc_now()
        assignments: list[str] = []
        values: list[Any] = []
        if avatar_image is not None:
            from .avatars import normalize_avatar
            assignments.append("avatar_image=?")
            values.append(normalize_avatar(avatar_image))
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("Project name cannot be empty")
            assignments.append("name=?")
            values.append(cleaned)
        if group_id is not ...:
            if group_id is not None:
                with self.connect() as connection:
                    if not connection.execute("SELECT 1 FROM project_groups WHERE id=?", (group_id,)).fetchone():
                        raise ValueError("Unknown project group")
            assignments.append("group_id=?")
            values.append(group_id)
        if avatar_color is not None:
            cleaned_color = avatar_color.strip()
            if len(cleaned_color) != 7 or not cleaned_color.startswith("#"):
                raise ValueError("Avatar color must be a hexadecimal color")
            assignments.append("avatar_color=?")
            values.append(cleaned_color)
        if monthly_compute_seconds_limit is not ...:
            if monthly_compute_seconds_limit is not None and int(monthly_compute_seconds_limit) < 0:
                raise ValueError("Compute quota cannot be negative")
            assignments.append("monthly_compute_seconds_limit=?")
            values.append(monthly_compute_seconds_limit)
        if max_active_jobs is not None:
            if not 1 <= int(max_active_jobs) <= 500:
                raise ValueError("Active job limit must be between 1 and 500")
            assignments.append("max_active_jobs=?")
            values.append(int(max_active_jobs))
        if not assignments:
            return self.get_project(project_id)
        assignments.append("updated_at=?")
        values.extend([now, project_id])
        with self._write_lock, self.connect() as connection:
            cursor = connection.execute(
                f"UPDATE projects SET {','.join(assignments)} WHERE id=? AND deleted_at IS NULL",
                values,
            )
        return self.get_project(project_id) if cursor.rowcount else None

    def project_storage_root(self, project_id: str) -> Path:
        if self.tenant_root is None:
            raise ValueError("Tenant storage root is not configured")
        project = self.get_project(project_id, include_deleted=True)
        if not project:
            raise ValueError("Unknown project")
        organization_id = str(project.get("organization_id") or "clsf-ai-lab")
        owner_user_id = str(project.get("owner_user_id") or "unassigned")
        return self.tenant_root / organization_id / "users" / owner_user_id / "projects" / project_id

    def usage_summary(self, project_ids: list[str], *, user_id: str | None = None, days: int = 30) -> dict[str, Any]:
        if not project_ids:
            return {
                "compute_seconds": 0,
                "job_count": 0,
                "succeeded_jobs": 0,
                "failed_jobs": 0,
                "queued_jobs": 0,
                "storage_bytes": 0,
                "daily": [],
            }
        placeholders = ",".join("?" for _ in project_ids)
        user_clause = " AND created_by=?" if user_id else ""
        period_clause = " AND date(created_at,'+8 hours')>=date('now','+8 hours',?)"
        period_offset = f"-{max(1, min(days, 365)) - 1} days"
        values: list[Any] = [*project_ids]
        if user_id:
            values.append(user_id)
        values.append(period_offset)
        elapsed = "MAX(0,(julianday(COALESCE(finished_at,CURRENT_TIMESTAMP))-julianday(started_at))*86400.0)"
        with self.connect() as connection:
            totals = connection.execute(
                f"SELECT COUNT(*) AS job_count,"
                f"COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN {elapsed} ELSE 0 END),0) AS compute_seconds,"
                "SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded_jobs,"
                "SUM(CASE WHEN status IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed_jobs,"
                "SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS queued_jobs "
                f"FROM jobs WHERE project_id IN ({placeholders}){user_clause}{period_clause}",
                values,
            ).fetchone()
            asset_values: list[Any] = [*project_ids]
            asset_user_clause = " AND created_by=?" if user_id else ""
            if user_id:
                asset_values.append(user_id)
            storage = connection.execute(
                f"SELECT COALESCE(SUM(size_bytes),0) AS storage_bytes FROM assets WHERE project_id IN ({placeholders}){asset_user_clause}",
                asset_values,
            ).fetchone()
            daily_values: list[Any] = [*project_ids]
            if user_id:
                daily_values.append(user_id)
            daily_values.append(period_offset)
            daily = connection.execute(
                f"SELECT date(created_at,'+8 hours') AS day,COUNT(*) AS jobs,"
                f"COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN {elapsed} ELSE 0 END),0) AS compute_seconds "
                f"FROM jobs WHERE project_id IN ({placeholders}){user_clause}{period_clause} "
                "GROUP BY date(created_at,'+8 hours') ORDER BY day",
                daily_values,
            ).fetchall()
        return {
            "compute_seconds": round(float(totals["compute_seconds"] or 0), 3),
            "job_count": int(totals["job_count"] or 0),
            "succeeded_jobs": int(totals["succeeded_jobs"] or 0),
            "failed_jobs": int(totals["failed_jobs"] or 0),
            "queued_jobs": int(totals["queued_jobs"] or 0),
            "storage_bytes": int(storage["storage_bytes"] or 0),
            "daily": [dict(row) for row in daily],
        }

    def trash_project(self, project_id: str) -> dict[str, Any] | None:
        if project_id == "default":
            raise ValueError("The default demonstration project cannot be deleted")
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            cursor = connection.execute(
                "UPDATE projects SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
                (now, now, project_id),
            )
        return self.get_project(project_id, include_deleted=True) if cursor.rowcount else None

    def restore_project(self, project_id: str) -> dict[str, Any] | None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            cursor = connection.execute(
                "UPDATE projects SET deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NOT NULL",
                (now, project_id),
            )
        return self.get_project(project_id) if cursor.rowcount else None

    def list_project_groups(self, owner_user_id: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as connection:
            if owner_user_id is None:
                rows = connection.execute("SELECT * FROM project_groups ORDER BY sort_order,name COLLATE NOCASE").fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM project_groups WHERE owner_user_id=? ORDER BY sort_order,name COLLATE NOCASE",
                    (owner_user_id,),
                ).fetchall()
        return [dict(row) for row in rows]

    def create_project_group(self, name: str, owner_user_id: str | None = None) -> dict[str, Any]:
        group_id = str(uuid.uuid4())
        now = utc_now()
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("Group name cannot be empty")
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "INSERT INTO project_groups(id,name,created_at,updated_at,owner_user_id) VALUES(?,?,?,?,?)",
                (group_id, cleaned, now, now, owner_user_id),
            )
            row = connection.execute("SELECT * FROM project_groups WHERE id=?", (group_id,)).fetchone()
        return dict(row)

    def rename_project_group(self, group_id: str, name: str, owner_user_id: str | None = None) -> dict[str, Any] | None:
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("Group name cannot be empty")
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            query = "UPDATE project_groups SET name=?,updated_at=? WHERE id=?"
            values: list[Any] = [cleaned, now, group_id]
            if owner_user_id is not None:
                query += " AND owner_user_id=?"
                values.append(owner_user_id)
            cursor = connection.execute(query, values)
            row = connection.execute("SELECT * FROM project_groups WHERE id=?", (group_id,)).fetchone()
        return dict(row) if cursor.rowcount and row else None

    def delete_project_group(self, group_id: str, owner_user_id: str | None = None) -> bool:
        with self._write_lock, self.connect() as connection:
            if owner_user_id is not None and not connection.execute(
                "SELECT 1 FROM project_groups WHERE id=? AND owner_user_id=?",
                (group_id, owner_user_id),
            ).fetchone():
                return False
            connection.execute("UPDATE projects SET group_id=NULL WHERE group_id=?", (group_id,))
            cursor = connection.execute("DELETE FROM project_groups WHERE id=?", (group_id,))
        return bool(cursor.rowcount)

    def get_canvas(self, project_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute("SELECT state_json,updated_at FROM canvas_states WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            return {"project_id": project_id, "state": {"nodes": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}, "updated_at": None}
        return {"project_id": project_id, "state": json.loads(row["state_json"]), "updated_at": row["updated_at"]}

    def save_canvas(self, project_id: str, state: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        payload = json.dumps(state, ensure_ascii=False)
        if len(payload.encode("utf-8")) > 5_000_000:
            raise ValueError("Canvas state exceeds the 5 MB safety limit")
        with self._write_lock, self.connect() as connection:
            if not connection.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError(f"Unknown project: {project_id}")
            connection.execute(
                "INSERT INTO canvas_states(project_id,state_json,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(project_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at",
                (project_id, payload, now),
            )
            connection.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
        return self.get_canvas(project_id)

    def register_asset(
        self,
        project_id: str,
        kind: str,
        name: str,
        source_path: Path,
        media_type: str | None,
        metadata: dict[str, Any] | None = None,
        folder_id: str | None = None,
        organization_id: str = "clsf-ai-lab",
        created_by: str | None = None,
    ) -> dict[str, Any]:
        asset_id = str(uuid.uuid4())
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            if folder_id is None:
                folder_id = self._system_folder_id(connection, project_id)
            elif not connection.execute(
                "SELECT 1 FROM asset_folders WHERE id=? AND project_id=?",
                (folder_id, project_id),
            ).fetchone():
                raise ValueError("Unknown asset folder")
            connection.execute(
                "INSERT INTO assets(id,project_id,kind,name,source_path,media_type,size_bytes,metadata_json,folder_id,created_at,organization_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id,
                    project_id,
                    kind,
                    name,
                    str(source_path.resolve()),
                    media_type,
                    source_path.stat().st_size,
                    json.dumps(metadata or {}, ensure_ascii=False),
                    folder_id,
                    now,
                    organization_id,
                    created_by,
                ),
            )
        return self.get_asset(asset_id)  # type: ignore[return-value]

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return self._asset_row(row)

    def update_asset_metadata(
        self,
        asset_id: str,
        metadata: dict[str, Any],
        *,
        kind: str | None = None,
        media_type: str | None = None,
    ) -> dict[str, Any] | None:
        current = self.get_asset(asset_id)
        if not current:
            return None
        merged = {**(current.get("metadata") or {}), **metadata}
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "UPDATE assets SET metadata_json=?,kind=COALESCE(?,kind),media_type=COALESCE(?,media_type) WHERE id=?",
                (json.dumps(merged, ensure_ascii=False), kind, media_type, asset_id),
            )
        return self.get_asset(asset_id)

    def list_assets(self, project_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM assets WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
                (project_id, limit),
            ).fetchall()
        return [self._asset_row(row) for row in rows]  # type: ignore[misc]

    def list_asset_folders(self, project_id: str) -> list[dict[str, Any]]:
        with self._write_lock, self.connect() as connection:
            if not connection.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("Unknown project")
            self._ensure_asset_folders(connection, project_id)
            rows = connection.execute(
                "SELECT f.*,COUNT(a.id) AS asset_count FROM asset_folders f "
                "LEFT JOIN assets a ON a.folder_id=f.id WHERE f.project_id=? "
                "GROUP BY f.id ORDER BY f.parent_id IS NOT NULL,f.sort_order,f.name COLLATE NOCASE",
                (project_id,),
            ).fetchall()
        items = [dict(row) for row in rows]
        by_id = {item["id"]: item for item in items}
        for item in items:
            names = [item["name"]]
            parent_id = item.get("parent_id")
            visited = {item["id"]}
            while parent_id and parent_id in by_id and parent_id not in visited:
                visited.add(parent_id)
                parent = by_id[parent_id]
                names.insert(0, parent["name"])
                parent_id = parent.get("parent_id")
            item["path"] = " / ".join(names)
            item["asset_count"] = int(item.get("asset_count") or 0)
        return items

    def get_asset_folder(self, folder_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM asset_folders WHERE id=?", (folder_id,)).fetchone()
        return dict(row) if row else None

    def create_asset_folder(
        self,
        project_id: str,
        name: str,
        *,
        parent_id: str | None = None,
        category: str = "custom",
    ) -> dict[str, Any]:
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("Folder name cannot be empty")
        folder_id = str(uuid.uuid4())
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            if not connection.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("Unknown project")
            if parent_id and not connection.execute(
                "SELECT 1 FROM asset_folders WHERE id=? AND project_id=?",
                (parent_id, project_id),
            ).fetchone():
                raise ValueError("Unknown parent folder")
            try:
                connection.execute(
                    "INSERT INTO asset_folders(id,project_id,parent_id,name,category,system_key,sort_order,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,NULL,100,?,?)",
                    (folder_id, project_id, parent_id, cleaned, category or "custom", now, now),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("A folder with this name already exists here") from exc
        return next(item for item in self.list_asset_folders(project_id) if item["id"] == folder_id)

    def update_asset_folder(
        self,
        folder_id: str,
        *,
        name: str | None = None,
        parent_id: str | None | object = ...,
    ) -> dict[str, Any] | None:
        current: dict[str, Any] | None
        with self._write_lock, self.connect() as connection:
            row = connection.execute("SELECT * FROM asset_folders WHERE id=?", (folder_id,)).fetchone()
            current = dict(row) if row else None
            if not current:
                return None
            assignments: list[str] = []
            values: list[Any] = []
            if name is not None:
                cleaned = name.strip()
                if not cleaned:
                    raise ValueError("Folder name cannot be empty")
                assignments.append("name=?")
                values.append(cleaned)
            if parent_id is not ...:
                if current.get("system_key"):
                    raise ValueError("Built-in folders cannot be nested")
                if parent_id == folder_id:
                    raise ValueError("A folder cannot contain itself")
                if parent_id and not connection.execute(
                    "SELECT 1 FROM asset_folders WHERE id=? AND project_id=?",
                    (parent_id, current["project_id"]),
                ).fetchone():
                    raise ValueError("Unknown parent folder")
                assignments.append("parent_id=?")
                values.append(parent_id)
            if assignments:
                assignments.append("updated_at=?")
                values.extend([utc_now(), folder_id])
                try:
                    connection.execute(f"UPDATE asset_folders SET {','.join(assignments)} WHERE id=?", values)
                except sqlite3.IntegrityError as exc:
                    raise ValueError("A folder with this name already exists here") from exc
        return next(item for item in self.list_asset_folders(current["project_id"]) if item["id"] == folder_id)

    def delete_asset_folder(self, folder_id: str) -> bool:
        with self._write_lock, self.connect() as connection:
            row = connection.execute("SELECT * FROM asset_folders WHERE id=?", (folder_id,)).fetchone()
            if not row:
                return False
            if row["system_key"]:
                raise ValueError("Built-in folders cannot be deleted")
            unfiled = self._system_folder_id(connection, row["project_id"])
            connection.execute("UPDATE assets SET folder_id=? WHERE folder_id=?", (unfiled, folder_id))
            connection.execute("UPDATE asset_folders SET parent_id=NULL WHERE parent_id=?", (folder_id,))
            connection.execute("DELETE FROM asset_folders WHERE id=?", (folder_id,))
        return True

    def update_asset(
        self,
        asset_id: str,
        *,
        name: str | None = None,
        folder_id: str | None | object = ...,
    ) -> dict[str, Any] | None:
        current = self.get_asset(asset_id)
        if not current:
            return None
        assignments: list[str] = []
        values: list[Any] = []
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("Asset name cannot be empty")
            assignments.append("name=?")
            values.append(cleaned)
        with self._write_lock, self.connect() as connection:
            if folder_id is not ...:
                resolved_folder = folder_id or self._system_folder_id(connection, current["project_id"])
                if not connection.execute(
                    "SELECT 1 FROM asset_folders WHERE id=? AND project_id=?",
                    (resolved_folder, current["project_id"]),
                ).fetchone():
                    raise ValueError("Unknown asset folder")
                assignments.append("folder_id=?")
                values.append(resolved_folder)
            if assignments:
                values.append(asset_id)
                connection.execute(f"UPDATE assets SET {','.join(assignments)} WHERE id=?", values)
        return self.get_asset(asset_id)

    def set_approval(self, job_id: str, status: str, note: str | None = None) -> dict[str, Any]:
        if status not in {"approved", "rejected", "pending"}:
            raise ValueError("Approval status must be approved, rejected, or pending")
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            row = connection.execute("SELECT type,status,params_json FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise ValueError("Job not found")
            params = json.loads(row["params_json"])
            if row["type"] != "h3.t2v" or str(params.get("profile")) == "quality":
                raise ValueError("Only completed H3 preview jobs can be reviewed")
            if row["status"] != "succeeded":
                raise ValueError("Preview must succeed before it can be reviewed")
            approved_at = now if status == "approved" else None
            connection.execute(
                "UPDATE jobs SET approval_status=?,approval_note=?,approved_at=?,updated_at=? WHERE id=?",
                (status, note, approved_at, now, job_id),
            )
            self._event(connection, job_id, "reviewed", {"status": status, "note": note})
        return self.get(job_id)  # type: ignore[return-value]

    def link_final(self, preview_job_id: str, final_job_id: str) -> None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "UPDATE jobs SET final_job_id=?,updated_at=? WHERE id=?",
                (final_job_id, now, preview_job_id),
            )
            self._event(connection, preview_job_id, "final_queued", {"final_job_id": final_job_id})

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self._write_lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                connection.execute("ROLLBACK")
                return None
            now = utc_now()
            if row["status"] == "queued":
                connection.execute(
                    "UPDATE jobs SET status='cancelled', cancel_requested=1, stage='cancelled', updated_at=?, finished_at=? WHERE id=?",
                    (now, now, job_id),
                )
                self._event(connection, job_id, "cancelled", {"while": "queued"})
            elif row["status"] == "running":
                connection.execute(
                    "UPDATE jobs SET cancel_requested=1, stage='cancelling', updated_at=? WHERE id=?",
                    (now, job_id),
                )
                self._event(connection, job_id, "cancel_requested", {})
            connection.execute("COMMIT")
        return self.get(job_id)

    def cancellation_requested(self, job_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
        return bool(row and row["cancel_requested"])

    def counts(self) -> dict[str, int]:
        with self.connect() as connection:
            rows = connection.execute("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status").fetchall()
        return {row["status"]: row["count"] for row in rows}

    def current(self) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT jobs.* FROM jobs JOIN resource_leases ON resource_leases.job_id=jobs.id WHERE resource_leases.resource='gpu0'"
            ).fetchone()
        return self._row(row)
