import type { Asset, AssetFolder, AuthSession, AuthUser, Capabilities, Invitation, Job, LegacyCanvasState, Project, ProjectGroup, ProjectMember, ProjectUsage, UsageSummary } from "./types";
import type { H3IRPreview } from "./h3-director";
import type { AgentRequest, ProductionRun } from "./storyboard";

let accessKey = sessionStorage.getItem("h3-workbench-key") || "";
let csrfToken = sessionStorage.getItem("clsf-csrf-token") || "";
const playbackCache = new Map<string, Promise<string>>();

export function setAccessKey(value: string) {
  accessKey = value;
  sessionStorage.setItem("h3-workbench-key", value);
}

function setSession(payload: AuthSession) {
  csrfToken = payload.csrf_token || "";
  if (csrfToken) sessionStorage.setItem("clsf-csrf-token", csrfToken);
  else sessionStorage.removeItem("clsf-csrf-token");
  return payload;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (accessKey) headers.set("X-Workbench-Key", accessKey);
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes((options.method || "GET").toUpperCase())) headers.set("X-CSRF-Token", csrfToken);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
    } catch {
      // Keep the HTTP fallback message.
    }
    throw new Error(detail);
  }
  const contentType = response.headers.get("content-type") || "";
  return (contentType.includes("application/json") ? response.json() : response) as Promise<T>;
}

export async function localAuthenticate(): Promise<AuthSession> {
  try {
    return setSession(await api<AuthSession>("/v1/auth/me"));
  } catch {
    accessKey = "";
    sessionStorage.removeItem("h3-workbench-key");
  }
  const result = await fetch("/v1/local-auth", { credentials: "same-origin" });
  if (!result.ok) throw new Error("请使用团队账户登录，或通过有效邀请完成注册");
  return setSession(await result.json());
}

