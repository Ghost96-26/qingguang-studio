import {
  ArrowClockwise,
  ArrowLeft,
  ChartLineUp,
  Check,
  ClockCounterClockwise,
  Database,
  HardDrives,
  MagnifyingGlass,
  ShieldCheck,
  SignOut,
  SpinnerGap,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { workbenchApi } from "../api";
import type { AdminAccessEvent, AdminOverview, AdminUser, AuthUser } from "../types";

type AdminTab = "overview" | "users" | "access";

export function AdminConsole({ user }: { user: AuthUser }) {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [events, setEvents] = useState<AdminAccessEvent[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "suspended">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextOverview, nextUsers, nextEvents] = await Promise.all([
        workbenchApi.adminOverview(30),
        workbenchApi.adminUsers(30),
        workbenchApi.adminAccessEvents(200),
      ]);
      setOverview(nextOverview);
      setUsers(nextUsers);
      setEvents(nextEvents);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 30_000);
    const onFocus = () => void refresh(true);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return users.filter((item) => (status === "all" || item.status === status)
      && (!needle || `${item.name} ${item.email}`.toLocaleLowerCase().includes(needle)));
  }, [query, status, users]);

  const saveUser = async (target: AdminUser, patch: Parameters<typeof workbenchApi.updateAdminUser>[1]) => {
    if (patch.status === "suspended" && !window.confirm(`暂停 ${target.name} 后，其现有登录会话会立即失效。继续吗？`)) return;
    const updated = await workbenchApi.updateAdminUser(target.id, patch);
    setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
    setNotice(`${target.name} 的账户权限已更新。`);
    window.setTimeout(() => setNotice(""), 3200);
    await refresh(true);
  };

  const revokeSessions = async (target: AdminUser) => {
    if (!window.confirm(`${target.is_current_user ? "退出其他设备" : `下线 ${target.name} 的全部设备`}？`)) return;
    const result = await workbenchApi.revokeAdminUserSessions(target.id);
    setNotice(result.revoked_sessions ? `已撤销 ${result.revoked_sessions} 个会话。` : "没有需要撤销的会话。");
    window.setTimeout(() => setNotice(""), 3200);
    await refresh(true);
  };

  return <div className="admin-shell">
    <header className="admin-topbar">
      <div className="admin-brand"><span><ShieldCheck weight="duotone" /></span><div><strong>擎光绘影 · 管理后台</strong><small>LOCAL ADMINISTRATION CONSOLE</small></div></div>
      <div className="admin-local-badge"><i />仅限本机访问</div>
      <div className="admin-identity"><span>{user.name.slice(0, 1).toLocaleUpperCase()}</span><div><strong>{user.name}</strong><small>{platformRole(user.organization_role)}</small></div></div>
      <a className="admin-back" href="/v3"><ArrowLeft />返回创作台</a>
    </header>

    <aside className="admin-sidebar" aria-label="管理后台导航">
      <div className="admin-nav-heading"><small>平台管理</small><strong>工作台运行概览</strong></div>
      <nav>
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><ChartLineUp />总览</button>
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><UsersThree />用户与权限<span>{users.length}</span></button>
        <button className={tab === "access" ? "active" : ""} onClick={() => setTab("access")}><ClockCounterClockwise />访问记录</button>
      </nav>
      <div className="admin-sidebar-note"><ShieldCheck /><p><strong>双层权限</strong><small>平台角色决定管理能力，项目角色决定内容访问范围。</small></p></div>
    </aside>

    <main className="admin-main">
      <header className="admin-page-header">
        <div><small>{tab === "overview" ? "PLATFORM OVERVIEW" : tab === "users" ? "USERS & PERMISSIONS" : "ACCESS ACTIVITY"}</small><h1>{tab === "overview" ? "平台总览" : tab === "users" ? "用户与权限" : "访问记录"}</h1><p>{tab === "overview" ? "最近30天的任务、计算时长、素材存储与当前在线会话。" : tab === "users" ? "集中管理账户状态、平台角色、项目创建权和跨项目用量上限。" : "查看登录、失败尝试、退出和管理操作；时间按本机时区显示。"}</p></div>
        <button className="admin-refresh" onClick={() => void refresh()} disabled={loading}><ArrowClockwise className={loading ? "spin" : ""} />刷新</button>
      </header>

      {error ? <div className="admin-error" role="alert"><WarningCircle />{error}</div> : null}
      {notice ? <div className="admin-notice" role="status"><Check weight="bold" />{notice}</div> : null}
      {loading && !overview ? <div className="admin-loading"><SpinnerGap className="spin" /><strong>正在读取本机管理数据</strong></div> : null}

      {overview && tab === "overview" ? <OverviewPanel overview={overview} users={users} events={events} /> : null}
      {tab === "users" ? <section className="admin-users-panel">
        <div className="admin-toolbar">
          <label><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名或邮箱" aria-label="搜索用户" /></label>
          <div className="admin-filter" role="group" aria-label="账户状态筛选">
            {(["all", "active", "suspended"] as const).map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{value === "all" ? "全部" : value === "active" ? "已启用" : "已暂停"}</button>)}
          </div>
          <span>{filteredUsers.length} 个账户</span>
        </div>
        <div className="admin-user-list">{filteredUsers.map((item) => <AdminUserRow key={item.id} user={item} onSave={saveUser} onRevokeSessions={revokeSessions} onError={setError} />)}</div>
        {!filteredUsers.length ? <div className="admin-empty"><UsersThree />没有匹配的账户</div> : null}
      </section> : null}
      {tab === "access" ? <AccessEvents events={events} /> : null}
    </main>
  </div>;
}

