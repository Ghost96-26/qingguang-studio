from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator


DEFAULT_ORGANIZATION_ID = "clsf-ai-lab"
DEFAULT_OWNER_ID = "local-owner"
PROJECT_ROLE_RANK = {"viewer": 10, "reviewer": 20, "editor": 30, "owner": 40}
ORG_ADMIN_ROLES = {"owner", "admin"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _future(**kwargs: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kwargs)).isoformat()


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("密码至少需要10个字符")
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**15, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
    return f"scrypt$32768$8$1${salt.hex()}${derived.hex()}"


def verify_password(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        algorithm, n, r, p, salt, expected = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(bytes.fromhex(expected)),
            maxmem=64 * 1024 * 1024,
        )
        return hmac.compare_digest(derived.hex(), expected)
    except (ValueError, TypeError):
        return False


@dataclass(frozen=True)
class Principal:
    user_id: str
    organization_id: str
    organization_role: str
    email: str
    name: str
    can_create_projects: bool
    avatar_color: str = "#7C8CFF"
    avatar_image: str = ""
    session_id: str | None = None
    csrf_token: str | None = None
    auth_mode: str = "session"

    @property
    def is_admin(self) -> bool:
        return self.organization_role in ORG_ADMIN_ROLES

    def public(self) -> dict[str, Any]:
        return {
            "id": self.user_id,
            "organization_id": self.organization_id,
            "organization_role": self.organization_role,
            "email": self.email,
            "name": self.name,
            "can_create_projects": self.can_create_projects,
            "avatar_color": self.avatar_color,
            "avatar_image": self.avatar_image,
            "is_admin": self.is_admin,
        }


