import {
  Books,
  CaretDown,
  Check,
  CheckCircle,
  CloudSlash,
  FolderOpen,
  Images,
  ListChecks,
  MagnifyingGlass,
  Play,
  Plus,
  SpinnerGap,
  UploadSimple,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser, Capabilities, Project, UsageSummary } from "../types";

interface HeaderBarProps {
  projects: Project[];
  projectId: string;
  capabilities: Capabilities | null;
  accountUsage: UsageSummary | null;
  queueCount: number;
  onProjectChange: (id: string) => void;
  onCreateProject: () => void;
  onManageProjects: () => void;
  onOpenAssets: () => void;
  onUpload: () => void;
  onBatchFinal: () => void;
  onStartRuntime: () => Promise<void>;
  runtimeStarting: boolean;
  user: AuthUser;
  onOpenAccount: () => void;
  canCreateProjects: boolean;
  canEditProject: boolean;
}

export function HeaderBar({
  projects,
  projectId,
  capabilities,
  accountUsage,
  queueCount,
  onProjectChange,
  onCreateProject,
  onManageProjects,
  onOpenAssets,
  onUpload,
  onBatchFinal,
  onStartRuntime,
  runtimeStarting,
  user,
  onOpenAccount,
  canCreateProjects,
  canEditProject,
}: HeaderBarProps) {
  const [resourceOpen, setResourceOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const switcherRef = useRef<HTMLDivElement>(null);
  const resourceRef = useRef<HTMLDivElement>(null);
  const providers = capabilities?.providers || {};
  const currentProject = projects.find((project) => project.id === projectId) || projects[0];
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    return query ? projects.filter((project) => project.name.toLocaleLowerCase().includes(query)) : projects;
  }, [projectQuery, projects]);
  const ownedProjects = filteredProjects.filter((project) => project.scope !== "shared");
  const sharedProjects = filteredProjects.filter((project) => project.scope === "shared");
  const providerList = [
    ["H3", providers.h3?.ready],
    ["图像", providers.image?.ready],
    ["TTS", providers.tts?.ready],
    ["Music", providers.music?.ready],
    ["LLM", providers.agent?.ready],
  ] as const;

  useEffect(() => {
    if (!projectOpen && !resourceOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) setProjectOpen(false);
      if (!resourceRef.current?.contains(event.target as Node)) setResourceOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setProjectOpen(false); setResourceOpen(false); } };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("pointerdown", closeOnOutsideClick); window.removeEventListener("keydown", closeOnEscape); };
  }, [projectOpen, resourceOpen]);

  const selectProject = (id: string) => {
    setProjectOpen(false);
    setProjectQuery("");
    if (id !== projectId) onProjectChange(id);
  };

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-symbol"><CheckCircle weight="duotone" /></span>
        <span><strong>擎光绘影</strong><small>AIGC数字影像创作平台 · CLSF AI. Lab Studio</small></span>
        <em>LOCAL</em>
      </div>

      <div className="project-switcher-v2" ref={switcherRef}>
        <button
          className="project-switcher-trigger"
          onClick={() => setProjectOpen((value) => !value)}
          aria-haspopup="listbox"
          aria-expanded={projectOpen}
          title="切换画布 / 项目"
        >
          <span className="project-avatar-mini" style={{ background: currentProject?.avatar_color || "#d86baa" }}>
            {currentProject?.avatar_image ? <img src={currentProject.avatar_image} alt="" /> : currentProject?.name?.slice(0, 1).toLocaleUpperCase() || "项"}
          </span>
          <span className="project-switcher-copy">
            <strong>{currentProject?.name || "选择项目"}</strong>
            <small>{currentProject?.scope === "shared" ? "受邀项目" : "我的项目"}</small>
          </span>
          <CaretDown weight="bold" />
        </button>

        {projectOpen ? (
          <div className="project-switcher-popover" role="listbox" aria-label="画布与项目">
            <label className="project-search">
              <MagnifyingGlass />
              <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="搜索项目" autoFocus />
            </label>
            <ProjectSection title="我的项目" projects={ownedProjects} activeId={projectId} onSelect={selectProject} />
            <ProjectSection title="受邀项目" projects={sharedProjects} activeId={projectId} onSelect={selectProject} />
            {!filteredProjects.length ? <p className="project-switcher-empty">没有匹配的项目</p> : null}
            <footer className="project-switcher-footer">
              {canCreateProjects ? <button onClick={() => { setProjectOpen(false); onCreateProject(); }}><Plus />新建项目</button> : null}
              <button onClick={() => { setProjectOpen(false); onManageProjects(); }}><FolderOpen />管理项目</button>
            </footer>
          </div>
        ) : null}
      </div>

      <div className="provider-row" aria-label="本地模型状态">
        {providerList.map(([name, ready]) => <span className={ready ? "ready" : ""} key={name}>{ready ? <i /> : <CloudSlash />}{name}</span>)}
      </div>

      <div className="top-actions">
        {canEditProject && (!providers.h3?.ready || !providers.image?.ready) ? <button className="runtime-button" onClick={() => void onStartRuntime()} disabled={runtimeStarting}>{runtimeStarting ? <SpinnerGap className="spin" /> : <Play weight="fill" />}{runtimeStarting ? "启动中" : "启动生成引擎"}</button> : null}
        <div className="resource-center-wrap" ref={resourceRef}>
          <button className="resource-center-button" onClick={() => setResourceOpen((value) => !value)} aria-expanded={resourceOpen}><Books weight="duotone" />资源中心<CaretDown /></button>
          {resourceOpen ? <div className="resource-center-menu">
            <header><strong>常用工作入口</strong><small>素材、项目与交付集中管理</small></header>
            <button onClick={() => { onOpenAssets(); setResourceOpen(false); }}><Images weight="duotone" /><span><strong>项目资产</strong><small>分类、搜索、拖入画布</small></span></button>
            {canEditProject ? <button onClick={() => { onUpload(); setResourceOpen(false); }}><UploadSimple /><span><strong>导入素材</strong><small>图片、视频、音频或文本</small></span></button> : null}
            <button onClick={() => { onManageProjects(); setResourceOpen(false); }}><FolderOpen weight="duotone" /><span><strong>项目管理</strong><small>分组、移动、重命名与回收站</small></span></button>
            {canEditProject ? <button onClick={() => { onBatchFinal(); setResourceOpen(false); }}><ListChecks weight="duotone" /><span><strong>终稿队列{queueCount ? ` · ${queueCount}` : ""}</strong><small>审批通过后统一生成终稿</small></span></button> : null}
          </div> : null}
        </div>
        <button className="account-trigger account-trigger-v2" onClick={onOpenAccount} title="个人、团队与用量设置">
          <span className="account-avatar-mini" style={{ background: user.avatar_color || "#d86baa" }}>{user.avatar_image ? <img src={user.avatar_image} alt="" /> : user.name.slice(0, 1).toLocaleUpperCase()}</span>
          <span className="account-trigger-copy"><strong>{user.name}</strong><small>{formatHeaderUsage(accountUsage)}</small></span>
          <CaretDown />
        </button>
      </div>
    </header>
  );
}

