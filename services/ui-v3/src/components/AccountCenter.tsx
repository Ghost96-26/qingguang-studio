import {
  ChartLineUp,
  Check,
  Copy,
  FolderOpen,
  GearSix,
  Key,
  Link,
  SignOut,
  SpinnerGap,
  Ticket,
  Trash,
  UserCircle,
  UserCircleGear,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { workbenchApi } from "../api";
import { AvatarUpload } from "./AvatarUpload";
import type { AuthUser, Invitation, Project, ProjectMember, ProjectUsage, UsageSummary } from "../types";

type AccountTab = "profile" | "project" | "members" | "my-usage" | "project-usage";

interface AccountCenterProps {
  open: boolean;
  user: AuthUser;
  projects: Project[];
  currentProjectId: string;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onUserChanged: (user: AuthUser) => void;
  onProjectUpdated: (project: Project) => void;
  onProjectsChanged: (preferredProjectId?: string) => Promise<void>;
  notify: (message: string, tone?: "default" | "success" | "danger") => void;
}

const AVATAR_COLORS = ["#7C8CFF", "#DF66B1", "#4FA7C8", "#45A77A", "#C79547", "#9B70D1"];

export function AccountCenter(props: AccountCenterProps) {
  const { open, user, projects, currentProjectId, notify } = props;
  const [tab, setTab] = useState<AccountTab>("profile");
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [accountUsage, setAccountUsage] = useState<UsageSummary | null>(null);
  const [projectUsage, setProjectUsage] = useState<ProjectUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [displayName, setDisplayName] = useState(user.name);
  const [userColor, setUserColor] = useState(user.avatar_color || AVATAR_COLORS[0]);
  const [userImage, setUserImage] = useState(user.avatar_image || "");
  const [password, setPassword] = useState("");
  const [acceptCode, setAcceptCode] = useState(() => new URLSearchParams(window.location.search).get("invite") || "");
  const [projectName, setProjectName] = useState("");
  const [projectColor, setProjectColor] = useState(AVATAR_COLORS[0]);
  const [projectImage, setProjectImage] = useState("");
  const [projectLimit, setProjectLimit] = useState("");
  const [projectQueueLimit, setProjectQueueLimit] = useState("50");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<ProjectMember["role"]>("editor");
  const [lastInviteLink, setLastInviteLink] = useState("");

  const project = useMemo(() => projects.find((item) => item.id === currentProjectId), [currentProjectId, projects]);
  const isProjectOwner = project?.current_user_role === "owner";
  const localAdminAvailable = user.is_admin && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);

  useEffect(() => {
    setDisplayName(user.name);
    setUserColor(user.avatar_color || AVATAR_COLORS[0]);
    setUserImage(user.avatar_image || "");
  }, [user.avatar_color, user.avatar_image, user.name]);

  useEffect(() => {
    if (!project) return;
    setProjectName(project.name);
    setProjectColor(project.avatar_color || AVATAR_COLORS[0]);
    setProjectImage(project.avatar_image || "");
    setProjectLimit(project.monthly_compute_seconds_limit == null ? "" : String(Math.round(project.monthly_compute_seconds_limit / 60)));
    setProjectQueueLimit(String(project.max_active_jobs || 50));
  }, [project]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const memberRequest = workbenchApi.projectMembers(currentProjectId).catch(() => [] as ProjectMember[]);
    const inviteRequest = isProjectOwner ? workbenchApi.invitations(currentProjectId).catch(() => [] as Invitation[]) : Promise.resolve([] as Invitation[]);
    Promise.all([workbenchApi.accountUsage(), workbenchApi.projectUsage(currentProjectId), memberRequest, inviteRequest])
      .then(([mine, team, nextMembers, nextInvites]) => {
        if (!live) return;
        setAccountUsage(mine);
        setProjectUsage(team);
        setMembers(nextMembers);
        setInvitations(nextInvites);
      })
      .catch((reason) => live && notify(reason instanceof Error ? reason.message : String(reason), "danger"))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [currentProjectId, isProjectOwner, notify, open]);

  if (!open || !project) return null;

  const saveProfile = async () => {
    if (!displayName.trim()) return;
    setBusy("profile");
    try {
      const result = await workbenchApi.updateProfile({ name: displayName.trim(), avatar_color: userColor, avatar_image: userImage });
      props.onUserChanged(result.user);
      notify("个人资料已更新。", "success");
    } catch (reason) { notify(errorMessage(reason), "danger"); }
    finally { setBusy(""); }
  };

  const savePassword = async () => {
    setBusy("password");
    try {
      await workbenchApi.setPassword(password);
      setPassword("");
      notify("密码已更新。", "success");
    } catch (reason) { notify(errorMessage(reason), "danger"); }
    finally { setBusy(""); }
  };

  const acceptInvitation = async () => {
    const code = invitationCode(acceptCode);
    if (!code) return;
    setBusy("accept");
    try {
      const result = await workbenchApi.acceptInvitation(code);
      await props.onProjectsChanged(result.project_id);
      setAcceptCode("");
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      notify(result.already_member ? "你已经是该项目成员。" : "已加入协作项目。", "success");
    } catch (reason) { notify(errorMessage(reason), "danger"); }
    finally { setBusy(""); }
  };

  const saveProject = async () => {
    if (!isProjectOwner || !projectName.trim()) return;
    setBusy("project");
    try {
      const updated = await workbenchApi.updateProject(project.id, {
        name: projectName.trim(),
        avatar_color: projectColor,
        avatar_image: projectImage,
        monthly_compute_minutes_limit: projectLimit.trim() === "" ? null : wholeNumber(projectLimit, 0, 1_000_000, "月度运行分钟"),
        max_active_jobs: wholeNumber(projectQueueLimit, 1, 500, "排队上限"),
      });
      props.onProjectUpdated({ ...project, ...updated });
      notify("项目设置已保存。", "success");
    } catch (reason) { notify(errorMessage(reason), "danger"); }
    finally { setBusy(""); }
  };

  const createInvite = async () => {
    if (!isProjectOwner || !inviteEmail.trim()) return;
    setBusy("invite");
    try {
      const invitation = await workbenchApi.createInvitation({
        email: inviteEmail.trim(),
        project_id: project.id,
        project_role: inviteRole,
        can_create_projects: true,
        expires_hours: 168,
        max_uses: 1,
      });
      const link = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(invitation.code || "")}`;
      setLastInviteLink(link);
      setInvitations((current) => [invitation, ...current]);
      setInviteEmail("");
      await navigator.clipboard?.writeText(link).catch(() => undefined);
      notify("邀请链接已创建并复制。", "success");
    } catch (reason) { notify(errorMessage(reason), "danger"); }
    finally { setBusy(""); }
  };

  const updateMember = async (member: ProjectMember, patch: Parameters<typeof workbenchApi.updateProjectMember>[2]) => {
    const updated = await workbenchApi.updateProjectMember(project.id, member.id, patch);
    setMembers((current) => current.map((item) => item.id === updated.id ? updated : item));
    await props.onProjectsChanged(project.id);
    notify(`${member.name}的权限与额度已更新。`, "success");
  };

  const removeMember = async (member: ProjectMember) => {
    if (!window.confirm(`从“${project.name}”移除 ${member.name}？`)) return;
    try {
      await workbenchApi.removeProjectMember(project.id, member.id);
      setMembers((current) => current.filter((item) => item.id !== member.id));
      notify("成员已移除。", "success");
    } catch (reason) { notify(errorMessage(reason), "danger"); }
  };

  const tabs: Array<{ id: AccountTab; label: string; icon: typeof UserCircle; section?: string }> = [
    { id: "profile", label: "个人资料", icon: UserCircle, section: "个人" },
    { id: "my-usage", label: "我的用量", icon: ChartLineUp },
    { id: "project", label: "当前项目", icon: FolderOpen, section: project.name },
    { id: "members", label: "成员与邀请", icon: UsersThree },
    { id: "project-usage", label: "项目用量", icon: ChartLineUp },
  ];

  return <div className="account-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section className="account-center account-center-v2" role="dialog" aria-modal="true" aria-label="账户与项目设置" onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") props.onClose(); }}>
      <header>
        <div className="settings-identity">
          <Avatar color={user.avatar_color} image={user.avatar_image} name={user.name} />
          <span><strong>{user.name}</strong><small>{user.email}</small></span>
        </div>
        {loading ? <SpinnerGap className="spin settings-loading" /> : null}
        <button onClick={props.onClose} aria-label="关闭设置"><X /></button>
      </header>
      <nav aria-label="设置导航">
        {tabs.map((item, index) => {
          const Icon = item.icon;
          return <div className="settings-nav-block" key={item.id}>
            {item.section ? <small>{item.section}</small> : null}
            <button className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><Icon />{item.label}</button>
            {index === 1 ? <span className="settings-nav-separator" /> : null}
          </div>;
        })}
        <span className="settings-nav-spacer" />
        {localAdminAvailable ? <button onClick={() => window.location.assign("/v3/admin")}><UserCircleGear />管理后台</button> : null}
        <button className="settings-signout" onClick={() => void props.onLogout()}><SignOut />退出账户</button>
      </nav>
      <main className="account-center-content">
        {tab === "profile" ? <section className="settings-page">
          <PageTitle eyebrow="PERSONAL" title="个人资料" description="管理你在协作项目中显示的身份。" />
          <div className="settings-card profile-card-v2">
            <AvatarUpload value={userImage} onChange={setUserImage} label="上传个人头像" notify={notify}><Avatar color={userColor} image={userImage} name={displayName || user.name} large /></AvatarUpload>
            <div className="settings-form-grid">
              <label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} /></label>
              <label><span>登录邮箱</span><input value={user.email} readOnly aria-readonly="true" /></label>
              <fieldset className="color-field"><legend>头像颜色</legend><ColorPicker value={userColor} onChange={setUserColor} /></fieldset>
              <button className="settings-primary" onClick={() => void saveProfile()} disabled={busy === "profile" || !displayName.trim()}>{busy === "profile" ? <SpinnerGap className="spin" /> : <Check />}保存资料</button>
            </div>
          </div>
          <div className="settings-card compact-card">
            <div><strong>登录密码</strong><small>至少10个字符，建议使用独立密码。</small></div>
            <div className="inline-setting"><label><span className="sr-only">新密码</span><Key /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="输入新密码" /></label><button onClick={() => void savePassword()} disabled={busy === "password" || password.length < 10}>更新</button></div>
          </div>
          <div className="settings-card compact-card invite-accept-card">
            <div><strong>加入协作项目</strong><small>粘贴项目所有者发给你的邀请链接或邀请码。</small></div>
            <div className="inline-setting"><label><span className="sr-only">邀请链接或邀请码</span><Link /><input value={acceptCode} onChange={(event) => setAcceptCode(event.target.value)} placeholder="邀请链接或邀请码" /></label><button onClick={() => void acceptInvitation()} disabled={busy === "accept" || !invitationCode(acceptCode)}>接受邀请</button></div>
          </div>
        </section> : null}

        {tab === "project" ? <section className="settings-page">
          <PageTitle eyebrow="CURRENT PROJECT" title="当前项目" description={isProjectOwner ? "设置项目身份、团队总额度和排队上限。" : "你可以查看项目信息；只有项目负责人可以修改。"} />
          <div className="settings-card project-profile-card">
            <AvatarUpload value={projectImage} onChange={setProjectImage} disabled={!isProjectOwner} label="上传项目头像" notify={notify}><Avatar color={projectColor} image={projectImage} name={projectName || project.name} large square /></AvatarUpload>
            <div className="settings-form-grid">
              <label><span>项目名称</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} readOnly={!isProjectOwner} /></label>
              <label><span>我的角色</span><input value={roleText(project.current_user_role || "viewer")} readOnly /></label>
              <fieldset className="color-field" disabled={!isProjectOwner}><legend>项目头像颜色</legend><ColorPicker value={projectColor} onChange={setProjectColor} /></fieldset>
            </div>
          </div>
          <div className="settings-card settings-two-column">
            <label><span>团队月度运行分钟</span><input type="number" min={0} step={1} value={projectLimit} onChange={(event) => setProjectLimit(event.target.value)} readOnly={!isProjectOwner} placeholder="不限制" /><small>留空不限额；按北京时间自然月，超额不打断已运行任务。</small></label>
            <label><span>项目排队任务上限</span><input type="number" min={1} max={500} value={projectQueueLimit} onChange={(event) => setProjectQueueLimit(event.target.value)} readOnly={!isProjectOwner} /><small>限制排队与运行中的任务总数，保护本机稳定性。</small></label>
          </div>
          <div className="settings-card storage-card"><div><strong>本地存储分区</strong><small>新增输入与输出固定归档至创建者的项目分区；协作者只通过权限访问。</small></div><code title={project.storage_root}>{project.storage_root || "路径由本机服务自动管理"}</code></div>
          {isProjectOwner ? <div className="settings-actions"><button className="settings-primary" onClick={() => void saveProject()} disabled={busy === "project" || !projectName.trim()}>{busy === "project" ? <SpinnerGap className="spin" /> : <Check />}保存项目设置</button></div> : null}
        </section> : null}

        {tab === "members" ? <section className="settings-page">
          <PageTitle eyebrow="COLLABORATION" title="成员与邀请" description={`${project.name} · ${members.length} 名成员`} />
          <div className="role-guide" aria-label="项目角色权限说明">
            <span><strong>负责人</strong><small>项目设置、成员、额度与全部创作权限</small></span>
            <span><strong>制作</strong><small>编辑画布、素材与提交生成任务</small></span>
            <span><strong>审核</strong><small>查看内容并进行预览审批</small></span>
            <span><strong>查看</strong><small>只读审片与下载授权内容</small></span>
          </div>
          {isProjectOwner ? <div className="settings-card invite-create-v2">
            <div><strong>邀请成员</strong><small>邀请与邮箱绑定，7天内有效且仅可使用一次。</small></div>
            <div className="invite-fields-v2">
              <input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="成员邮箱" />
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as ProjectMember["role"])}><option value="editor">制作成员</option><option value="reviewer">审核成员</option><option value="viewer">查看成员</option></select>
              <button className="settings-primary" onClick={() => void createInvite()} disabled={busy === "invite" || !inviteEmail.trim()}>{busy === "invite" ? <SpinnerGap className="spin" /> : <Link />}生成邀请</button>
            </div>
            {lastInviteLink ? <button className="invite-copy-v2" onClick={async () => { try { await navigator.clipboard.writeText(lastInviteLink); notify("邀请链接已复制。", "success"); } catch { notify("浏览器未允许复制，请检查剪贴板权限。", "danger"); } }}><Copy />复制刚生成的邀请链接</button> : null}
          </div> : null}
          <div className="member-list-v2">
            {members.map((member) => <MemberRow key={member.id} member={member} currentUserId={user.id} editable={isProjectOwner} onSave={updateMember} onRemove={removeMember} notify={notify} />)}
          </div>
          {isProjectOwner && invitations.length ? <section className="pending-invites"><header><strong>待接受邀请</strong><small>{invitations.filter((item) => item.active).length} 个有效</small></header>{invitations.map((invite) => <article key={invite.id}><Ticket /><span><strong>{invite.email || "未绑定邮箱"}</strong><small>{roleText(invite.project_role)} · {invite.active ? `有效至 ${shortDate(invite.expires_at)}` : "已失效"}</small></span>{invite.active ? <button aria-label={`撤销${invite.email || "邀请"}`} onClick={async () => { try { await workbenchApi.revokeInvitation(invite.id); setInvitations((current) => current.map((item) => item.id === invite.id ? { ...item, active: false } : item)); notify("邀请已撤销。", "success"); } catch (reason) { notify(errorMessage(reason), "danger"); } }}><Trash /></button> : <em>失效</em>}</article>)}</section> : null}
        </section> : null}

        {tab === "my-usage" ? <section className="settings-page"><PageTitle eyebrow="MY USAGE" title="我的用量" description="最近30天，跨你有权访问的所有项目统计。" /><UsagePanel usage={accountUsage} /></section> : null}

        {tab === "project-usage" ? <section className="settings-page">
          <PageTitle eyebrow="PROJECT USAGE" title="项目用量" description={`${project.name} · 最近30天`} />
          <div className="usage-scope-switch"><span>团队总计</span><strong>{formatMinutes(projectUsage?.project.compute_seconds)} 运行分钟</strong><span>我的用量</span><strong>{formatMinutes(projectUsage?.mine.compute_seconds)} 运行分钟</strong></div>
          <UsagePanel usage={projectUsage?.project || null} />
          <div className="usage-limit-strip"><span><small>项目月额度</small><strong>{limitText(projectUsage?.limits.project_monthly_compute_seconds)}</strong></span><span><small>我的月额度</small><strong>{limitText(projectUsage?.limits.member_monthly_compute_seconds)}</strong></span><span><small>项目排队上限</small><strong>{projectUsage?.limits.project_max_active_jobs ?? "不限"}</strong></span><span><small>我的排队上限</small><strong>{projectUsage?.limits.member_max_active_jobs ?? "不限"}</strong></span></div>
        </section> : null}
      </main>
    </section>
  </div>;
}

function MemberRow({ member, currentUserId, editable, onSave, onRemove, notify }: {
  member: ProjectMember;
  currentUserId: string;
  editable: boolean;
  onSave: (member: ProjectMember, patch: Parameters<typeof workbenchApi.updateProjectMember>[2]) => Promise<void>;
  onRemove: (member: ProjectMember) => Promise<void>;
  notify: (message: string, tone?: "default" | "success" | "danger") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState(member.role);
  const [quota, setQuota] = useState(member.monthly_compute_seconds_limit == null ? "" : String(Math.round(member.monthly_compute_seconds_limit / 60)));
  const [queueLimit, setQueueLimit] = useState(String(member.max_active_jobs || 50));
  const [priority, setPriority] = useState(String(member.queue_priority || 3));

  useEffect(() => {
    setRole(member.role);
    setQuota(member.monthly_compute_seconds_limit == null ? "" : String(Math.round(member.monthly_compute_seconds_limit / 60)));
    setQueueLimit(String(member.max_active_jobs || 50));
    setPriority(String(member.queue_priority || 3));
  }, [member]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(member, {
        role,
        monthly_compute_minutes_limit: quota.trim() === "" ? null : wholeNumber(quota, 0, 1_000_000, "月度运行分钟"),
        max_active_jobs: wholeNumber(queueLimit, 1, 500, "排队上限"),
        queue_priority: wholeNumber(priority, 1, 5, "优先级"),
      });
      setExpanded(false);
    } catch (reason) { notify(errorMessage(reason), "danger"); }
    finally { setSaving(false); }
  };

  return <article className={`member-row-v2 ${expanded ? "expanded" : ""}`}>
    <button className="member-summary" onClick={() => editable && setExpanded((value) => !value)} aria-expanded={editable ? expanded : undefined}>
      <Avatar color={member.avatar_color} image={member.avatar_image} name={member.name} />
      <span><strong>{member.name}{member.id === currentUserId ? "（你）" : ""}</strong><small>{member.email || "项目成员"}</small></span>
      <em>{roleText(member.role)}</em>
      {typeof member.month_compute_seconds === "number" ? <span className="member-usage"><strong>{formatMinutes(member.month_compute_seconds)}m</strong><small>本月运行</small></span> : null}
      {editable ? <GearSix /> : null}
    </button>
    {expanded && editable ? <div className="member-editor">
      <label><span>项目角色</span><select value={role} onChange={(event) => setRole(event.target.value as ProjectMember["role"])}><option value="owner">项目负责人</option><option value="editor">制作成员</option><option value="reviewer">审核成员</option><option value="viewer">查看成员</option></select></label>
      <label><span>月度运行分钟</span><input type="number" min={0} step={1} value={quota} onChange={(event) => setQuota(event.target.value)} placeholder="不限" /></label>
      <label><span>排队任务上限</span><input type="number" min={1} max={500} value={queueLimit} onChange={(event) => setQueueLimit(event.target.value)} /></label>
      <label><span>队列优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="1">1 · 最低</option><option value="2">2 · 较低</option><option value="3">3 · 标准</option><option value="4">4 · 较高</option><option value="5">5 · 最高</option></select></label>
      <div className="member-editor-actions">{member.role !== "owner" ? <button className="danger-text" onClick={() => void onRemove(member)}><Trash />移除成员</button> : <small>项目必须保留至少一名负责人</small>}<button onClick={() => setExpanded(false)}>取消</button><button className="settings-primary" onClick={() => void save()} disabled={saving}>{saving ? <SpinnerGap className="spin" /> : <Check />}保存</button></div>
    </div> : null}
  </article>;
}

function UsagePanel({ usage }: { usage: UsageSummary | null }) {
  if (!usage) return <div className="usage-empty"><SpinnerGap className="spin" /><span>正在读取用量</span></div>;
  const successRate = usage.job_count ? Math.round((usage.succeeded_jobs / usage.job_count) * 100) : 0;
  const days = usage.daily.slice(-30);
  const maxSeconds = Math.max(1, ...days.map((item) => Number(item.compute_seconds) || 0));
  return <>
    <div className="usage-metrics">
      <article><small>任务运行时长</small><strong>{formatMinutes(usage.compute_seconds)}</strong><em>分钟 · 不含排队</em></article>
      <article><small>生成任务</small><strong>{usage.job_count}</strong><em>成功率 {successRate}%</em></article>
      <article><small>失败任务</small><strong>{usage.failed_jobs}</strong><em>运行中/排队 {usage.queued_jobs}</em></article>
      <article><small>登记资产</small><strong>{formatBytes(usage.storage_bytes)}</strong><em>上传与生成素材</em></article>
    </div>
    <div className="usage-chart-card">
      <header><div><strong>每日运行用量</strong><small>最近30天 · 北京时间</small></div><span>运行分钟</span></header>
      {days.length ? <div className="usage-bars" role="img" aria-label="最近30天每日任务运行时长柱状图">{days.map((item) => <span key={item.day} title={`${item.day} · ${formatMinutes(item.compute_seconds)} 运行分钟`}><i style={{ height: `${Math.max(4, (Number(item.compute_seconds) / maxSeconds) * 100)}%` }} /><small>{new Date(`${item.day}T00:00:00`).getDate()}</small></span>)}</div> : <div className="usage-chart-empty">还没有生成记录</div>}
    </div>
    <p className="usage-method-note">运行时长按任务开始至结束计，包含模型加载和处理时间，不是显卡活跃率或理论算力。失败与取消任务的已用时间也计入；存储仅统计已登记素材。</p>
  </>;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="settings-page-title"><small>{eyebrow}</small><h2>{title}</h2><p>{description}</p></header>;
}

function Avatar({ color, image, name, large = false, square = false }: { color?: string; image?: string; name: string; large?: boolean; square?: boolean }) {
  return <span className={`identity-avatar ${large ? "large" : ""} ${square ? "square" : ""}`} style={{ background: color || AVATAR_COLORS[0] }} aria-hidden="true">{image ? <img src={image} alt="" /> : name.trim().slice(0, 1).toUpperCase() || "·"}</span>;
}

function ColorPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="avatar-colors">{AVATAR_COLORS.map((color) => <button type="button" key={color} className={value.toLowerCase() === color.toLowerCase() ? "active" : ""} style={{ background: color }} aria-label={`选择头像颜色 ${color}`} aria-pressed={value.toLowerCase() === color.toLowerCase()} onClick={() => onChange(color)}>{value.toLowerCase() === color.toLowerCase() ? <Check weight="bold" /> : null}</button>)}</div>;
}

function roleText(role: string) {
  return ({ owner: "项目负责人", editor: "制作成员", reviewer: "审核成员", viewer: "查看成员" } as Record<string, string>)[role] || role;
}

function invitationCode(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return "";
  try { return new URL(cleaned).searchParams.get("invite") || cleaned; }
  catch { return cleaned; }
}

function formatMinutes(seconds?: number | null) {
  const minutes = Math.max(0, Number(seconds || 0) / 60);
  return minutes < 10 ? minutes.toFixed(1) : Math.round(minutes).toLocaleString("zh-CN");
}

function formatBytes(bytes?: number | null) {
  const value = Math.max(0, Number(bytes || 0));
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function limitText(seconds?: number | null) {
  return seconds == null ? "不限" : `${formatMinutes(seconds)} 分钟`;
}

function shortDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function wholeNumber(value: string, min: number, max: number, label: string) {
  const number = Number(value);
  if (!value.trim() || !Number.isInteger(number) || number < min || number > max) throw new Error(`${label}请输入 ${min}—${max} 之间的整数。`);
  return number;
}