function OverviewPanel({ overview, users, events }: { overview: AdminOverview; users: AdminUser[]; events: AdminAccessEvent[] }) {
  const maxSeconds = Math.max(1, ...overview.daily.map((item) => Number(item.compute_seconds)));
  return <section className="admin-overview">
    <div className="admin-metrics">
      <Metric icon={<UsersThree />} label="启用账户" value={overview.active_users.toLocaleString("zh-CN")} note={`${overview.users} 个账户 · ${overview.suspended_users} 个暂停`} />
      <Metric icon={<ShieldCheck />} label="在线会话" value={overview.active_sessions.toLocaleString("zh-CN")} note={`${overview.active_invitations} 个有效邀请`} />
      <Metric icon={<Database />} label="运行分钟" value={formatMinutes(overview.compute_seconds)} note={`最近30天 · ${overview.job_count} 个任务`} />
      <Metric icon={<HardDrives />} label="素材存储" value={formatBytes(overview.storage_bytes)} note={`${overview.projects} 个有效项目`} />
    </div>
    <div className="admin-overview-grid">
      <article className="admin-card admin-chart-card">
        <header><div><strong>平台运行趋势</strong><small>最近30天 · 北京日期</small></div><span>{overview.queued_jobs ? `${overview.queued_jobs} 个任务处理中` : "队列空闲"}</span></header>
        {overview.daily.length ? <div className="admin-bars" role="img" aria-label="最近30天平台运行时长柱状图">{overview.daily.map((item) => <span key={item.day} title={`${item.day} · ${formatMinutes(item.compute_seconds)} 分钟 · ${item.jobs} 个任务`}><i style={{ height: `${Math.max(5, Number(item.compute_seconds) / maxSeconds * 100)}%` }} /><small>{new Date(`${item.day}T00:00:00`).getDate()}</small></span>)}</div> : <div className="admin-empty"><ChartLineUp />最近30天还没有运行记录</div>}
      </article>
      <article className="admin-card admin-activity-card"><header><strong>最近访问</strong><small>登录与权限事件</small></header>{events.slice(0, 6).map((event) => <EventRow event={event} key={event.id} compact />)}{!events.length ? <div className="admin-empty"><ClockCounterClockwise />还没有访问记录</div> : null}</article>
      <article className="admin-card admin-ranking-card"><header><strong>用户用量</strong><small>最近30天</small></header>{[...users].sort((a, b) => b.usage.compute_seconds - a.usage.compute_seconds).slice(0, 6).map((item) => <div className="admin-ranking" key={item.id}><Avatar user={item} /><span><strong>{item.name}</strong><small>{item.usage.job_count} 个任务 · {formatBytes(item.usage.storage_bytes)}</small></span><em>{formatMinutes(item.usage.compute_seconds)}m</em></div>)}</article>
    </div>
  </section>;
}

function Metric({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note: string }) {
  return <article><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><em>{note}</em></div></article>;
}