function ProjectSection({ title, projects, activeId, onSelect }: { title: string; projects: Project[]; activeId: string; onSelect: (id: string) => void }) {
  if (!projects.length) return null;
  return (
    <section className="project-switcher-section">
      <h3>{title}</h3>
      {projects.map((project) => (
        <button className={project.id === activeId ? "project-switcher-row is-active" : "project-switcher-row"} key={project.id} onClick={() => onSelect(project.id)} role="option" aria-selected={project.id === activeId}>
          <span className="project-avatar-mini" style={{ background: project.avatar_color || "#64748b" }}>{project.avatar_image ? <img src={project.avatar_image} alt="" /> : project.name.slice(0, 1).toLocaleUpperCase()}</span>
          <span><strong>{project.name}</strong><small>{roleLabel(project.current_user_role)}</small></span>
          {project.id === activeId ? <Check weight="bold" /> : null}
        </button>
      ))}
    </section>
  );
}

function roleLabel(role?: Project["current_user_role"]) {
  if (role === "owner") return "所有者";
  if (role === "editor") return "可编辑";
  if (role === "reviewer") return "可审核";
  return "仅查看";
}

function formatHeaderUsage(usage: UsageSummary | null) {
  if (!usage) return "账户与用量";
  const minutes = usage.compute_seconds / 60;
  const value = minutes >= 100 ? Math.round(minutes).toLocaleString("zh-CN") : minutes.toFixed(minutes >= 10 ? 0 : 1);
  return `${value} 运行分钟${usage.queued_jobs ? ` · ${usage.queued_jobs} 排队` : ""}`;
}
