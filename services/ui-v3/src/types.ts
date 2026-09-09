import type { Edge, Node, XYPosition } from "@xyflow/react";

export type NodeKind =
  | "asset"
  | "image_t2i"
  | "image_i2i"
  | "image_edit"
  | "media_prepare"
  | "video"
  | "tts"
  | "dialogue"
  | "music"
  | "sfx"
  | "note"
  | "group";

export type WorkbenchParams = Record<string, string | number | boolean | string[] | undefined | null>;

export interface WorkbenchNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  params: WorkbenchParams;
  assetId?: string;
  /** Ordered batch outputs; assetId is always the currently active output. */
  assetIds?: string[];
  jobId?: string;
  /** Ordered batch jobs; jobId is the currently representative job. */
  jobIds?: string[];
  groupIds?: string[];
  collapsed?: boolean;
  outputMediaKind?: string;
  /** Snapshot of params + incoming material roles used by the displayed result. */
  runSignature?: string;
  /** Immutable production snapshot; dispatch is controlled by the Agent run. */
  productionRunId?: string;
}

export type WorkbenchNode = Node<WorkbenchNodeData>;
export type WorkbenchEdge = Edge<Record<string, unknown>>;

export interface Project {
  id: string;
  name: string;
  group_id?: string | null;
  sort_order?: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  organization_id?: string;
  owner_user_id?: string | null;
  current_user_role?: "viewer" | "reviewer" | "editor" | "owner" | null;
  project_kind?: "personal" | "standard" | string;
  avatar_color?: string;
  avatar_image?: string;
  monthly_compute_seconds_limit?: number | null;
  max_active_jobs?: number;
  scope?: "owned" | "shared";
  storage_root?: string;
}

export interface AuthUser {
  id: string;
  organization_id: string;
  organization_role: "owner" | "admin" | "member";
  email: string;
  name: string;
  can_create_projects: boolean;
  avatar_color?: string;
  avatar_image?: string;
  is_admin: boolean;
}

export interface AuthSession {
  user: AuthUser;
  csrf_token?: string | null;
}

export interface Invitation {
  id: string;
  email?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  project_role: "viewer" | "reviewer" | "editor" | "owner";
  can_create_projects: boolean;
  max_uses: number;
  use_count: number;
  expires_at: string;
  revoked_at?: string | null;
  created_at: string;
  active: boolean;
  code?: string;
}

export interface ProjectMember {
  id: string;
  email: string;
  name: string;
  status: string;
  role: "viewer" | "reviewer" | "editor" | "owner";
  avatar_color?: string;
  avatar_image?: string;
  monthly_compute_seconds_limit?: number | null;
  max_active_jobs?: number;
  queue_priority?: number;
  month_compute_seconds?: number;
  created_at: string;
  updated_at: string;
}

export interface UsageDay {
  day: string;
  jobs: number;
  compute_seconds: number;
}

export interface UsageSummary {
  compute_seconds: number;
  job_count: number;
  succeeded_jobs: number;
  failed_jobs: number;
  queued_jobs: number;
  storage_bytes: number;
  daily: UsageDay[];
  unit?: "compute_seconds" | string;
  period?: "rolling_30_days" | string;
}

export interface ProjectUsage {
  unit: "compute_seconds" | string;
  period: "rolling_30_days" | string;
  project: UsageSummary;
  mine: UsageSummary;
  limits: {
    project_monthly_compute_seconds?: number | null;
    project_max_active_jobs?: number | null;
    member_monthly_compute_seconds?: number | null;
    member_max_active_jobs?: number | null;
  };
}

export interface AdminSession {
  id: string;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at?: string | null;
  active: boolean;
}

export interface AdminUserProject {
  project_id: string;
  project_name: string;
  project_kind?: string;
  role: "viewer" | "reviewer" | "editor" | "owner";
  monthly_compute_seconds_limit?: number | null;
  max_active_jobs?: number;
  queue_priority?: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: "active" | "suspended";
  organization_role: "member" | "admin" | "owner";
  can_create_projects: boolean;
  monthly_compute_seconds_limit?: number | null;
  max_active_jobs: number;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
  avatar_color?: string;
  avatar_image?: string;
  is_current_user: boolean;
  active_sessions: number;
  projects: AdminUserProject[];
  recent_sessions: AdminSession[];
  usage: Omit<UsageSummary, "daily">;
}

export interface AdminOverview {
  period_days: number;
  users: number;
  active_users: number;
  suspended_users: number;
  active_sessions: number;
  projects: number;
  active_invitations: number;
  job_count: number;
  queued_jobs: number;
  compute_seconds: number;
  storage_bytes: number;
  daily: UsageDay[];
}

export interface AdminAccessEvent {
  id: number;
  user_id?: string | null;
  user_name?: string | null;
  user_email?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  ip_address?: string | null;
  created_at: string;
  detail: Record<string, unknown>;
}

export interface ProjectGroup {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  source_path: string;
  media_type?: string;
  size_bytes: number;
  origin_job_id?: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
  folder_id?: string | null;
}

export interface AssetFolder {
  id: string;
  project_id: string;
  parent_id?: string | null;
  name: string;
  category: "scene" | "character" | "prop" | "unfiled" | "custom";
  system_key?: string | null;
  sort_order: number;
  asset_count: number;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  project_id?: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: number;
  params: WorkbenchParams;
  result?: Record<string, unknown> | null;
  error?: string | null;
  approval_status?: string;
  preview_job_id?: string | null;
  final_job_id?: string | null;
  created_at: string;
}

export interface LocalModel {
  id: string;
  label: string;
  ready?: boolean;
  recommended?: boolean;
  capabilities?: string[];
}

export interface Capabilities {
  providers?: {
    h3?: { ready?: boolean; modes?: string[] };
    image?: { ready?: boolean; models?: LocalModel[] };
    tts?: { ready?: boolean; languages?: string[] };
    music?: { ready?: boolean };
    foley?: { ready?: boolean; model?: string; sample_rate?: number; max_duration_seconds?: number; requires_video?: boolean };
    agent?: { ready?: boolean; default_model?: string; models?: LocalModel[] };
    audio_tools?: { ready?: boolean };
  };
}

export interface NodeReadiness {
  ready: boolean;
  reason: string;
}

export interface LegacyCanvasState {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  viewport?: { x?: number; y?: number; zoom?: number };
  version?: number;
}

export interface DeriveRequest {
  sourceId: string;
  kind: NodeKind;
  position: XYPosition;
  targetPort?: string;
  params?: WorkbenchParams;
}
