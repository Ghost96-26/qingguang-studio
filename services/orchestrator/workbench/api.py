from __future__ import annotations

import secrets
import hashlib
import hmac
import ipaddress
import mimetypes
import shutil
import json
import sqlite3
import uuid
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .auth import AuthStore, Principal
from .config import Settings
from .media_tools import inspect_media
from .providers import ProviderRegistry
from .store import JobStore
from .worker import JobWorker
from .video_options import video_options
from .production import ProductionService


settings = Settings.load()
store = JobStore(
    settings.path("database"),
    Path(settings.raw.get("tenant_root", settings.path("artifact_root").parent / "tenants")),
)
auth_store = AuthStore(settings.path("database"))
providers = ProviderRegistry(settings)
worker = JobWorker(store, providers, float(settings.raw["worker_poll_seconds"]))
production = ProductionService(store, auth_store)
worker.maintenance = production.tick


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.initialize()
    auth_store.initialize()
    production.initialize()
    settings.path("artifact_root").mkdir(parents=True, exist_ok=True)
    worker.start()
    try:
        yield
    finally:
        worker.stop()


app = FastAPI(
    title="擎光绘影·AIGC数字影像创作平台(CLSF AI. Lab Studio)",
    version=__version__,
    description="Local-only orchestration gateway for H3, image generation/editing, TTS, Music3 and the production agent.",
    lifespan=lifespan,
)


class JobCreate(BaseModel):
    type: str
    params: dict[str, Any] = Field(default_factory=dict)
    priority: int = Field(default=100, ge=0, le=1000)
    project_id: str = "default"


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    group_id: str | None = None
    avatar_color: str | None = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    avatar_image: str | None = Field(default=None, max_length=400_000)
    monthly_compute_minutes_limit: int | None = Field(default=None, ge=0, le=1_000_000)
    max_active_jobs: int | None = Field(default=None, ge=1, le=500)


class ProjectGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class ProjectGroupUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class AssetFolderCreate(BaseModel):
    project_id: str = "default"
    name: str = Field(min_length=1, max_length=80)
    parent_id: str | None = None
    category: str = Field(default="custom", pattern="^(scene|character|prop|unfiled|custom)$")


class AssetFolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    parent_id: str | None = None


class AssetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=180)
    folder_id: str | None = None


class CanvasUpdate(BaseModel):
    state: dict[str, Any]


class ApprovalUpdate(BaseModel):
    status: str
    note: str | None = Field(default=None, max_length=1000)


class FinalBatchCreate(BaseModel):
    preview_job_ids: list[str] = Field(min_length=1, max_length=100)
    mode: str = Field(default="reproduce", pattern="^(reproduce|quality)$")
    steps: int = Field(default=20, ge=8, le=60)
    priority: int = Field(default=200, ge=0, le=1000)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=512)


class RegisterRequest(BaseModel):
    invitation_code: str = Field(min_length=20, max_length=256)
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=512)


class PasswordRequest(BaseModel):
    password: str = Field(min_length=10, max_length=512)


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    avatar_color: str | None = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    avatar_image: str | None = Field(default=None, max_length=400_000)


class InvitationAccept(BaseModel):
    code: str = Field(min_length=20, max_length=256)


class ProjectMemberUpdate(BaseModel):
    role: str | None = Field(default=None, pattern="^(viewer|reviewer|editor|owner)$")
    monthly_compute_minutes_limit: int | None = Field(default=None, ge=0, le=1_000_000)
    max_active_jobs: int | None = Field(default=None, ge=1, le=500)
    queue_priority: int | None = Field(default=None, ge=1, le=5)


class InvitationCreate(BaseModel):
    email: str | None = Field(default=None, max_length=254)
    project_id: str | None = None
    project_role: str = Field(default="viewer", pattern="^(viewer|reviewer|editor|owner)$")
    can_create_projects: bool = False
    expires_hours: int = Field(default=168, ge=1, le=2160)
    max_uses: int = Field(default=1, ge=1, le=100)


class DownloadTicketCreate(BaseModel):
    minutes: int = Field(default=15, ge=1, le=1440)


class UploadInitRequest(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=180)
    size_bytes: int = Field(ge=1, le=20_000_000_000)
    media_type: str | None = Field(default=None, max_length=200)
    folder_id: str | None = None
    sha256: str | None = Field(default=None, pattern="^[a-fA-F0-9]{64}$")


class UploadCompleteRequest(BaseModel):
    sha256: str | None = Field(default=None, pattern="^[a-fA-F0-9]{64}$")


SESSION_COOKIE = "clsf_session"


def _request_ip(request: Request) -> str:
    forwarded = request.headers.get("cf-connecting-ip", "").strip()
    return forwarded or (request.client.host if request.client else "")


def _is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in {"localhost", "testclient"}


def require_principal(
    request: Request,
    authorization: str | None = Header(default=None),
    x_workbench_key: str | None = Header(default=None),
    x_csrf_token: str | None = Header(default=None),
) -> Principal:
    session_token = request.cookies.get(SESSION_COOKIE, "")
    principal = auth_store.principal_from_token(session_token) if session_token else None
    if principal:
        if request.method not in {"GET", "HEAD", "OPTIONS"} and not principal.csrf_token:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="会话缺少安全校验，请重新登录")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and not secrets.compare_digest(x_csrf_token or "", principal.csrf_token or ""):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="安全校验已失效，请刷新页面后重试")
        return principal
    supplied = x_workbench_key
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if supplied and _is_loopback(request) and secrets.compare_digest(supplied, settings.api_key):
        return auth_store.local_owner_principal()
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请登录工作台")