export const workbenchApi = {
  planStoryboard: (projectId: string, request: AgentRequest) => api<Job>("/v1/agent/storyboards", {method: "POST", body: JSON.stringify({project_id: projectId, brief: request.prompt, model_id: request.modelId, duration_seconds: request.duration, steps: request.steps, reference_asset_ids: request.assetIds, reference_descriptions: request.descriptions})}),
  executeStoryboard: (jobId: string, includeScore: boolean) => api<ProductionRun>(`/v1/agent/storyboards/${encodeURIComponent(jobId)}/execute`, {method: "POST", body: JSON.stringify({confirmed: true, include_score: includeScore})}),
  productions: (projectId: string) => api<ProductionRun[]>(`/v1/projects/${encodeURIComponent(projectId)}/productions`),
  controlProduction: (runId: string, action: "cancel" | "resume") => api<ProductionRun>(`/v1/productions/${encodeURIComponent(runId)}/${action}`, {method: "POST"}),
  me: () => api<AuthSession>("/v1/auth/me").then(setSession),
  login: (email: string, password: string) => api<AuthSession>("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }).then(setSession),
  register: (invitationCode: string, email: string, name: string, password: string) => api<AuthSession>("/v1/auth/register", { method: "POST", body: JSON.stringify({ invitation_code: invitationCode, email, name, password }) }).then(setSession),
  invitationPreview: (code: string) => api<{ organization_name: string; project_name?: string; project_role: string; email?: string; expires_at: string }>(`/v1/auth/invitations/preview?code=${encodeURIComponent(code)}`),
  logout: async () => { await api("/v1/auth/logout", { method: "POST" }); csrfToken = ""; accessKey = ""; sessionStorage.removeItem("clsf-csrf-token"); sessionStorage.removeItem("h3-workbench-key"); },
  setPassword: (password: string) => api("/v1/auth/password", { method: "POST", body: JSON.stringify({ password }) }),
  updateProfile: (patch: { name?: string; avatar_color?: string; avatar_image?: string }) => api<{ user: AuthUser }>("/v1/auth/profile", { method: "PATCH", body: JSON.stringify(patch) }),
  acceptInvitation: (code: string) => api<{ project_id: string; role: string; already_member: boolean }>("/v1/auth/invitations/accept", { method: "POST", body: JSON.stringify({ code }) }),
  invitations: (projectId?: string) => api<Invitation[]>(`/v1/admin/invitations${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`),
  createInvitation: (body: { email?: string; project_id?: string; project_role: string; can_create_projects: boolean; expires_hours: number; max_uses: number }) => api<Invitation>("/v1/admin/invitations", { method: "POST", body: JSON.stringify(body) }),
  revokeInvitation: (id: string) => api<void>(`/v1/admin/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  projectMembers: (projectId: string) => api<ProjectMember[]>(`/v1/projects/${encodeURIComponent(projectId)}/members`),
  updateProjectMember: (projectId: string, userId: string, patch: { role?: ProjectMember["role"]; monthly_compute_minutes_limit?: number | null; max_active_jobs?: number; queue_priority?: number }) => api<ProjectMember>(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeProjectMember: (projectId: string, userId: string) => api<void>(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  accountUsage: () => api<UsageSummary>("/v1/account/usage"),
  projectUsage: (projectId: string) => api<ProjectUsage>(`/v1/projects/${encodeURIComponent(projectId)}/usage`),
  compileH3: (params: Record<string, unknown>) => api<H3IRPreview>("/v1/h3/compile", { method: "POST", body: JSON.stringify({ params }) }),
  capabilities: () => api<Capabilities>("/v1/capabilities"),
  projects: (includeDeleted = false) => api<Project[]>(`/v1/projects${includeDeleted ? "?include_deleted=true" : ""}`),
  createProject: (name: string) => api<Project>("/v1/projects", { method: "POST", body: JSON.stringify({ name }) }),
  updateProject: (projectId: string, patch: { name?: string; group_id?: string | null; avatar_color?: string; avatar_image?: string; monthly_compute_minutes_limit?: number | null; max_active_jobs?: number }) => api<Project>(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  trashProject: (projectId: string) => api<Project>(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
  restoreProject: (projectId: string) => api<Project>(`/v1/projects/${encodeURIComponent(projectId)}/restore`, { method: "POST" }),
  projectGroups: () => api<ProjectGroup[]>("/v1/project-groups"),
  createProjectGroup: (name: string) => api<ProjectGroup>("/v1/project-groups", { method: "POST", body: JSON.stringify({ name }) }),
  renameProjectGroup: (groupId: string, name: string) => api<ProjectGroup>(`/v1/project-groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteProjectGroup: (groupId: string) => api<void>(`/v1/project-groups/${encodeURIComponent(groupId)}`, { method: "DELETE" }),
  canvas: (projectId: string) => api<{ state: LegacyCanvasState }>(`/v1/projects/${encodeURIComponent(projectId)}/canvas`),
  saveCanvas: (projectId: string, state: LegacyCanvasState) => api(`/v1/projects/${encodeURIComponent(projectId)}/canvas`, { method: "PUT", body: JSON.stringify({ state }) }),
  assets: (projectId: string) => api<Asset[]>(`/v1/assets?project_id=${encodeURIComponent(projectId)}&limit=300`),
  assetFolders: (projectId: string) => api<AssetFolder[]>(`/v1/asset-folders?project_id=${encodeURIComponent(projectId)}`),
  createAssetFolder: (projectId: string, name: string, parentId?: string | null) => api<AssetFolder>("/v1/asset-folders", { method: "POST", body: JSON.stringify({ project_id: projectId, name, parent_id: parentId || null, category: "custom" }) }),
  updateAssetFolder: (folderId: string, patch: { name?: string; parent_id?: string | null }) => api<AssetFolder>(`/v1/asset-folders/${encodeURIComponent(folderId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAssetFolder: (folderId: string) => api<void>(`/v1/asset-folders/${encodeURIComponent(folderId)}`, { method: "DELETE" }),
  updateAsset: (assetId: string, patch: { name?: string; folder_id?: string | null }) => api<Asset>(`/v1/assets/${encodeURIComponent(assetId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  jobs: (projectId: string) => api<Job[]>(`/v1/jobs?project_id=${encodeURIComponent(projectId)}&limit=160`),
  job: (jobId: string) => api<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`),
  reviewJob: (jobId: string, status: "approved" | "rejected" | "pending") => api<Job>(`/v1/jobs/${encodeURIComponent(jobId)}/approval`, { method: "POST", body: JSON.stringify({ status }) }),
  createJob: (projectId: string, type: string, params: Record<string, unknown>, priority = 100) => api<Job>("/v1/jobs", { method: "POST", body: JSON.stringify({ project_id: projectId, type, params, priority }) }),
  upload: async (projectId: string, file: File, folderId?: string | null) => {
    if (file.size > 64 * 1024 * 1024) {
      const upload = await api<{ id: string; chunk_size: number; uploaded_chunks: number[] }>("/v1/uploads/init", { method: "POST", body: JSON.stringify({ project_id: projectId, name: file.name, size_bytes: file.size, media_type: file.type || undefined, folder_id: folderId || undefined }) });
      const uploaded = new Set(upload.uploaded_chunks || []);
      const chunkCount = Math.ceil(file.size / upload.chunk_size);
      for (let index = 0; index < chunkCount; index += 1) {
        if (uploaded.has(index)) continue;
        const start = index * upload.chunk_size;
        await api(`/v1/uploads/${encodeURIComponent(upload.id)}/chunks/${index}`, { method: "PUT", body: file.slice(start, Math.min(file.size, start + upload.chunk_size)), headers: { "Content-Type": "application/octet-stream" } });
      }
      return api<Asset>(`/v1/uploads/${encodeURIComponent(upload.id)}/complete`, { method: "POST", body: JSON.stringify({}) });
    }
    const form = new FormData();
    form.append("project_id", projectId);
    form.append("kind", "reference");
    if (folderId) form.append("folder_id", folderId);
    form.append("file", file);
    return api<Asset>("/v1/assets/upload", { method: "POST", body: form });
  },
  createDownloadTicket: (assetId: string, minutes = 15) => api<{ url: string; expires_at: string }>(`/v1/assets/${encodeURIComponent(assetId)}/download-tickets`, { method: "POST", body: JSON.stringify({ minutes }) }),
  playback: (assetId: string) => {
    if (!playbackCache.has(assetId)) {
      playbackCache.set(assetId, api<{ url: string }>(`/v1/assets/${assetId}/playback`).then((result) => result.url));
    }
    return playbackCache.get(assetId)!;
  },
  inspectAsset: (assetId: string) => api<Asset>(`/v1/assets/${encodeURIComponent(assetId)}/inspect`, { method: "POST" }),
  startRuntime: () => api<{ status: string; capabilities: Capabilities }>("/v1/runtime/comfy/start", { method: "POST" }),
};