class AuthStore:
    """Account, invitation and authorization data sharing the workbench SQLite file.

    The schema is deliberately additive so existing single-user workspaces can be
    upgraded in place.  A later PostgreSQL migration can preserve the same API.
    """

    def __init__(self, database: Path):
        self.database = database
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

    @staticmethod
    def _ensure_column(connection: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def initialize(self) -> None:
        with self._write_lock, self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS organizations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    name TEXT NOT NULL,
                    password_hash TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    can_create_projects INTEGER NOT NULL DEFAULT 0,
                    monthly_compute_seconds_limit INTEGER,
                    max_active_jobs INTEGER NOT NULL DEFAULT 50,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_login_at TEXT
                );
                CREATE TABLE IF NOT EXISTS organization_memberships (
                    organization_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(organization_id,user_id),
                    FOREIGN KEY(organization_id) REFERENCES organizations(id),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS project_memberships (
                    project_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    monthly_compute_seconds_limit INTEGER,
                    max_active_jobs INTEGER NOT NULL DEFAULT 50,
                    queue_priority INTEGER NOT NULL DEFAULT 3,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(project_id,user_id),
                    FOREIGN KEY(project_id) REFERENCES projects(id),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS invitations (
                    id TEXT PRIMARY KEY,
                    organization_id TEXT NOT NULL,
                    code_hash TEXT NOT NULL UNIQUE,
                    email TEXT COLLATE NOCASE,
                    project_id TEXT,
                    project_role TEXT NOT NULL DEFAULT 'viewer',
                    can_create_projects INTEGER NOT NULL DEFAULT 0,
                    max_uses INTEGER NOT NULL DEFAULT 1,
                    use_count INTEGER NOT NULL DEFAULT 0,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    FOREIGN KEY(organization_id) REFERENCES organizations(id),
                    FOREIGN KEY(project_id) REFERENCES projects(id),
                    FOREIGN KEY(created_by) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS invitation_redemptions (
                    invitation_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    redeemed_at TEXT NOT NULL,
                    PRIMARY KEY(invitation_id,user_id),
                    FOREIGN KEY(invitation_id) REFERENCES invitations(id),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    csrf_token TEXT NOT NULL,
                    user_agent TEXT,
                    ip_address TEXT,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    revoked_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
                CREATE TABLE IF NOT EXISTS download_grants (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    asset_id TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    max_uses INTEGER NOT NULL DEFAULT 40,
                    use_count INTEGER NOT NULL DEFAULT 0,
                    revoked_at TEXT,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    FOREIGN KEY(asset_id) REFERENCES assets(id),
                    FOREIGN KEY(created_by) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS upload_sessions (
                    id TEXT PRIMARY KEY,
                    organization_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    original_name TEXT NOT NULL,
                    media_type TEXT,
                    folder_id TEXT,
                    size_bytes INTEGER NOT NULL,
                    chunk_size INTEGER NOT NULL,
                    expected_sha256 TEXT,
                    status TEXT NOT NULL DEFAULT 'open',
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    completed_at TEXT,
                    FOREIGN KEY(project_id) REFERENCES projects(id),
                    FOREIGN KEY(created_by) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS upload_chunks (
                    upload_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(upload_id,chunk_index),
                    FOREIGN KEY(upload_id) REFERENCES upload_sessions(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id TEXT,
                    user_id TEXT,
                    action TEXT NOT NULL,
                    target_type TEXT,
                    target_id TEXT,
                    detail_json TEXT,
                    ip_address TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(organization_id,created_at DESC);
                """
            )
            for table, columns in {
                "projects": (
                    ("organization_id", f"TEXT NOT NULL DEFAULT '{DEFAULT_ORGANIZATION_ID}'"),
                    ("owner_user_id", "TEXT"),
                ),
                "jobs": (
                    ("organization_id", f"TEXT NOT NULL DEFAULT '{DEFAULT_ORGANIZATION_ID}'"),
                    ("created_by", "TEXT"),
                ),
                "assets": (
                    ("organization_id", f"TEXT NOT NULL DEFAULT '{DEFAULT_ORGANIZATION_ID}'"),
                    ("created_by", "TEXT"),
                ),
            }.items():
                for column, definition in columns:
                    self._ensure_column(connection, table, column, definition)
            self._ensure_column(connection, "users", "avatar_color", "TEXT NOT NULL DEFAULT '#7C8CFF'")
            self._ensure_column(connection, "users", "avatar_image", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(connection, "users", "monthly_compute_seconds_limit", "INTEGER")
            self._ensure_column(connection, "users", "max_active_jobs", "INTEGER NOT NULL DEFAULT 50")
            self._ensure_column(connection, "project_memberships", "monthly_compute_seconds_limit", "INTEGER")
            self._ensure_column(connection, "project_memberships", "max_active_jobs", "INTEGER NOT NULL DEFAULT 50")
            self._ensure_column(connection, "project_memberships", "queue_priority", "INTEGER NOT NULL DEFAULT 3")

            now = utc_now()
            connection.execute(
                "INSERT OR IGNORE INTO organizations(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                (DEFAULT_ORGANIZATION_ID, "CLSF AI. Lab", now, now),
            )
            connection.execute(
                "INSERT OR IGNORE INTO users(id,email,name,password_hash,status,can_create_projects,created_at,updated_at) "
                "VALUES(?,?,?,?, 'active',1,?,?)",
                (DEFAULT_OWNER_ID, "owner@local.clsf", "本机平台主管", None, now, now),
            )
            connection.execute(
                "INSERT OR IGNORE INTO organization_memberships(organization_id,user_id,role,created_at) VALUES(?,?,?,?)",
                (DEFAULT_ORGANIZATION_ID, DEFAULT_OWNER_ID, "owner", now),
            )
            connection.execute(
                "UPDATE projects SET organization_id=COALESCE(organization_id,?),owner_user_id=COALESCE(owner_user_id,?)",
                (DEFAULT_ORGANIZATION_ID, DEFAULT_OWNER_ID),
            )
            connection.execute(
                "UPDATE jobs SET organization_id=COALESCE(organization_id,?),created_by=COALESCE(created_by,?)",
                (DEFAULT_ORGANIZATION_ID, DEFAULT_OWNER_ID),
            )
            connection.execute(
                "UPDATE assets SET organization_id=COALESCE(organization_id,?),created_by=COALESCE(created_by,?)",
                (DEFAULT_ORGANIZATION_ID, DEFAULT_OWNER_ID),
            )
            # Legacy recovery is intentionally limited to projects already owned by
            # the local account. Platform administration never implies project access.
            connection.execute(
                "INSERT OR IGNORE INTO project_memberships(project_id,user_id,role,created_at,updated_at) "
                "SELECT id,?,'owner',?,? FROM projects WHERE owner_user_id=?",
                (DEFAULT_OWNER_ID, now, now, DEFAULT_OWNER_ID),
            )
            connection.execute("UPDATE users SET can_create_projects=1 WHERE id=?", (DEFAULT_OWNER_ID,))
            connection.execute("UPDATE project_groups SET owner_user_id=? WHERE owner_user_id IS NULL", (DEFAULT_OWNER_ID,))
            connection.execute("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL", (now,))
            connection.execute("DELETE FROM download_grants WHERE expires_at < ? OR revoked_at IS NOT NULL", (now,))

    @staticmethod
    def _session_payload(token: str, csrf_token: str, principal: Principal) -> dict[str, Any]:
        return {"session_token": token, "csrf_token": csrf_token, "user": principal.public()}

    def _principal_for_user(self, connection: sqlite3.Connection, user_id: str, *, session: sqlite3.Row | None = None) -> Principal | None:
        row = connection.execute(
            "SELECT u.*,m.organization_id,m.role AS organization_role FROM users u "
            "JOIN organization_memberships m ON m.user_id=u.id WHERE u.id=? AND u.status='active' LIMIT 1",
            (user_id,),
        ).fetchone()
        if not row:
            return None
        return Principal(
            user_id=row["id"],
            organization_id=row["organization_id"],
            organization_role=row["organization_role"],
            email=row["email"],
            name=row["name"],
            can_create_projects=bool(row["can_create_projects"]),
            avatar_color=str(row["avatar_color"] or "#7C8CFF"),
            avatar_image=str(row["avatar_image"] or ""),
            session_id=session["id"] if session else None,
            csrf_token=session["csrf_token"] if session else None,
        )

    def create_session(self, user_id: str, *, user_agent: str = "", ip_address: str = "", days: int = 7) -> dict[str, Any]:
        token = secrets.token_urlsafe(48)
        csrf_token = secrets.token_urlsafe(32)
        session_id = str(uuid.uuid4())
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "INSERT INTO sessions(id,user_id,token_hash,csrf_token,user_agent,ip_address,created_at,expires_at,last_seen_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (session_id, user_id, _digest(token), csrf_token, user_agent[:500], ip_address[:120], now, _future(days=days), now),
            )
            connection.execute("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?", (now, now, user_id))
            session = connection.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
            principal = self._principal_for_user(connection, user_id, session=session)
            if not principal:
                raise ValueError("账户不可用")
            self._write_audit(connection, principal.organization_id, user_id, "auth.login", "session", session_id, {}, ip_address)
        return self._session_payload(token, csrf_token, principal)

    def local_owner_session(self, *, user_agent: str = "", ip_address: str = "") -> dict[str, Any]:
        return self.create_session(DEFAULT_OWNER_ID, user_agent=user_agent, ip_address=ip_address)

    def local_owner_principal(self) -> Principal:
        with self.connect() as connection:
            principal = self._principal_for_user(connection, DEFAULT_OWNER_ID)
        if not principal:
            raise ValueError("本机管理员账户尚未初始化")
        return Principal(**{**principal.__dict__, "auth_mode": "legacy_api_key"})

    def principal_from_token(self, token: str) -> Principal | None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            session = connection.execute(
                "SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
                (_digest(token), now),
            ).fetchone()
            if not session:
                return None
            try:
                last_seen = datetime.fromisoformat(str(session["last_seen_at"]))
                if datetime.now(timezone.utc) - last_seen.astimezone(timezone.utc) >= timedelta(minutes=5):
                    connection.execute("UPDATE sessions SET last_seen_at=? WHERE id=?", (now, session["id"]))
                    session = connection.execute("SELECT * FROM sessions WHERE id=?", (session["id"],)).fetchone()
            except (TypeError, ValueError):
                connection.execute("UPDATE sessions SET last_seen_at=? WHERE id=?", (now, session["id"]))
                session = connection.execute("SELECT * FROM sessions WHERE id=?", (session["id"],)).fetchone()
            return self._principal_for_user(connection, session["user_id"], session=session)

    def authenticate(self, email: str, password: str, *, user_agent: str = "", ip_address: str = "") -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT u.id,u.password_hash,u.status,m.organization_id FROM users u "
                "LEFT JOIN organization_memberships m ON m.user_id=u.id WHERE u.email=? COLLATE NOCASE LIMIT 1",
                (email.strip(),),
            ).fetchone()
        if not row or row["status"] != "active" or not verify_password(password, row["password_hash"]):
            self.audit(row["organization_id"] if row else None, row["id"] if row else None, "auth.login_failed", "user", email.strip().lower(), {}, ip_address)
            raise ValueError("邮箱或密码不正确")
        return self.create_session(row["id"], user_agent=user_agent, ip_address=ip_address)

    def set_password(self, principal: Principal, password: str) -> None:
        encoded = hash_password(password)
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute("UPDATE users SET password_hash=?,updated_at=? WHERE id=?", (encoded, now, principal.user_id))
            connection.execute(
                "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?",
                (now, principal.user_id, principal.session_id or ""),
            )
            self._write_audit(connection, principal.organization_id, principal.user_id, "auth.password_set", "user", principal.user_id, {})

    def update_profile(self, principal: Principal, *, name: str | None = None, avatar_color: str | None = None, avatar_image: str | None = None) -> dict[str, Any]:
        assignments: list[str] = []
        values: list[Any] = []
        if avatar_image is not None:
            from .avatars import normalize_avatar
            assignments.append("avatar_image=?")
            values.append(normalize_avatar(avatar_image))
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("姓名不能为空")
            assignments.append("name=?")
            values.append(cleaned)
        if avatar_color is not None:
            cleaned_color = avatar_color.strip()
            if len(cleaned_color) != 7 or not cleaned_color.startswith("#"):
                raise ValueError("头像颜色格式无效")
            try:
                int(cleaned_color[1:], 16)
            except ValueError as exc:
                raise ValueError("头像颜色格式无效") from exc
            assignments.append("avatar_color=?")
            values.append(cleaned_color)
        if assignments:
            assignments.append("updated_at=?")
            values.extend([utc_now(), principal.user_id])
            with self._write_lock, self.connect() as connection:
                connection.execute(f"UPDATE users SET {','.join(assignments)} WHERE id=?", values)
                self._write_audit(connection, principal.organization_id, principal.user_id, "auth.profile_update", "user", principal.user_id, {})
        with self.connect() as connection:
            updated = self._principal_for_user(connection, principal.user_id)
        if not updated:
            raise ValueError("账户不可用")
        return updated.public()

    def revoke_session(self, principal: Principal) -> None:
        if not principal.session_id:
            return
        with self._write_lock, self.connect() as connection:
            connection.execute("UPDATE sessions SET revoked_at=? WHERE id=?", (utc_now(), principal.session_id))
            self._write_audit(connection, principal.organization_id, principal.user_id, "auth.logout", "session", principal.session_id, {})

    def list_projects_for(self, principal: Principal, *, include_deleted: bool = False) -> set[str]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT pm.project_id FROM project_memberships pm JOIN projects p ON p.id=pm.project_id "
                "WHERE pm.user_id=? AND p.organization_id=?" + ("" if include_deleted else " AND p.deleted_at IS NULL"),
                (principal.user_id, principal.organization_id),
            ).fetchall()
        return {str(row["project_id"]) for row in rows}

    def project_role(self, principal: Principal, project_id: str) -> str | None:
        with self.connect() as connection:
            project = connection.execute("SELECT organization_id FROM projects WHERE id=?", (project_id,)).fetchone()
            if not project or project["organization_id"] != principal.organization_id:
                return None
            membership = connection.execute(
                "SELECT role FROM project_memberships WHERE project_id=? AND user_id=?",
                (project_id, principal.user_id),
            ).fetchone()
            return str(membership["role"]) if membership else None

    def can_project(self, principal: Principal, project_id: str, minimum_role: str = "viewer") -> bool:
        role = self.project_role(principal, project_id)
        return bool(role and PROJECT_ROLE_RANK.get(role, 0) >= PROJECT_ROLE_RANK[minimum_role])

    def add_project_owner(self, project_id: str, principal: Principal) -> None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "UPDATE projects SET organization_id=?,owner_user_id=? WHERE id=?",
                (principal.organization_id, principal.user_id, project_id),
            )
            connection.execute(
                "INSERT INTO project_memberships(project_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(project_id,user_id) DO UPDATE SET role='owner',updated_at=excluded.updated_at",
                (project_id, principal.user_id, "owner", now, now),
            )
            self._write_audit(connection, principal.organization_id, principal.user_id, "project.create", "project", project_id, {})

    def list_project_members(self, principal: Principal, project_id: str) -> list[dict[str, Any]]:
        if not self.can_project(principal, project_id, "viewer"):
            raise PermissionError("无权查看该项目成员")
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT u.id,u.email,u.name,u.status,u.avatar_color,u.avatar_image,pm.role,pm.monthly_compute_seconds_limit,"
                "pm.max_active_jobs,pm.queue_priority,pm.created_at,pm.updated_at,"
                "COALESCE((SELECT SUM(MAX(0,(julianday(COALESCE(j.finished_at,CURRENT_TIMESTAMP))-julianday(j.started_at))*86400.0)) "
                "FROM jobs j WHERE j.project_id=pm.project_id AND j.created_by=pm.user_id AND j.started_at IS NOT NULL "
                "AND date(j.started_at,'+8 hours')>=date('now','+8 hours','start of month')),0) AS month_compute_seconds "
                "FROM project_memberships pm "
                "JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? ORDER BY pm.role,u.name",
                (project_id,),
            ).fetchall()
        caller_role = self.project_role(principal, project_id)
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            if caller_role != "owner" and item["id"] != principal.user_id:
                item["email"] = ""
                item.pop("monthly_compute_seconds_limit", None)
                item.pop("max_active_jobs", None)
                item.pop("queue_priority", None)
                item.pop("month_compute_seconds", None)
            result.append(item)
        return result

    def update_project_member(
        self,
        principal: Principal,
        project_id: str,
        user_id: str,
        *,
        role: str | None = None,
        monthly_compute_seconds_limit: int | None | object = ...,
        max_active_jobs: int | None = None,
        queue_priority: int | None = None,
    ) -> dict[str, Any]:
        if self.project_role(principal, project_id) != "owner":
            raise PermissionError("只有项目负责人可以调整成员权限和额度")
        if role is not None and role not in PROJECT_ROLE_RANK:
            raise ValueError("无效的项目角色")
        assignments: list[str] = []
        values: list[Any] = []
        if role is not None:
            assignments.append("role=?")
            values.append(role)
        if monthly_compute_seconds_limit is not ...:
            if monthly_compute_seconds_limit is not None and int(monthly_compute_seconds_limit) < 0:
                raise ValueError("成员额度不能为负数")
            assignments.append("monthly_compute_seconds_limit=?")
            values.append(monthly_compute_seconds_limit)
        if max_active_jobs is not None:
            if not 1 <= int(max_active_jobs) <= 500:
                raise ValueError("同时排队任务上限应在1到500之间")
            assignments.append("max_active_jobs=?")
            values.append(int(max_active_jobs))
        if queue_priority is not None:
            if not 1 <= int(queue_priority) <= 5:
                raise ValueError("队列优先级应在1到5之间")
            assignments.append("queue_priority=?")
            values.append(int(queue_priority))
        if not assignments:
            members = self.list_project_members(principal, project_id)
            member = next((item for item in members if item["id"] == user_id), None)
            if not member:
                raise ValueError("项目成员不存在")
            return member
        now = utc_now()
        assignments.append("updated_at=?")
        values.extend([now, project_id, user_id])
        with self._write_lock, self.connect() as connection:
            current = connection.execute(
                "SELECT role FROM project_memberships WHERE project_id=? AND user_id=?",
                (project_id, user_id),
            ).fetchone()
            if not current:
                raise ValueError("项目成员不存在")
            if current["role"] == "owner" and role is not None and role != "owner":
                owners = connection.execute(
                    "SELECT COUNT(*) AS count FROM project_memberships WHERE project_id=? AND role='owner'",
                    (project_id,),
                ).fetchone()["count"]
                if owners <= 1:
                    raise ValueError("项目必须保留至少一名负责人")
            cursor = connection.execute(
                f"UPDATE project_memberships SET {','.join(assignments)} WHERE project_id=? AND user_id=?",
                values,
            )
            if not cursor.rowcount:
                raise ValueError("项目成员不存在")
            self._write_audit(connection, principal.organization_id, principal.user_id, "project.member_update", "user", user_id, {"project_id": project_id})
        member = next(item for item in self.list_project_members(principal, project_id) if item["id"] == user_id)
        return member

    def remove_project_member(self, principal: Principal, project_id: str, user_id: str) -> bool:
        if self.project_role(principal, project_id) != "owner":
            raise PermissionError("只有项目负责人可以移除成员")
        with self._write_lock, self.connect() as connection:
            member = connection.execute(
                "SELECT role FROM project_memberships WHERE project_id=? AND user_id=?",
                (project_id, user_id),
            ).fetchone()
            if not member:
                return False
            if member["role"] == "owner":
                raise ValueError("请先转让或新增项目负责人，再移除该成员")
            cursor = connection.execute(
                "DELETE FROM project_memberships WHERE project_id=? AND user_id=?",
                (project_id, user_id),
            )
            connection.execute(
                "UPDATE upload_sessions SET status='revoked' WHERE project_id=? AND created_by=? AND status='open'",
                (project_id, user_id),
            )
            connection.execute(
                "UPDATE download_grants SET revoked_at=? WHERE created_by=? AND asset_id IN (SELECT id FROM assets WHERE project_id=?) AND revoked_at IS NULL",
                (utc_now(), user_id, project_id),
            )
            self._write_audit(connection, principal.organization_id, principal.user_id, "project.member_remove", "user", user_id, {"project_id": project_id})
        return bool(cursor.rowcount)

    def create_invitation(
        self,
        principal: Principal,
        *,
        email: str | None,
        project_id: str | None,
        project_role: str,
        can_create_projects: bool,
        expires_hours: int,
        max_uses: int,
    ) -> dict[str, Any]:
        if project_id:
            if self.project_role(principal, project_id) != "owner":
                raise PermissionError("只有项目负责人可以邀请项目成员")
        elif not principal.is_admin:
            raise PermissionError("只有平台主管可以创建开户邀请")
        if project_role not in PROJECT_ROLE_RANK:
            raise ValueError("无效的项目角色")
        code = secrets.token_urlsafe(32)
        invite_id = str(uuid.uuid4())
        now = utc_now()
        expires_at = _future(hours=max(1, min(expires_hours, 24 * 90)))
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "INSERT INTO invitations(id,organization_id,code_hash,email,project_id,project_role,can_create_projects,max_uses,expires_at,created_by,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    invite_id,
                    principal.organization_id,
                    _digest(code),
                    email.strip().lower() if email else None,
                    project_id,
                    project_role,
                    int(can_create_projects),
                    max(1, min(max_uses, 100)),
                    expires_at,
                    principal.user_id,
                    now,
                ),
            )
            self._write_audit(connection, principal.organization_id, principal.user_id, "invitation.create", "invitation", invite_id, {"project_id": project_id, "role": project_role})
        result = self.get_invitation(invite_id)
        assert result
        result["code"] = code
        return result

    @staticmethod
    def _invitation_row(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item.pop("code_hash", None)
        item["active"] = not item.get("revoked_at") and item["expires_at"] > utc_now() and item["use_count"] < item["max_uses"]
        item["can_create_projects"] = bool(item["can_create_projects"])
        return item

    def get_invitation(self, invitation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM invitations WHERE id=?", (invitation_id,)).fetchone()
        return self._invitation_row(row) if row else None

    def invitation_preview(self, code: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT i.*,o.name AS organization_name,p.name AS project_name FROM invitations i "
                "JOIN organizations o ON o.id=i.organization_id LEFT JOIN projects p ON p.id=i.project_id WHERE i.code_hash=?",
                (_digest(code),),
            ).fetchone()
        if not row:
            raise ValueError("邀请码无效")
        item = self._invitation_row(row)
        if not item["active"]:
            raise ValueError("邀请码已过期、已撤销或已达到使用上限")
        return {key: item.get(key) for key in ("id", "email", "project_role", "organization_name", "project_name", "expires_at")}

    def list_invitations(self, principal: Principal, project_id: str | None = None) -> list[dict[str, Any]]:
        if project_id and self.project_role(principal, project_id) != "owner":
            raise PermissionError("只有项目负责人可以查看项目邀请")
        with self.connect() as connection:
            if project_id:
                rows = connection.execute(
                    "SELECT i.*,p.name AS project_name FROM invitations i LEFT JOIN projects p ON p.id=i.project_id "
                    "WHERE i.project_id=? ORDER BY i.created_at DESC LIMIT 300",
                    (project_id,),
                ).fetchall()
            elif principal.is_admin:
                rows = connection.execute(
                    "SELECT i.*,p.name AS project_name FROM invitations i LEFT JOIN projects p ON p.id=i.project_id "
                    "WHERE i.organization_id=? AND (i.project_id IS NULL OR i.created_by=?) ORDER BY i.created_at DESC LIMIT 300",
                    (principal.organization_id, principal.user_id),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT i.*,p.name AS project_name FROM invitations i LEFT JOIN projects p ON p.id=i.project_id "
                    "WHERE i.created_by=? ORDER BY i.created_at DESC LIMIT 300",
                    (principal.user_id,),
                ).fetchall()
        return [self._invitation_row(row) for row in rows]

    def revoke_invitation(self, principal: Principal, invitation_id: str) -> bool:
        with self._write_lock, self.connect() as connection:
            invitation = connection.execute("SELECT project_id,created_by FROM invitations WHERE id=?", (invitation_id,)).fetchone()
            if not invitation:
                return False
            permitted = invitation["created_by"] == principal.user_id
            if invitation["project_id"]:
                permitted = permitted or self.project_role(principal, invitation["project_id"]) == "owner"
            else:
                permitted = permitted or principal.is_admin
            if not permitted:
                raise PermissionError("无权撤销该邀请")
            cursor = connection.execute(
                "UPDATE invitations SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL",
                (utc_now(), invitation_id, principal.organization_id),
            )
            if cursor.rowcount:
                self._write_audit(connection, principal.organization_id, principal.user_id, "invitation.revoke", "invitation", invitation_id, {})
        return bool(cursor.rowcount)

    def register_with_invitation(
        self,
        *,
        code: str,
        email: str,
        name: str,
        password: str,
        user_agent: str = "",
        ip_address: str = "",
    ) -> dict[str, Any]:
        normalized_email = email.strip().lower()
        cleaned_name = name.strip()
        if not cleaned_name:
            raise ValueError("请输入姓名")
        password_hash = hash_password(password)
        now = utc_now()
        user_id = str(uuid.uuid4())
        with self._write_lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                invite = connection.execute("SELECT * FROM invitations WHERE code_hash=?", (_digest(code),)).fetchone()
                if not invite or invite["revoked_at"] or invite["expires_at"] <= now or invite["use_count"] >= invite["max_uses"]:
                    raise ValueError("邀请码已过期、已撤销或已达到使用上限")
                if invite["email"] and str(invite["email"]).lower() != normalized_email:
                    raise ValueError("注册邮箱与邀请绑定邮箱不一致")
                if invite["project_id"]:
                    project = connection.execute("SELECT organization_id,deleted_at FROM projects WHERE id=?", (invite["project_id"],)).fetchone()
                    if not project or project["deleted_at"] or project["organization_id"] != invite["organization_id"]:
                        raise ValueError("邀请对应的项目已不可用")
                connection.execute(
                    "INSERT INTO users(id,email,name,password_hash,status,can_create_projects,created_at,updated_at) VALUES(?,?,?,?, 'active',?,?,?)",
                    (user_id, normalized_email, cleaned_name, password_hash, 1, now, now),
                )
                connection.execute(
                    "INSERT INTO organization_memberships(organization_id,user_id,role,created_at) VALUES(?,?, 'member',?)",
                    (invite["organization_id"], user_id, now),
                )
                if invite["project_id"]:
                    connection.execute(
                        "INSERT INTO project_memberships(project_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)",
                        (invite["project_id"], user_id, invite["project_role"], now, now),
                    )
                connection.execute(
                    "INSERT OR IGNORE INTO invitation_redemptions(invitation_id,user_id,redeemed_at) VALUES(?,?,?)",
                    (invite["id"], user_id, now),
                )
                connection.execute(
                    "UPDATE invitations SET use_count=use_count+1,last_used_at=? WHERE id=?",
                    (now, invite["id"]),
                )
                self._write_audit(connection, invite["organization_id"], user_id, "invitation.redeem", "invitation", invite["id"], {"email": normalized_email}, ip_address)
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return self.create_session(user_id, user_agent=user_agent, ip_address=ip_address)

    def redeem_invitation(self, principal: Principal, code: str) -> dict[str, Any]:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                invite = connection.execute("SELECT * FROM invitations WHERE code_hash=?", (_digest(code),)).fetchone()
                if not invite:
                    raise ValueError("邀请码无效")
                if invite["organization_id"] != principal.organization_id:
                    raise PermissionError("该邀请不属于当前工作台组织")
                invited_project = connection.execute(
                    "SELECT organization_id,deleted_at FROM projects WHERE id=?", (invite["project_id"],)
                ).fetchone() if invite["project_id"] else None
                if invite["project_id"] and (not invited_project or invited_project["deleted_at"] or invited_project["organization_id"] != principal.organization_id):
                    raise ValueError("邀请对应的项目已不可用")
                existing = connection.execute(
                    "SELECT role FROM project_memberships WHERE project_id=? AND user_id=?",
                    (invite["project_id"], principal.user_id),
                ).fetchone() if invite["project_id"] else None
                redeemed = connection.execute(
                    "SELECT 1 FROM invitation_redemptions WHERE invitation_id=? AND user_id=?",
                    (invite["id"], principal.user_id),
                ).fetchone()
                if not redeemed and (invite["revoked_at"] or invite["expires_at"] <= now or invite["use_count"] >= invite["max_uses"]):
                    raise ValueError("邀请码已过期、已撤销或已达到使用上限")
                if invite["email"] and str(invite["email"]).lower() != principal.email.lower():
                    raise ValueError("当前账户与邀请绑定邮箱不一致")
                if not invite["project_id"]:
                    raise ValueError("该邀请码只用于新账户注册")
                if not existing:
                    connection.execute(
                        "INSERT INTO project_memberships(project_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)",
                        (invite["project_id"], principal.user_id, invite["project_role"], now, now),
                    )
                    connection.execute("UPDATE invitations SET use_count=use_count+1,last_used_at=? WHERE id=?", (now, invite["id"]))
                    connection.execute(
                        "INSERT OR IGNORE INTO invitation_redemptions(invitation_id,user_id,redeemed_at) VALUES(?,?,?)",
                        (invite["id"], principal.user_id, now),
                    )
                self._write_audit(connection, principal.organization_id, principal.user_id, "invitation.redeem", "invitation", invite["id"], {"project_id": invite["project_id"]})
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return {"project_id": str(invite["project_id"]), "role": str(existing["role"] if existing else invite["project_role"]), "already_member": bool(existing)}

    def job_submission_policy(self, principal: Principal, project_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        with (nullcontext(connection) if connection is not None else self.connect()) as connection:
            member = connection.execute(
                "SELECT pm.*,p.monthly_compute_seconds_limit AS project_limit,p.max_active_jobs AS project_max,"
                "u.monthly_compute_seconds_limit AS account_limit,u.max_active_jobs AS account_max "
                "FROM project_memberships pm JOIN projects p ON p.id=pm.project_id JOIN users u ON u.id=pm.user_id "
                "WHERE pm.project_id=? AND pm.user_id=? AND p.organization_id=? AND p.deleted_at IS NULL AND u.status='active'",
                (project_id, principal.user_id, principal.organization_id),
            ).fetchone()
            if not member or PROJECT_ROLE_RANK.get(str(member["role"]), 0) < PROJECT_ROLE_RANK["editor"]:
                raise PermissionError("当前账户没有在该项目提交生成任务的权限")
            member_active = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE project_id=? AND created_by=? AND status IN ('queued','running')",
                (project_id, principal.user_id),
            ).fetchone()["count"]
            project_active = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE project_id=? AND status IN ('queued','running')",
                (project_id,),
            ).fetchone()["count"]
            account_active = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE organization_id=? AND created_by=? AND status IN ('queued','running')",
                (principal.organization_id, principal.user_id),
            ).fetchone()["count"]
            member_seconds = connection.execute(
                "SELECT COALESCE(SUM(MAX(0,(julianday(COALESCE(finished_at,CURRENT_TIMESTAMP))-julianday(started_at))*86400.0)),0) AS seconds "
                "FROM jobs WHERE project_id=? AND created_by=? AND started_at IS NOT NULL AND date(started_at,'+8 hours')>=date('now','+8 hours','start of month')",
                (project_id, principal.user_id),
            ).fetchone()["seconds"]
            project_seconds = connection.execute(
                "SELECT COALESCE(SUM(MAX(0,(julianday(COALESCE(finished_at,CURRENT_TIMESTAMP))-julianday(started_at))*86400.0)),0) AS seconds "
                "FROM jobs WHERE project_id=? AND started_at IS NOT NULL AND date(started_at,'+8 hours')>=date('now','+8 hours','start of month')",
                (project_id,),
            ).fetchone()["seconds"]
            account_seconds = connection.execute(
                "SELECT COALESCE(SUM(MAX(0,(julianday(COALESCE(finished_at,CURRENT_TIMESTAMP))-julianday(started_at))*86400.0)),0) AS seconds "
                "FROM jobs WHERE organization_id=? AND created_by=? AND started_at IS NOT NULL "
                "AND date(started_at,'+8 hours')>=date('now','+8 hours','start of month')",
                (principal.organization_id, principal.user_id),
            ).fetchone()["seconds"]
        if account_active >= int(member["account_max"] or 50):
            raise ValueError("你的全平台排队任务已达到管理员设置的上限")
        if member_active >= int(member["max_active_jobs"] or 50):
            raise ValueError("你在该项目的排队任务已达到负责人设置的上限")
        if project_active >= int(member["project_max"] or 50):
            raise ValueError("当前项目排队任务已达到上限")
        if member["monthly_compute_seconds_limit"] is not None and float(member_seconds) >= int(member["monthly_compute_seconds_limit"]):
            raise ValueError("你本月的项目计算额度已用完")
        if member["account_limit"] is not None and float(account_seconds) >= int(member["account_limit"]):
            raise ValueError("你的全平台月计算额度已用完")
        if member["project_limit"] is not None and float(project_seconds) >= int(member["project_limit"]):
            raise ValueError("当前项目本月计算额度已用完")
        queue_priority = max(1, min(5, int(member["queue_priority"] or 3)))
        return {
            "priority": {1: 260, 2: 190, 3: 120, 4: 75, 5: 40}[queue_priority],
            "queue_priority": queue_priority,
            "member_active_jobs": int(member_active),
            "project_active_jobs": int(project_active),
            "account_active_jobs": int(account_active),
            "month_compute_seconds": round(float(member_seconds or 0), 3),
            "account_month_compute_seconds": round(float(account_seconds or 0), 3),
        }

    def create_download_grant(self, principal: Principal, asset_id: str, *, minutes: int = 15) -> dict[str, Any]:
        token = secrets.token_urlsafe(48)
        grant_id = str(uuid.uuid4())
        now = utc_now()
        expires_at = _future(minutes=max(1, min(minutes, 24 * 60)))
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "INSERT INTO download_grants(id,token_hash,asset_id,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?)",
                (grant_id, _digest(token), asset_id, principal.user_id, expires_at, now),
            )
            self._write_audit(connection, principal.organization_id, principal.user_id, "download_grant.create", "asset", asset_id, {"expires_at": expires_at})
        return {"id": grant_id, "token": token, "expires_at": expires_at}

    def resolve_download_grant(self, token: str, *, ip_address: str = "") -> dict[str, Any] | None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            row = connection.execute(
                "SELECT g.*,a.project_id,a.source_path,a.name,a.media_type FROM download_grants g "
                "JOIN assets a ON a.id=g.asset_id WHERE g.token_hash=? AND g.revoked_at IS NULL "
                "AND g.expires_at>? AND g.use_count<g.max_uses",
                (_digest(token), now),
            ).fetchone()
            if not row:
                return None
            connection.execute("UPDATE download_grants SET use_count=use_count+1,last_used_at=? WHERE id=?", (now, row["id"]))
            project = connection.execute("SELECT organization_id FROM projects WHERE id=?", (row["project_id"],)).fetchone()
            self._write_audit(connection, project["organization_id"] if project else None, row["created_by"], "download.use", "asset", row["asset_id"], {}, ip_address)
        return dict(row)

    def create_upload_session(
        self,
        principal: Principal,
        *,
        project_id: str,
        original_name: str,
        media_type: str | None,
        folder_id: str | None,
        size_bytes: int,
        expected_sha256: str | None,
        chunk_size: int = 32 * 1024 * 1024,
    ) -> dict[str, Any]:
        upload_id = str(uuid.uuid4())
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            connection.execute(
                "INSERT INTO upload_sessions(id,organization_id,project_id,created_by,original_name,media_type,folder_id,size_bytes,chunk_size,expected_sha256,created_at,expires_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    upload_id,
                    principal.organization_id,
                    project_id,
                    principal.user_id,
                    original_name,
                    media_type,
                    folder_id,
                    size_bytes,
                    chunk_size,
                    expected_sha256.lower() if expected_sha256 else None,
                    now,
                    _future(hours=24),
                ),
            )
            self._write_audit(connection, principal.organization_id, principal.user_id, "upload.init", "upload", upload_id, {"project_id": project_id, "size_bytes": size_bytes})
        return self.get_upload_session(upload_id)  # type: ignore[return-value]

    def get_upload_session(self, upload_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM upload_sessions WHERE id=?", (upload_id,)).fetchone()
            if not row:
                return None
            chunks = connection.execute(
                "SELECT chunk_index,size_bytes,sha256 FROM upload_chunks WHERE upload_id=? ORDER BY chunk_index",
                (upload_id,),
            ).fetchall()
        item = dict(row)
        item["chunks"] = [dict(chunk) for chunk in chunks]
        return item

    def record_upload_chunk(self, principal: Principal, upload_id: str, chunk_index: int, size_bytes: int, sha256: str) -> dict[str, Any]:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            upload = connection.execute("SELECT * FROM upload_sessions WHERE id=?", (upload_id,)).fetchone()
            if not upload or upload["status"] != "open" or upload["expires_at"] <= now:
                raise ValueError("上传会话不存在或已过期")
            if upload["created_by"] != principal.user_id and self.project_role(principal, str(upload["project_id"])) != "owner":
                raise PermissionError("无权写入该上传任务")
            connection.execute(
                "INSERT INTO upload_chunks(upload_id,chunk_index,size_bytes,sha256,created_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(upload_id,chunk_index) DO UPDATE SET size_bytes=excluded.size_bytes,sha256=excluded.sha256,created_at=excluded.created_at",
                (upload_id, chunk_index, size_bytes, sha256, now),
            )
        return self.get_upload_session(upload_id)  # type: ignore[return-value]

    def mark_upload_completed(self, principal: Principal, upload_id: str, asset_id: str) -> None:
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            upload = connection.execute("SELECT * FROM upload_sessions WHERE id=?", (upload_id,)).fetchone()
            if not upload:
                raise ValueError("上传会话不存在")
            if upload["created_by"] != principal.user_id and self.project_role(principal, str(upload["project_id"])) != "owner":
                raise PermissionError("无权完成该上传任务")
            connection.execute("UPDATE upload_sessions SET status='completed',completed_at=? WHERE id=?", (now, upload_id))
            self._write_audit(connection, principal.organization_id, principal.user_id, "upload.complete", "asset", asset_id, {"upload_id": upload_id})

    @staticmethod
    def _require_platform_admin(principal: Principal) -> None:
        if not principal.is_admin:
            raise PermissionError("只有组织管理员可以管理平台账户")

    def list_admin_users(self, principal: Principal, *, days: int = 30) -> list[dict[str, Any]]:
        self._require_platform_admin(principal)
        period_offset = f"-{max(1, min(days, 365)) - 1} days"
        elapsed = "MAX(0,(julianday(COALESCE(finished_at,CURRENT_TIMESTAMP))-julianday(started_at))*86400.0)"
        with self.connect() as connection:
            users = connection.execute(
                "SELECT u.id,u.email,u.name,u.status,u.can_create_projects,u.avatar_color,u.avatar_image,"
                "u.monthly_compute_seconds_limit,u.max_active_jobs,u.created_at,u.updated_at,u.last_login_at,"
                "m.role AS organization_role FROM users u JOIN organization_memberships m ON m.user_id=u.id "
                "WHERE m.organization_id=? ORDER BY CASE u.status WHEN 'active' THEN 0 ELSE 1 END,u.name COLLATE NOCASE",
                (principal.organization_id,),
            ).fetchall()
            result: list[dict[str, Any]] = []
            for row in users:
                item = dict(row)
                item["can_create_projects"] = bool(item["can_create_projects"])
                item["is_current_user"] = item["id"] == principal.user_id
                memberships = connection.execute(
                    "SELECT p.id AS project_id,p.name AS project_name,p.project_kind,pm.role,"
                    "pm.monthly_compute_seconds_limit,pm.max_active_jobs,pm.queue_priority "
                    "FROM project_memberships pm JOIN projects p ON p.id=pm.project_id "
                    "WHERE pm.user_id=? AND p.organization_id=? AND p.deleted_at IS NULL ORDER BY p.name COLLATE NOCASE",
                    (item["id"], principal.organization_id),
                ).fetchall()
                item["projects"] = [dict(member) for member in memberships]
                usage = connection.execute(
                    f"SELECT COUNT(*) AS job_count,COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN {elapsed} ELSE 0 END),0) AS compute_seconds,"
                    "SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded_jobs,"
                    "SUM(CASE WHEN status IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed_jobs,"
                    "SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS queued_jobs "
                    "FROM jobs WHERE organization_id=? AND created_by=? AND date(created_at,'+8 hours')>=date('now','+8 hours',?)",
                    (principal.organization_id, item["id"], period_offset),
                ).fetchone()
                storage = connection.execute(
                    "SELECT COALESCE(SUM(size_bytes),0) AS storage_bytes FROM assets WHERE organization_id=? AND created_by=?",
                    (principal.organization_id, item["id"]),
                ).fetchone()
                sessions = connection.execute(
                    "SELECT id,ip_address,user_agent,created_at,expires_at,last_seen_at,revoked_at,"
                    "CASE WHEN revoked_at IS NULL AND expires_at>? THEN 1 ELSE 0 END AS active "
                    "FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 5",
                    (utc_now(), item["id"]),
                ).fetchall()
                active_session_count = connection.execute(
                    "SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>?",
                    (item["id"], utc_now()),
                ).fetchone()
                item["usage"] = {
                    "compute_seconds": round(float(usage["compute_seconds"] or 0), 3),
                    "job_count": int(usage["job_count"] or 0),
                    "succeeded_jobs": int(usage["succeeded_jobs"] or 0),
                    "failed_jobs": int(usage["failed_jobs"] or 0),
                    "queued_jobs": int(usage["queued_jobs"] or 0),
                    "storage_bytes": int(storage["storage_bytes"] or 0),
                }
                item["recent_sessions"] = [{**dict(session), "active": bool(session["active"])} for session in sessions]
                item["active_sessions"] = int(active_session_count["count"] or 0)
                result.append(item)
        return result

    def admin_overview(self, principal: Principal, *, days: int = 30) -> dict[str, Any]:
        users = self.list_admin_users(principal, days=days)
        period_offset = f"-{max(1, min(days, 365)) - 1} days"
        elapsed = "MAX(0,(julianday(COALESCE(finished_at,CURRENT_TIMESTAMP))-julianday(started_at))*86400.0)"
        with self.connect() as connection:
            projects = connection.execute(
                "SELECT COUNT(*) AS count FROM projects WHERE organization_id=? AND deleted_at IS NULL",
                (principal.organization_id,),
            ).fetchone()
            jobs = connection.execute(
                f"SELECT COUNT(*) AS job_count,COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN {elapsed} ELSE 0 END),0) AS compute_seconds,"
                "SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS queued_jobs "
                "FROM jobs WHERE organization_id=? AND date(created_at,'+8 hours')>=date('now','+8 hours',?)",
                (principal.organization_id, period_offset),
            ).fetchone()
            storage = connection.execute(
                "SELECT COALESCE(SUM(size_bytes),0) AS storage_bytes FROM assets WHERE organization_id=?",
                (principal.organization_id,),
            ).fetchone()
            daily = connection.execute(
                f"SELECT date(created_at,'+8 hours') AS day,COUNT(*) AS jobs,"
                f"COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN {elapsed} ELSE 0 END),0) AS compute_seconds "
                "FROM jobs WHERE organization_id=? AND date(created_at,'+8 hours')>=date('now','+8 hours',?) "
                "GROUP BY date(created_at,'+8 hours') ORDER BY day",
                (principal.organization_id, period_offset),
            ).fetchall()
            active_invitations = connection.execute(
                "SELECT COUNT(*) AS count FROM invitations WHERE organization_id=? AND revoked_at IS NULL AND expires_at>? AND use_count<max_uses",
                (principal.organization_id, utc_now()),
            ).fetchone()
        return {
            "period_days": max(1, min(days, 365)),
            "users": len(users),
            "active_users": sum(1 for user in users if user["status"] == "active"),
            "suspended_users": sum(1 for user in users if user["status"] != "active"),
            "active_sessions": sum(int(user["active_sessions"]) for user in users),
            "projects": int(projects["count"] or 0),
            "active_invitations": int(active_invitations["count"] or 0),
            "job_count": int(jobs["job_count"] or 0),
            "queued_jobs": int(jobs["queued_jobs"] or 0),
            "compute_seconds": round(float(jobs["compute_seconds"] or 0), 3),
            "storage_bytes": int(storage["storage_bytes"] or 0),
            "daily": [dict(row) for row in daily],
        }

    def update_admin_user(
        self,
        principal: Principal,
        user_id: str,
        *,
        status: str | None = None,
        organization_role: str | None = None,
        can_create_projects: bool | None = None,
        monthly_compute_seconds_limit: int | None | object = ...,
        max_active_jobs: int | None = None,
    ) -> dict[str, Any]:
        self._require_platform_admin(principal)
        if status is not None and status not in {"active", "suspended"}:
            raise ValueError("无效的账户状态")
        if organization_role is not None and organization_role not in {"member", "admin", "owner"}:
            raise ValueError("无效的平台角色")
        if monthly_compute_seconds_limit is not ... and monthly_compute_seconds_limit is not None and int(monthly_compute_seconds_limit) < 0:
            raise ValueError("账户月额度不能为负数")
        if max_active_jobs is not None and not 1 <= int(max_active_jobs) <= 500:
            raise ValueError("账户排队任务上限应在1到500之间")
        if user_id == DEFAULT_OWNER_ID and (status == "suspended" or organization_role not in {None, "owner"}):
            raise ValueError("本机平台主管必须保持启用和负责人角色")
        if user_id == principal.user_id and (status == "suspended" or organization_role not in {None, "admin", "owner"}):
            raise ValueError("不能暂停当前账户或移除自己的管理权限")
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            current = connection.execute(
                "SELECT u.status,m.role FROM users u JOIN organization_memberships m ON m.user_id=u.id "
                "WHERE u.id=? AND m.organization_id=?",
                (user_id, principal.organization_id),
            ).fetchone()
            if not current:
                raise ValueError("账户不存在")
            removing_owner = current["role"] == "owner" and (status == "suspended" or organization_role not in {None, "owner"})
            if removing_owner:
                remaining = connection.execute(
                    "SELECT COUNT(*) AS count FROM organization_memberships m JOIN users u ON u.id=m.user_id "
                    "WHERE m.organization_id=? AND m.role='owner' AND u.status='active' AND u.id<>?",
                    (principal.organization_id, user_id),
                ).fetchone()["count"]
                if remaining < 1:
                    raise ValueError("平台必须保留至少一名启用的负责人")
            user_assignments: list[str] = []
            values: list[Any] = []
            if status is not None:
                user_assignments.append("status=?")
                values.append(status)
            if can_create_projects is not None:
                user_assignments.append("can_create_projects=?")
                values.append(int(can_create_projects))
            if monthly_compute_seconds_limit is not ...:
                user_assignments.append("monthly_compute_seconds_limit=?")
                values.append(monthly_compute_seconds_limit)
            if max_active_jobs is not None:
                user_assignments.append("max_active_jobs=?")
                values.append(int(max_active_jobs))
            if user_assignments:
                user_assignments.append("updated_at=?")
                values.extend([now, user_id])
                connection.execute(f"UPDATE users SET {','.join(user_assignments)} WHERE id=?", values)
            if organization_role is not None:
                connection.execute(
                    "UPDATE organization_memberships SET role=? WHERE organization_id=? AND user_id=?",
                    (organization_role, principal.organization_id, user_id),
                )
            if status == "suspended":
                connection.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now, user_id))
                connection.execute("UPDATE upload_sessions SET status='revoked' WHERE created_by=? AND status='open'", (user_id,))
                connection.execute("UPDATE download_grants SET revoked_at=? WHERE created_by=? AND revoked_at IS NULL", (now, user_id))
            self._write_audit(
                connection,
                principal.organization_id,
                principal.user_id,
                "admin.user_update",
                "user",
                user_id,
                {
                    "status": status,
                    "organization_role": organization_role,
                    "can_create_projects": can_create_projects,
                    "monthly_compute_seconds_limit": None if monthly_compute_seconds_limit is ... else monthly_compute_seconds_limit,
                    "max_active_jobs": max_active_jobs,
                },
            )
        return next(user for user in self.list_admin_users(principal) if user["id"] == user_id)

    def revoke_admin_user_sessions(self, principal: Principal, user_id: str) -> int:
        self._require_platform_admin(principal)
        now = utc_now()
        with self._write_lock, self.connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM organization_memberships WHERE organization_id=? AND user_id=?",
                (principal.organization_id, user_id),
            ).fetchone()
            if not exists:
                raise ValueError("账户不存在")
            if user_id == principal.user_id and principal.session_id:
                cursor = connection.execute(
                    "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?",
                    (now, user_id, principal.session_id),
                )
            else:
                cursor = connection.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now, user_id))
            self._write_audit(connection, principal.organization_id, principal.user_id, "admin.sessions_revoke", "user", user_id, {"count": cursor.rowcount})
        return int(cursor.rowcount)

    def list_admin_access_events(self, principal: Principal, *, limit: int = 200) -> list[dict[str, Any]]:
        self._require_platform_admin(principal)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT a.id,a.user_id,a.action,a.target_type,a.target_id,a.detail_json,a.ip_address,a.created_at,"
                "u.name AS user_name,u.email AS user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id "
                "WHERE a.organization_id=? AND (a.action LIKE 'auth.%' OR a.action LIKE 'admin.%') "
                "ORDER BY a.id DESC LIMIT ?",
                (principal.organization_id, max(1, min(limit, 1000))),
            ).fetchall()
        events: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["detail"] = json.loads(item.pop("detail_json") or "{}")
            events.append(item)
        return events

    @staticmethod
    def _write_audit(
        connection: sqlite3.Connection,
        organization_id: str | None,
        user_id: str | None,
        action: str,
        target_type: str | None,
        target_id: str | None,
        detail: dict[str, Any],
        ip_address: str = "",
    ) -> None:
        connection.execute(
            "INSERT INTO audit_logs(organization_id,user_id,action,target_type,target_id,detail_json,ip_address,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (organization_id, user_id, action, target_type, target_id, json.dumps(detail, ensure_ascii=False), ip_address[:120], utc_now()),
        )

    def audit(
        self,
        organization_id: str | None,
        user_id: str | None,
        action: str,
        target_type: str | None = None,
        target_id: str | None = None,
        detail: dict[str, Any] | None = None,
        ip_address: str = "",
    ) -> None:
        with self._write_lock, self.connect() as connection:
            self._write_audit(connection, organization_id, user_id, action, target_type, target_id, detail or {}, ip_address)

    def list_audit(self, principal: Principal, *, limit: int = 200) -> list[dict[str, Any]]:
        if not principal.is_admin:
            raise PermissionError("只有组织管理员可以查看审计记录")
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT a.*,u.name AS user_name,u.email AS user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id "
                "WHERE a.organization_id=? ORDER BY a.id DESC LIMIT ?",
                (principal.organization_id, max(1, min(limit, 1000))),
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["detail"] = json.loads(item.pop("detail_json") or "{}")
            result.append(item)
        return result