def _set_session_cookie(response: JSONResponse, payload: dict[str, Any], *, secure: bool) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        payload.pop("session_token"),
        max_age=7 * 24 * 60 * 60,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )


def _project_guard(principal: Principal, project_id: str, minimum_role: str = "viewer") -> None:
    if not auth_store.can_project(principal, project_id, minimum_role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权访问该项目")


def _asset_guard(principal: Principal, asset_id: str, minimum_role: str = "viewer") -> dict[str, Any]:
    asset = store.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    _project_guard(principal, str(asset["project_id"]), minimum_role)
    return asset


def _job_guard(principal: Principal, job_id: str, minimum_role: str = "viewer") -> dict[str, Any]:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    _project_guard(principal, str(job["project_id"]), minimum_role)
    return job


def _ensure_personal_project(principal: Principal) -> dict[str, Any]:
    existing = next(
        (
            project
            for project in store.list_projects(include_deleted=True)
            if project.get("owner_user_id") == principal.user_id
            and project.get("project_kind") == "personal"
            and not project.get("deleted_at")
        ),
        None,
    )
    if existing:
        if not auth_store.can_project(principal, str(existing["id"]), "owner"):
            auth_store.add_project_owner(str(existing["id"]), principal)
        return existing
    project = store.create_project(
        f"{principal.name}的创作空间",
        organization_id=principal.organization_id,
        owner_user_id=principal.user_id,
        project_kind="personal",
        avatar_color=principal.avatar_color,
    )
    auth_store.add_project_owner(str(project["id"]), principal)
    store.project_storage_root(str(project["id"])).joinpath("inputs").mkdir(parents=True, exist_ok=True)
    store.project_storage_root(str(project["id"])).joinpath("outputs").mkdir(parents=True, exist_ok=True)
    return project


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "listen": settings.raw["listen"],
        "lan_exposed": settings.raw["listen"] not in {"127.0.0.1", "localhost", "::1"},
        "queue": store.counts(),
        "current_job": store.current(),
    }


@app.get("/v1/auth/status")
def auth_status(request: Request) -> dict[str, Any]:
    return {
        "mode": "invite_only",
        "local_auto_login": _is_loopback(request),
        "registration_enabled": True,
    }


@app.get("/v1/auth/invitations/preview")
def invitation_preview(code: str = Query(min_length=20, max_length=256)) -> dict[str, Any]:
    try:
        return auth_store.invitation_preview(code)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/v1/auth/register")
def register(body: RegisterRequest, request: Request) -> JSONResponse:
    try:
        payload = auth_store.register_with_invitation(
            code=body.invitation_code,
            email=body.email,
            name=body.name,
            password=body.password,
            user_agent=request.headers.get("user-agent", ""),
            ip_address=_request_ip(request),
        )
    except (ValueError, sqlite3.IntegrityError) as exc:
        detail = "该邮箱已经注册" if isinstance(exc, sqlite3.IntegrityError) else str(exc)
        raise HTTPException(status_code=422, detail=detail) from exc
    principal = auth_store.principal_from_token(str(payload["session_token"]))
    if principal:
        _ensure_personal_project(principal)
    response = JSONResponse({key: value for key, value in payload.items() if key != "session_token"})
    _set_session_cookie(response, payload, secure=request.headers.get("x-forwarded-proto") == "https")
    return response