function AdminUserRow({ user, onSave, onRevokeSessions, onError }: { user: AdminUser; onSave: (user: AdminUser, patch: Parameters<typeof workbenchApi.updateAdminUser>[1]) => Promise<void>; onRevokeSessions: (user: AdminUser) => Promise<void>; onError: (message: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountStatus, setAccountStatus] = useState(user.status);
  const [role, setRole] = useState(user.organization_role);
  const [canCreate, setCanCreate] = useState(user.can_create_projects);
  const [quota, setQuota] = useState(user.monthly_compute_seconds_limit == null ? "" : String(Math.round(user.monthly_compute_seconds_limit / 60)));
  const [maxJobs, setMaxJobs] = useState(String(user.max_active_jobs || 50));

  useEffect(() => {
    setAccountStatus(user.status); setRole(user.organization_role); setCanCreate(user.can_create_projects);
    setQuota(user.monthly_compute_seconds_limit == null ? "" : String(Math.round(user.monthly_compute_seconds_limit / 60)));
    setMaxJobs(String(user.max_active_jobs || 50));
  }, [user]);

  const save = async () => {
    const quotaValue = quota.trim() ? Number(quota) : null;
    const maxValue = Number(maxJobs);
    if (quotaValue != null && (!Number.isInteger(quotaValue) || quotaValue < 0)) return;
    if (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 500) return;
    setSaving(true);
    try {
      await onSave(user, { status: accountStatus, organization_role: role, can_create_projects: canCreate, monthly_compute_minutes_limit: quotaValue, max_active_jobs: maxValue });
      setExpanded(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
    finally { setSaving(false); }
  };

  return <article className={`admin-user-row ${expanded ? "expanded" : ""} ${user.status === "suspended" ? "suspended" : ""}`}>
    <button className="admin-user-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <Avatar user={user} />
      <span><strong>{user.name}{user.is_current_user ? "（当前）" : ""}</strong><small>{user.email}</small></span>
      <em className={`admin-status ${user.status}`}>{user.status === "active" ? "已启用" : "已暂停"}</em>
      <span className="admin-user-role"><strong>{platformRole(user.organization_role)}</strong><small>{user.projects.length} 个项目</small></span>
      <span className="admin-user-stat"><strong>{formatMinutes(user.usage.compute_seconds)}m</strong><small>30天运行</small></span>
      <span className="admin-user-stat"><strong>{user.active_sessions}</strong><small>在线会话</small></span>
    </button>
    {expanded ? <div className="admin-user-editor">
      <div className="admin-user-fields">
        <label><span>账户状态</span><select value={accountStatus} disabled={user.id === "local-owner"} onChange={(event) => setAccountStatus(event.target.value as AdminUser["status"])}><option value="active">启用</option><option value="suspended">暂停并下线</option></select></label>
        <label><span>平台角色</span><select value={role} disabled={user.id === "local-owner"} onChange={(event) => setRole(event.target.value as AdminUser["organization_role"])}><option value="owner">平台主管</option><option value="admin">平台管理员</option><option value="member">普通成员</option></select></label>
        <label><span>月运行额度</span><input type="number" min="0" step="1" value={quota} onChange={(event) => setQuota(event.target.value)} placeholder="不限" /><small>跨全部项目，留空表示不限</small></label>
        <label><span>同时任务上限</span><input type="number" min="1" max="500" step="1" value={maxJobs} onChange={(event) => setMaxJobs(event.target.value)} /></label>
        <label className="admin-check"><input type="checkbox" checked={canCreate} disabled={user.id === "local-owner"} onChange={(event) => setCanCreate(event.target.checked)} /><span><strong>允许创建项目</strong><small>关闭后仍可进入已有项目</small></span></label>
      </div>
      <div className="admin-user-scope">
        <section><header><strong>项目权限</strong><small>{user.projects.length} 项</small></header><div className="admin-project-chips">{user.projects.map((project) => <span key={project.project_id}><i>{project.project_name.slice(0, 1)}</i><b>{project.project_name}</b><small>{projectRole(project.role)}</small></span>)}</div>{!user.projects.length ? <p>尚未加入任何项目</p> : null}</section>
        <section><header><strong>最近设备</strong><small>最多5条</small></header><div className="admin-session-list">{user.recent_sessions.map((session) => <span key={session.id}><i className={session.active ? "active" : ""} /><b>{session.ip_address || "本机"}</b><small title={session.user_agent}>{deviceName(session.user_agent)}</small><time>{relativeTime(session.last_seen_at)}</time></span>)}</div>{!user.recent_sessions.length ? <p>还没有登录会话</p> : null}</section>
      </div>
      <footer><button onClick={() => void onRevokeSessions(user)}><SignOut />{user.is_current_user ? "退出其他设备" : "下线全部设备"}</button><span />{user.id === "local-owner" ? <small>本机平台主管的状态与角色受保护</small> : null}<button onClick={() => setExpanded(false)}>取消</button><button className="admin-save" onClick={() => void save()} disabled={saving}>{saving ? <SpinnerGap className="spin" /> : <Check />}保存权限</button></footer>
    </div> : null}
  </article>;
}

function AccessEvents({ events }: { events: AdminAccessEvent[] }) {
  const [kind, setKind] = useState<"all" | "login" | "admin">("all");
  const filtered = events.filter((event) => kind === "all" || (kind === "login" ? event.action.startsWith("auth.") : event.action.startsWith("admin.")));
  return <section className="admin-access-panel">
    <div className="admin-toolbar"><div className="admin-filter" role="group" aria-label="记录类型筛选">{(["all", "login", "admin"] as const).map((value) => <button key={value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>{value === "all" ? "全部" : value === "login" ? "登录" : "管理操作"}</button>)}</div><span>最近 {filtered.length} 条</span></div>
    <div className="admin-event-list">{filtered.map((event) => <EventRow event={event} key={event.id} />)}</div>
    {!filtered.length ? <div className="admin-empty"><ClockCounterClockwise />没有匹配的访问记录</div> : null}
  </section>;
}

function EventRow({ event, compact = false }: { event: AdminAccessEvent; compact?: boolean }) {
  const failed = event.action === "auth.login_failed";
  return <div className={`admin-event ${failed ? "failed" : ""} ${compact ? "compact" : ""}`}><span><i /></span><div><strong>{eventLabel(event.action)}</strong><small>{event.user_name || event.user_email || event.target_id || "未知账户"}</small></div>{compact ? null : <em>{event.ip_address || "本机"}</em>}<time>{relativeTime(event.created_at)}</time></div>;
}

function Avatar({ user }: { user: Pick<AdminUser, "name" | "avatar_color" | "avatar_image"> }) {
  return <span className="admin-avatar" style={{ background: user.avatar_color || "#6d7bd8" }}>{user.avatar_image ? <img src={user.avatar_image} alt="" /> : user.name.slice(0, 1).toLocaleUpperCase()}</span>;
}

function platformRole(role: string) { return role === "owner" ? "平台主管" : role === "admin" ? "平台管理员" : "普通成员"; }
function projectRole(role: string) { return ({ owner: "负责人", editor: "制作", reviewer: "审核", viewer: "查看" } as Record<string, string>)[role] || role; }
function eventLabel(action: string) { return ({ "auth.login": "登录成功", "auth.login_failed": "登录失败", "auth.logout": "主动退出", "auth.password_set": "更新密码", "auth.profile_update": "更新资料", "admin.user_update": "账户权限更新", "admin.sessions_revoke": "会话已撤销" } as Record<string, string>)[action] || action; }
function formatMinutes(seconds?: number | null) { const minutes = Math.max(0, Number(seconds || 0) / 60); return minutes < 10 ? minutes.toFixed(1) : Math.round(minutes).toLocaleString("zh-CN"); }
function formatBytes(bytes?: number | null) { const value = Math.max(0, Number(bytes || 0)); if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(1)} GB`; }
function relativeTime(value?: string | null) { if (!value) return "从未"; const date = new Date(value); const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000); if (seconds < 60) return "刚刚"; if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`; if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}天前`; return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function deviceName(agent?: string) { const value = agent || ""; if (/iPad/i.test(value)) return "iPad"; if (/iPhone/i.test(value)) return "iPhone"; if (/Android/i.test(value)) return "Android"; if (/Edg/i.test(value)) return "Edge"; if (/Chrome/i.test(value)) return "Chrome"; if (/Safari/i.test(value)) return "Safari"; return value ? "浏览器" : "本地会话"; }