@app.post("/v1/auth/login")
def login(body: LoginRequest, request: Request) -> JSONResponse:
    try:
        payload = auth_store.authenticate(
            body.email,
            body.password,
            user_agent=request.headers.get("user-agent", ""),
            ip_address=_request_ip(request),
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    principal = auth_store.principal_from_token(str(payload["session_token"]))
    if principal and principal.user_id != "local-owner":
        _ensure_personal_project(principal)
    response = JSONResponse({key: value for key, value in payload.items() if key != "session_token"})
    _set_session_cookie(response, payload, secure=request.headers.get("x-forwarded-proto") == "https")
    return response


@app.get("/v1/auth/me")
def auth_me(principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    return {"user": principal.public(), "csrf_token": principal.csrf_token}


@app.post("/v1/auth/logout")
def logout(principal: Principal = Depends(require_principal)) -> JSONResponse:
    auth_store.revoke_session(principal)
    response = JSONResponse({"status": "signed_out"})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@app.post("/v1/auth/password")
def set_password(body: PasswordRequest, principal: Principal = Depends(require_principal)) -> dict[str, str]:
    try:
        auth_store.set_password(principal, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "updated"}


@app.patch("/v1/auth/profile")
def update_profile(body: ProfileUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    try:
        return {"user": auth_store.update_profile(principal, name=body.name, avatar_color=body.avatar_color, avatar_image=body.avatar_image)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/auth/invitations/accept")
def accept_invitation(body: InvitationAccept, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    try:
        return auth_store.redeem_invitation(principal, body.code)
    except (ValueError, PermissionError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/v1/admin/invitations")
def list_invitations(
    project_id: str | None = Query(default=None),
    principal: Principal = Depends(require_principal),
) -> list[dict[str, Any]]:
    try:
        return auth_store.list_invitations(principal, project_id=project_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/v1/admin/invitations", status_code=status.HTTP_201_CREATED)
def create_invitation(body: InvitationCreate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    try:
        return auth_store.create_invitation(
            principal,
            email=body.email,
            project_id=body.project_id,
            project_role=body.project_role,
            can_create_projects=body.can_create_projects,
            expires_hours=body.expires_hours,
            max_uses=body.max_uses,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/v1/admin/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invitation(invitation_id: str, principal: Principal = Depends(require_principal)) -> None:
    try:
        if not auth_store.revoke_invitation(principal, invitation_id):
            raise HTTPException(status_code=404, detail="邀请不存在或已经撤销")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.get("/v1/projects/{project_id}/members")
def list_project_members(project_id: str, principal: Principal = Depends(require_principal)) -> list[dict[str, Any]]:
    try:
        return auth_store.list_project_members(principal, project_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.patch("/v1/projects/{project_id}/members/{user_id}")
def update_project_member(
    project_id: str,
    user_id: str,
    body: ProjectMemberUpdate,
    principal: Principal = Depends(require_principal),
) -> dict[str, Any]:
    try:
        quota: int | None | object = ...
        if "monthly_compute_minutes_limit" in body.model_fields_set:
            quota = None if body.monthly_compute_minutes_limit is None else body.monthly_compute_minutes_limit * 60
        return auth_store.update_project_member(
            principal,
            project_id,
            user_id,
            role=body.role,
            monthly_compute_seconds_limit=quota,
            max_active_jobs=body.max_active_jobs,
            queue_priority=body.queue_priority,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/v1/projects/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_member(project_id: str, user_id: str, principal: Principal = Depends(require_principal)) -> None:
    try:
        if not auth_store.remove_project_member(principal, project_id, user_id):
            raise HTTPException(status_code=404, detail="项目成员不存在")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/v1/admin/audit")
def list_audit(
    limit: int = Query(default=200, ge=1, le=1000),
    principal: Principal = Depends(require_principal),
) -> list[dict[str, Any]]:
    try:
        return auth_store.list_audit(principal, limit=limit)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.get("/v1/capabilities")
def capabilities(_: Principal = Depends(require_principal)) -> dict[str, Any]:
    return providers.capabilities()


@app.post("/v1/runtime/comfy/start")
def start_comfy_runtime(_: Principal = Depends(require_principal)) -> dict[str, Any]:
    try:
        next_capabilities = providers.ensure_comfy_runtime()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "ready", "capabilities": next_capabilities}


@app.post("/v1/jobs", status_code=status.HTTP_202_ACCEPTED)
def create_job(body: JobCreate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, body.project_id, "editor")
    if body.type in {"agent.storyboard", "video.assemble"}:
        raise HTTPException(status_code=422, detail="请使用经过素材权限校验的分镜制作入口")
    if body.type not in providers.SUPPORTED_TYPES:
        raise HTTPException(status_code=422, detail=f"Unsupported job type: {body.type}")
    try:
        if body.type == "h3.t2v" and body.params.get("h3_ir_enabled") is True:
            video_options(str(body.params.get("mode", "t2v")), body.params)
        if body.type == "agent.h3_ir":
            video = body.params.get("video_params")
            if not isinstance(video, dict) or video.get("h3_ir_enabled") is not True:
                raise ValueError("请先启用H3-IR导演台")
            video_options(str(video.get("mode", "t2v")), video)
        project = store.get_project(body.project_id)
        if not project:
            raise ValueError("项目不存在")
        job = store.create(
            body.type,
            body.params,
            body.priority,
            project_id=body.project_id,
            organization_id=str(project.get("organization_id") or principal.organization_id),
            created_by=principal.user_id,
            admission_check=lambda connection: auth_store.job_submission_policy(principal, body.project_id, connection=connection),
        )
        auth_store.audit(principal.organization_id, principal.user_id, "job.create", "job", job["id"], {"type": body.type, "project_id": body.project_id})
        return job
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class H3CompileRequest(BaseModel):
    params: dict[str, Any]


class StoryboardRequest(BaseModel):
    project_id: str
    brief: str = Field(min_length=1, max_length=12000)
    model_id: str = Field(min_length=1, max_length=100)
    duration_seconds: int = Field(default=30, ge=4, le=60)
    steps: int = Field(default=30)
    reference_asset_ids: list[str] = Field(default_factory=list, max_length=9)
    reference_descriptions: dict[str, str] = Field(default_factory=dict)


class ProductionRequest(BaseModel):
    include_score: bool = False
    confirmed: bool = False


@app.post("/v1/agent/storyboards", status_code=202)
def plan_storyboard(body: StoryboardRequest, principal: Principal = Depends(require_principal)):
    if not body.brief.strip():
        raise HTTPException(422, "请填写创作目标")
    _project_guard(principal, body.project_id, "editor")
    if body.steps not in (20, 30, 40) or len(set(body.reference_asset_ids)) != len(body.reference_asset_ids):
        raise HTTPException(422, "请选择 20/30/40 步，并移除重复参考")
    references = []
    for asset_id in body.reference_asset_ids:
        asset = _asset_guard(principal, asset_id)
        if asset["project_id"] != body.project_id or asset["kind"] != "image":
            raise HTTPException(422, "分镜规划目前只支持当前项目的图片参考")
        description = body.reference_descriptions.get(asset_id, "")
        if len(description) > 2000:
            raise HTTPException(422, "单项素材描述不能超过 2000 字符")
        references.append({"id": asset_id, "name": asset["name"], "description": description})
    params = {"brief": body.brief.strip(), "prompt": body.brief.strip(), "model_id": body.model_id,
              "duration_seconds": body.duration_seconds, "steps": body.steps, "references": references, "require_continuity": True}
    try:
        project = store.get_project(body.project_id)
        return store.create("agent.storyboard", params, 120, project_id=body.project_id,
                            organization_id=project["organization_id"], created_by=principal.user_id,
                            admission_check=lambda connection: auth_store.job_submission_policy(principal, body.project_id, connection=connection))
    except (ValueError, PermissionError) as exc:
        raise HTTPException(422 if isinstance(exc, ValueError) else 403, str(exc)) from exc


@app.post("/v1/agent/storyboards/{job_id}/execute", status_code=202)
def execute_storyboard(job_id: str, body: ProductionRequest, principal: Principal = Depends(require_principal)):
    job = _job_guard(principal, job_id, "editor")
    if not body.confirmed:
        raise HTTPException(422, "请先审核分镜并确认本次生成范围")
    try:
        run = production.create(job, principal, body.include_score)
        auth_store.audit(principal.organization_id, principal.user_id, "production.create", "production", run["id"], {"plan_job_id": job_id})
        return run
    except (ValueError, PermissionError) as exc:
        raise HTTPException(422 if isinstance(exc, ValueError) else 403, str(exc)) from exc


@app.get("/v1/projects/{project_id}/productions")
def list_productions(project_id: str, principal: Principal = Depends(require_principal)):
    _project_guard(principal, project_id, "viewer")
    return production.list(project_id)


@app.post("/v1/productions/{run_id}/{action}")
def control_production(run_id: str, action: str, principal: Principal = Depends(require_principal)):
    run = production.get(run_id)
    if not run:
        raise HTTPException(404, "制作任务不存在")
    _project_guard(principal, run["project_id"], "editor")
    try:
        if action == "cancel": return production.cancel(run_id)
        if action == "resume":
            auth_store.job_submission_policy(principal, run["project_id"])
            return production.resume(run_id)
        raise HTTPException(404, "不支持的操作")
    except (ValueError, PermissionError) as exc:
        raise HTTPException(422 if isinstance(exc, ValueError) else 403, str(exc)) from exc


@app.post("/v1/h3/compile")
def compile_h3_prompt(body: H3CompileRequest, _: Principal = Depends(require_principal)) -> dict[str, Any]:
    """Same compiler as the actual provider; validation only, no GPU work."""
    try:
        return video_options(str(body.params.get("mode", "t2v")), body.params)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/v1/jobs")
def list_jobs(
    limit: int = Query(default=100, ge=1, le=500),
    job_status: str | None = Query(default=None, alias="status"),
    project_id: str | None = Query(default=None),
    principal: Principal = Depends(require_principal),
) -> list[dict[str, Any]]:
    if project_id:
        _project_guard(principal, project_id, "viewer")
        return store.list(limit=limit, status=job_status, project_id=project_id)
    allowed = auth_store.list_projects_for(principal)
    jobs = store.list(limit=limit, status=job_status, project_id=None)
    return [job for job in jobs if job.get("project_id") in allowed]


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    return _job_guard(principal, job_id)


@app.get("/v1/jobs/{job_id}/events")
def get_job_events(job_id: str, principal: Principal = Depends(require_principal)) -> list[dict[str, Any]]:
    _job_guard(principal, job_id)
    return store.events(job_id)


@app.post("/v1/jobs/{job_id}/cancel")
def cancel_job(job_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _job_guard(principal, job_id, "editor")
    job = store.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/v1/local-auth", include_in_schema=False)
def local_auth(request: Request) -> JSONResponse:
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="Automatic sign-in is available only on the host computer")
    payload = auth_store.local_owner_session(user_agent=request.headers.get("user-agent", ""), ip_address=_request_ip(request))
    response = JSONResponse({key: value for key, value in payload.items() if key != "session_token"})
    _set_session_cookie(response, payload, secure=False)
    return response


@app.get("/v1/projects")
def list_projects(
    include_deleted: bool = Query(default=False),
    principal: Principal = Depends(require_principal),
) -> list[dict[str, Any]]:
    projects = store.list_projects(include_deleted=include_deleted)
    allowed = auth_store.list_projects_for(principal, include_deleted=include_deleted)
    visible: list[dict[str, Any]] = []
    for project in projects:
        if project.get("organization_id") != principal.organization_id:
            continue
        if project["id"] not in allowed:
            continue
        role = auth_store.project_role(principal, str(project["id"]))
        visible.append({
            **project,
            "current_user_role": role,
            "scope": "owned" if role == "owner" else "shared",
            "storage_root": str(store.project_storage_root(str(project["id"]))),
        })
    return visible


@app.post("/v1/projects", status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    if not (principal.is_admin or principal.can_create_projects):
        raise HTTPException(status_code=403, detail="当前账户没有创建项目的权限")
    project = store.create_project(body.name, organization_id=principal.organization_id, owner_user_id=principal.user_id, project_kind="standard", avatar_color=principal.avatar_color)
    auth_store.add_project_owner(project["id"], principal)
    storage_root = store.project_storage_root(project["id"])
    storage_root.joinpath("inputs").mkdir(parents=True, exist_ok=True)
    storage_root.joinpath("outputs").mkdir(parents=True, exist_ok=True)
    return {
        **project,
        "current_user_role": "owner",
        "scope": "owned",
        "storage_root": str(storage_root),
    }


@app.patch("/v1/projects/{project_id}")
def update_project(project_id: str, body: ProjectUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, project_id, "owner")
    if "group_id" in body.model_fields_set and body.group_id is not None:
        owned_groups = {str(group["id"]) for group in store.list_project_groups(principal.user_id)}
        if body.group_id not in owned_groups:
            raise HTTPException(status_code=422, detail="项目分组不属于当前账户")
    try:
        update_args: dict[str, Any] = {"name": body.name}
        if "group_id" in body.model_fields_set:
            update_args["group_id"] = body.group_id
        if "avatar_color" in body.model_fields_set:
            update_args["avatar_color"] = body.avatar_color
        if "avatar_image" in body.model_fields_set:
            update_args["avatar_image"] = body.avatar_image
        if "monthly_compute_minutes_limit" in body.model_fields_set:
            update_args["monthly_compute_seconds_limit"] = None if body.monthly_compute_minutes_limit is None else body.monthly_compute_minutes_limit * 60
        if "max_active_jobs" in body.model_fields_set:
            update_args["max_active_jobs"] = body.max_active_jobs
        project = store.update_project(project_id, **update_args)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@app.get("/v1/account/usage")
def account_usage(principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    project_ids = sorted(auth_store.list_projects_for(principal))
    usage = store.usage_summary(project_ids, user_id=principal.user_id, days=30)
    return {**usage, "unit": "compute_seconds", "period": "rolling_30_days"}


@app.get("/v1/projects/{project_id}/usage")
def project_usage(project_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, project_id, "viewer")
    project = store.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    team = store.usage_summary([project_id], days=30)
    mine = store.usage_summary([project_id], user_id=principal.user_id, days=30)
    members = auth_store.list_project_members(principal, project_id)
    me = next((item for item in members if item["id"] == principal.user_id), {})
    return {
        "unit": "compute_seconds",
        "period": "rolling_30_days",
        "project": team,
        "mine": mine,
        "limits": {
            "project_monthly_compute_seconds": project.get("monthly_compute_seconds_limit"),
            "project_max_active_jobs": project.get("max_active_jobs"),
            "member_monthly_compute_seconds": me.get("monthly_compute_seconds_limit"),
            "member_max_active_jobs": me.get("max_active_jobs"),
        },
    }


@app.delete("/v1/projects/{project_id}")
def trash_project(project_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, project_id, "owner")
    try:
        project = store.trash_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@app.post("/v1/projects/{project_id}/restore")
def restore_project(project_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, project_id, "owner")
    project = store.restore_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Deleted project not found")
    return project


@app.get("/v1/project-groups")
def list_project_groups(principal: Principal = Depends(require_principal)) -> list[dict[str, Any]]:
    return store.list_project_groups(principal.user_id)


@app.post("/v1/project-groups", status_code=status.HTTP_201_CREATED)
def create_project_group(body: ProjectGroupCreate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    if not (principal.is_admin or principal.can_create_projects):
        raise HTTPException(status_code=403, detail="当前账户没有创建项目分组的权限")
    try:
        return store.create_project_group(body.name, principal.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.patch("/v1/project-groups/{group_id}")
def rename_project_group(group_id: str, body: ProjectGroupUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    if not (principal.is_admin or principal.can_create_projects):
        raise HTTPException(status_code=403, detail="当前账户没有修改项目分组的权限")
    try:
        group = store.rename_project_group(group_id, body.name, principal.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not group:
        raise HTTPException(status_code=404, detail="Project group not found")
    return group


@app.delete("/v1/project-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_group(group_id: str, principal: Principal = Depends(require_principal)) -> None:
    if not (principal.is_admin or principal.can_create_projects):
        raise HTTPException(status_code=403, detail="当前账户没有删除项目分组的权限")
    if not store.delete_project_group(group_id, principal.user_id):
        raise HTTPException(status_code=404, detail="Project group not found")


@app.get("/v1/projects/{project_id}/canvas")
def get_canvas(project_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, project_id, "viewer")
    if not store.get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    return store.get_canvas(project_id)


@app.put("/v1/projects/{project_id}/canvas")
def save_canvas(project_id: str, body: CanvasUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, project_id, "editor")
    try:
        return store.save_canvas(project_id, body.state)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/v1/assets")
def list_assets(
    project_id: str = Query(default="default"),
    limit: int = Query(default=200, ge=1, le=500),
    principal: Principal = Depends(require_principal),
) -> list[dict[str, Any]]:
    _project_guard(principal, project_id, "viewer")
    return store.list_assets(project_id, limit)


@app.patch("/v1/assets/{asset_id}")
def update_asset(asset_id: str, body: AssetUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _asset_guard(principal, asset_id, "editor")
    try:
        update_args: dict[str, Any] = {"name": body.name}
        if "folder_id" in body.model_fields_set:
            update_args["folder_id"] = body.folder_id
        asset = store.update_asset(asset_id, **update_args)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@app.get("/v1/asset-folders")
def list_asset_folders(
    project_id: str = Query(default="default"),
    principal: Principal = Depends(require_principal),
) -> list[dict[str, Any]]:
    _project_guard(principal, project_id, "viewer")
    try:
        return store.list_asset_folders(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/v1/asset-folders", status_code=status.HTTP_201_CREATED)
def create_asset_folder(body: AssetFolderCreate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, body.project_id, "editor")
    try:
        return store.create_asset_folder(body.project_id, body.name, parent_id=body.parent_id, category=body.category)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.patch("/v1/asset-folders/{folder_id}")
def update_asset_folder(folder_id: str, body: AssetFolderUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    current_folder = store.get_asset_folder(folder_id)
    if not current_folder:
        raise HTTPException(status_code=404, detail="Asset folder not found")
    _project_guard(principal, str(current_folder["project_id"]), "editor")
    try:
        update_args: dict[str, Any] = {"name": body.name}
        if "parent_id" in body.model_fields_set:
            update_args["parent_id"] = body.parent_id
        folder = store.update_asset_folder(folder_id, **update_args)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not folder:
        raise HTTPException(status_code=404, detail="Asset folder not found")
    return folder


@app.delete("/v1/asset-folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset_folder(folder_id: str, principal: Principal = Depends(require_principal)) -> None:
    current_folder = store.get_asset_folder(folder_id)
    if not current_folder:
        raise HTTPException(status_code=404, detail="Asset folder not found")
    _project_guard(principal, str(current_folder["project_id"]), "editor")
    try:
        deleted = store.delete_asset_folder(folder_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Asset folder not found")


@app.get("/v1/assets/{asset_id}/content")
def get_asset_content(asset_id: str, principal: Principal = Depends(require_principal)) -> FileResponse:
    asset = _asset_guard(principal, asset_id, "viewer")
    path = Path(asset["source_path"])
    if not path.is_file():
        raise HTTPException(status_code=410, detail="Asset file no longer exists on disk")
    return FileResponse(path, media_type=asset.get("media_type"), filename=asset["name"], content_disposition_type="inline")


def media_signature(asset_id: str, expires: int) -> str:
    payload = f"{asset_id}:{expires}".encode("utf-8")
    return hmac.new(settings.api_key.encode("utf-8"), payload, hashlib.sha256).hexdigest()


@app.get("/v1/assets/{asset_id}/playback")
def get_asset_playback(asset_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _asset_guard(principal, asset_id, "viewer")
    expires = int(time.time()) + 2 * 60 * 60
    signature = media_signature(asset_id, expires)
    return {"url": f"/media/{asset_id}?expires={expires}&signature={signature}", "expires": expires}


@app.get("/media/{asset_id}", include_in_schema=False)
def stream_asset(asset_id: str, expires: int, signature: str, principal: Principal = Depends(require_principal)) -> FileResponse:
    if expires < int(time.time()) or not secrets.compare_digest(signature, media_signature(asset_id, expires)):
        raise HTTPException(status_code=403, detail="Media link is invalid or expired")
    asset = _asset_guard(principal, asset_id, "viewer")
    path = Path(asset["source_path"])
    if not path.is_file():
        raise HTTPException(status_code=410, detail="Asset file no longer exists on disk")
    return FileResponse(path, media_type=asset.get("media_type"), filename=asset["name"], content_disposition_type="inline")


@app.post("/v1/assets/upload", status_code=status.HTTP_201_CREATED)
def upload_asset(
    project_id: str = Form(default="default"),
    kind: str = Form(default="reference"),
    folder_id: str | None = Form(default=None),
    file: UploadFile = File(...),
    principal: Principal = Depends(require_principal),
) -> dict[str, Any]:
    _project_guard(principal, project_id, "editor")
    if not store.get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    original_name = Path(file.filename or "asset.bin").name
    suffix = Path(original_name).suffix[:16]
    upload_root = store.project_storage_root(project_id) / "inputs"
    upload_root.mkdir(parents=True, exist_ok=True)
    destination = upload_root / f"{uuid.uuid4()}{suffix}"
    try:
        with destination.open("wb") as output:
            shutil.copyfileobj(file.file, output, length=1024 * 1024)
        if destination.stat().st_size > 4_000_000_000:
            destination.unlink(missing_ok=True)
            raise HTTPException(status_code=413, detail="A single asset may not exceed 4 GB")
        guessed_media_type = mimetypes.guess_type(original_name)[0]
        media_type = guessed_media_type or file.content_type
        if file.content_type and file.content_type != "application/octet-stream":
            media_type = file.content_type
        metadata: dict[str, Any] = {"uploaded": True}
        try:
            metadata.update(inspect_media(destination, settings.raw["ffmpeg_executable"]))
        except ValueError:
            # Text/project files remain valid assets even when ffprobe cannot
            # inspect them.  Model-facing providers still reject mismatches.
            pass
        detected_kind = str(metadata.get("kind", ""))
        normalized_kind = detected_kind if detected_kind in {"image", "video", "audio", "text"} else kind if kind in {"reference", "image", "video", "audio", "text", "file"} else "reference"
        return store.register_asset(
            project_id,
            normalized_kind,
            original_name,
            destination,
            media_type,
            metadata,
            folder_id=folder_id,
            organization_id=principal.organization_id,
            created_by=principal.user_id,
        )
    except HTTPException:
        raise
    except Exception:
        destination.unlink(missing_ok=True)
        raise


@app.post("/v1/assets/{asset_id}/download-tickets", status_code=status.HTTP_201_CREATED)
def create_download_ticket(
    asset_id: str,
    body: DownloadTicketCreate,
    principal: Principal = Depends(require_principal),
) -> dict[str, Any]:
    _asset_guard(principal, asset_id, "viewer")
    grant = auth_store.create_download_grant(principal, asset_id, minutes=body.minutes)
    return {"url": f"/d/{grant['token']}", "expires_at": grant["expires_at"]}


@app.get("/d/{token}", include_in_schema=False)
def download_with_ticket(token: str, request: Request) -> FileResponse:
    grant = auth_store.resolve_download_grant(token, ip_address=_request_ip(request))
    if not grant:
        raise HTTPException(status_code=403, detail="下载链接无效、已过期或已达到使用上限")
    path = Path(grant["source_path"])
    if not path.is_file():
        raise HTTPException(status_code=410, detail="文件已不在本机存储中")
    return FileResponse(
        path,
        media_type=grant.get("media_type"),
        filename=grant["name"],
        content_disposition_type="attachment",
        headers={"Cache-Control": "private, no-store", "Accept-Ranges": "bytes"},
    )


@app.post("/v1/uploads/init", status_code=status.HTTP_201_CREATED)
def initialize_chunk_upload(body: UploadInitRequest, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _project_guard(principal, body.project_id, "editor")
    if body.folder_id:
        folder = store.get_asset_folder(body.folder_id)
        if not folder or folder["project_id"] != body.project_id:
            raise HTTPException(status_code=422, detail="素材文件夹不属于当前项目")
    session = auth_store.create_upload_session(
        principal,
        project_id=body.project_id,
        original_name=Path(body.name).name,
        media_type=body.media_type,
        folder_id=body.folder_id,
        size_bytes=body.size_bytes,
        expected_sha256=body.sha256,
    )
    return {
        "id": session["id"],
        "chunk_size": session["chunk_size"],
        "expires_at": session["expires_at"],
        "uploaded_chunks": [chunk["chunk_index"] for chunk in session["chunks"]],
    }


@app.get("/v1/uploads/{upload_id}")
def get_chunk_upload(upload_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    session = auth_store.get_upload_session(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在")
    _project_guard(principal, session["project_id"], "editor")
    if session["created_by"] != principal.user_id and auth_store.project_role(principal, str(session["project_id"])) != "owner":
        raise HTTPException(status_code=403, detail="无权查看该上传任务")
    return {
        "id": session["id"],
        "status": session["status"],
        "chunk_size": session["chunk_size"],
        "size_bytes": session["size_bytes"],
        "expires_at": session["expires_at"],
        "uploaded_chunks": [chunk["chunk_index"] for chunk in session["chunks"]],
    }


@app.put("/v1/uploads/{upload_id}/chunks/{chunk_index}")
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    request: Request,
    principal: Principal = Depends(require_principal),
) -> dict[str, Any]:
    session = auth_store.get_upload_session(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在")
    _project_guard(principal, session["project_id"], "editor")
    if chunk_index < 0:
        raise HTTPException(status_code=422, detail="分片序号无效")
    maximum_index = (int(session["size_bytes"]) - 1) // int(session["chunk_size"])
    if chunk_index > maximum_index:
        raise HTTPException(status_code=422, detail="分片超出文件范围")
    payload = await request.body()
    expected_max = min(int(session["chunk_size"]), int(session["size_bytes"]) - chunk_index * int(session["chunk_size"]))
    if not payload or len(payload) > expected_max:
        raise HTTPException(status_code=413, detail="分片大小无效")
    transfer_root = Path(settings.raw.get("transfer_root", settings.path("artifact_root").parent / "transfers")) / upload_id
    transfer_root.mkdir(parents=True, exist_ok=True)
    destination = transfer_root / f"{chunk_index:08d}.part"
    destination.write_bytes(payload)
    sha256 = hashlib.sha256(payload).hexdigest()
    try:
        auth_store.record_upload_chunk(principal, upload_id, chunk_index, len(payload), sha256)
    except PermissionError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"chunk_index": chunk_index, "size_bytes": len(payload), "sha256": sha256}


@app.post("/v1/uploads/{upload_id}/complete", status_code=status.HTTP_201_CREATED)
def complete_chunk_upload(
    upload_id: str,
    body: UploadCompleteRequest,
    principal: Principal = Depends(require_principal),
) -> dict[str, Any]:
    session = auth_store.get_upload_session(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在")
    _project_guard(principal, session["project_id"], "editor")
    if session["created_by"] != principal.user_id and auth_store.project_role(principal, str(session["project_id"])) != "owner":
        raise HTTPException(status_code=403, detail="无权完成该上传任务")
    expected_count = (int(session["size_bytes"]) + int(session["chunk_size"]) - 1) // int(session["chunk_size"])
    uploaded = {int(chunk["chunk_index"]): chunk for chunk in session["chunks"]}
    missing = [index for index in range(expected_count) if index not in uploaded]
    if missing:
        raise HTTPException(status_code=409, detail={"message": "仍有分片未上传", "missing": missing[:100]})
    transfer_root = Path(settings.raw.get("transfer_root", settings.path("artifact_root").parent / "transfers")) / upload_id
    upload_root = store.project_storage_root(str(session["project_id"])) / "inputs"
    upload_root.mkdir(parents=True, exist_ok=True)
    suffix = Path(session["original_name"]).suffix[:16]
    destination = upload_root / f"{uuid.uuid4()}{suffix}"
    digest = hashlib.sha256()
    written = 0
    try:
        with destination.open("wb") as output:
            for index in range(expected_count):
                part = transfer_root / f"{index:08d}.part"
                if not part.is_file():
                    raise HTTPException(status_code=409, detail=f"分片 {index} 在磁盘上不存在")
                with part.open("rb") as source:
                    while block := source.read(4 * 1024 * 1024):
                        output.write(block)
                        digest.update(block)
                        written += len(block)
        if written != int(session["size_bytes"]):
            raise HTTPException(status_code=409, detail="合并后的文件大小与上传声明不一致")
        actual_sha256 = digest.hexdigest()
        expected_sha256 = (body.sha256 or session.get("expected_sha256") or "").lower()
        if expected_sha256 and not secrets.compare_digest(actual_sha256, expected_sha256):
            raise HTTPException(status_code=409, detail="文件校验失败，请重新上传")
        metadata: dict[str, Any] = {"uploaded": True, "chunked": True, "sha256": actual_sha256}
        try:
            metadata.update(inspect_media(destination, settings.raw["ffmpeg_executable"]))
        except ValueError:
            pass
        detected_kind = str(metadata.get("kind", ""))
        normalized_kind = detected_kind if detected_kind in {"image", "video", "audio", "text"} else "file"
        asset = store.register_asset(
            session["project_id"],
            normalized_kind,
            session["original_name"],
            destination,
            session.get("media_type") or mimetypes.guess_type(session["original_name"])[0],
            metadata,
            folder_id=session.get("folder_id"),
            organization_id=principal.organization_id,
            created_by=principal.user_id,
        )
        auth_store.mark_upload_completed(principal, upload_id, asset["id"])
        shutil.rmtree(transfer_root, ignore_errors=True)
        return asset
    except Exception:
        destination.unlink(missing_ok=True)
        raise


@app.post("/v1/assets/{asset_id}/inspect")
def inspect_asset(asset_id: str, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    asset = _asset_guard(principal, asset_id, "viewer")
    try:
        metadata = inspect_media(asset["source_path"], settings.raw["ffmpeg_executable"])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    kind = str(metadata.get("kind", asset.get("kind") or "file"))
    detected_media_type = mimetypes.guess_type(str(asset.get("source_path", "")))[0]
    updated = store.update_asset_metadata(asset_id, metadata, kind=kind, media_type=detected_media_type)
    if not updated:
        raise HTTPException(status_code=404, detail="Asset not found")
    return updated


@app.post("/v1/jobs/{job_id}/approval")
def review_job(job_id: str, body: ApprovalUpdate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    _job_guard(principal, job_id, "reviewer")
    try:
        return store.set_approval(job_id, body.status, body.note)
    except ValueError as exc:
        code = 404 if str(exc) == "Job not found" else 422
        raise HTTPException(status_code=code, detail=str(exc)) from exc


@app.post("/v1/finals/batch", status_code=status.HTTP_202_ACCEPTED)
def create_final_batch(body: FinalBatchCreate, principal: Principal = Depends(require_principal)) -> dict[str, Any]:
    created: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for preview_id in dict.fromkeys(body.preview_job_ids):
        preview = store.get(preview_id)
        if not preview:
            errors.append({"preview_job_id": preview_id, "error": "Preview job not found"})
            continue
        if not auth_store.can_project(principal, str(preview.get("project_id") or "default"), "editor"):
            errors.append({"preview_job_id": preview_id, "error": "No permission for this project"})
            continue
        if preview["type"] != "h3.t2v" or preview["status"] != "succeeded":
            errors.append({"preview_job_id": preview_id, "error": "Only succeeded H3 previews can become finals"})
            continue
        if preview.get("approval_status") != "approved":
            errors.append({"preview_job_id": preview_id, "error": "Preview has not been approved"})
            continue
        if preview.get("final_job_id"):
            existing = store.get(preview["final_job_id"])
            existing_mode = existing.get("params", {}).get("final_mode", "quality") if existing else None
            if existing and existing_mode == body.mode:
                created.append(existing)
                continue
        params = dict(preview["params"])
        params["final_mode"] = body.mode
        if body.mode == "quality":
            params["profile"] = "quality"
            params["steps"] = body.steps
        else:
            params.pop("steps", None)
        params["source_preview_job_id"] = preview_id
        try:
            final_project_id = str(preview.get("project_id") or "default")
            final_job = store.create(
                "h3.t2v", params, body.priority,
                project_id=final_project_id,
                preview_job_id=preview_id,
                organization_id=str(preview.get("organization_id") or principal.organization_id),
                created_by=principal.user_id,
                admission_check=lambda connection: auth_store.job_submission_policy(principal, final_project_id, connection=connection),
            )
        except (PermissionError, ValueError) as exc:
            errors.append({"preview_job_id": preview_id, "error": str(exc)})
            continue
        store.link_final(preview_id, final_job["id"])
        created.append(final_job)
    if not created:
        raise HTTPException(status_code=422, detail={"message": "No final jobs were queued", "errors": errors})
    return {"created": created, "errors": errors}


UI_ROOT = Path(__file__).resolve().parents[2] / "ui"
UI_V3_ROOT = Path(__file__).resolve().parents[2] / "ui-v3" / "dist" / "client"


@app.get("/", include_in_schema=False)
def workbench_ui() -> FileResponse:
    return FileResponse(UI_ROOT / "index.html")


@app.get("/v3", include_in_schema=False)
@app.get("/v3/", include_in_schema=False)
def workbench_ui_v3() -> FileResponse:
    index = UI_V3_ROOT / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=503, detail="V3 workbench frontend has not been built")
    return FileResponse(index)


app.mount("/ui", StaticFiles(directory=UI_ROOT), name="ui")
app.mount("/ui-v3", StaticFiles(directory=UI_V3_ROOT, check_dir=False), name="ui-v3")
