import { ArrowCounterClockwise, Folder, FolderPlus, PencilSimple, Trash, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { Project, ProjectGroup } from "../types";
import { InlineNameEditor } from "./InlineNameEditor";

interface ProjectManagerProps {
  open: boolean;
  projects: Project[];
  groups: ProjectGroup[];
  currentProjectId: string;
  onClose: () => void;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (project: Project, name: string) => void;
  onMove: (projectId: string, groupId: string | null) => void;
  onTrash: (project: Project) => void;
  onRestore: (project: Project) => void;
  onCreateGroup: () => void;
  onRenameGroup: (group: ProjectGroup, name: string) => void;
  onDeleteGroup: (group: ProjectGroup) => void;
  canCreateProjects: boolean;
}

export function ProjectManager(props: ProjectManagerProps) {
  const [showTrash, setShowTrash] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const active = useMemo(() => props.projects.filter((project) => !project.deleted_at), [props.projects]);
  const owned = useMemo(() => active.filter((project) => project.scope !== "shared"), [active]);
  const shared = useMemo(() => active.filter((project) => project.scope === "shared"), [active]);
  const trashed = useMemo(() => props.projects.filter((project) => project.deleted_at && project.current_user_role === "owner"), [props.projects]);
  if (!props.open) return null;

  const sections = [
    ...props.groups.map((group) => ({ id: group.id, label: group.name, projects: owned.filter((project) => project.group_id === group.id), group, shared: false })),
    { id: "ungrouped", label: "未分组", projects: owned.filter((project) => !project.group_id || !props.groups.some((group) => group.id === project.group_id)), group: null, shared: false },
    ...(shared.length ? [{ id: "shared", label: "受邀项目", projects: shared, group: null, shared: true }] : []),
  ];
  const canOwn = (project: Project) => project.current_user_role === "owner";

  return <div className="project-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section className="project-manager" role="dialog" aria-modal="true" aria-label="项目管理">
      <header>
        <div><small>PROJECT LIBRARY</small><strong>项目管理</strong><span>整理画布项目，不会移动或复制底层模型文件</span></div>
        <button onClick={props.onClose} aria-label="关闭项目管理"><X /></button>
      </header>
      <nav>
        <button className={!showTrash ? "active" : ""} onClick={() => setShowTrash(false)}><Folder />项目 {active.length}</button>
        <button className={showTrash ? "active" : ""} onClick={() => setShowTrash(true)}><Trash />回收站 {trashed.length}</button>
        <span />
        {!showTrash && props.canCreateProjects ? <><button onClick={props.onCreateGroup}><FolderPlus />新建分组</button><button className="primary" onClick={props.onCreate}>＋ 新建项目</button></> : null}
      </nav>

      <div className="project-manager-content">
        {showTrash ? <div className="project-list trash-list">
          {trashed.length ? trashed.map((project) => <article key={project.id}>
            <span className="project-avatar">{project.name.slice(0, 1)}</span>
            <div><strong>{project.name}</strong><small>已移至回收站 · 画布与素材仍保留</small></div>
            {canOwn(project) ? <button onClick={() => props.onRestore(project)}><ArrowCounterClockwise />恢复</button> : null}
          </article>) : <div className="project-empty"><Trash /><strong>回收站为空</strong><span>删除的项目会先保留在这里</span></div>}
        </div> : sections.map((section) => <section className="project-section" key={section.id}>
          <header>
            <span><Folder weight="duotone" />{section.group ? (props.canCreateProjects ? <InlineNameEditor value={section.group.name} editing={editingGroupId === section.group.id} onEditingChange={(editing) => setEditingGroupId(editing ? section.group!.id : null)} onCommit={(name) => props.onRenameGroup(section.group!, name)} ariaLabel="项目分组名称" /> : <strong>{section.group.name}</strong>) : <strong>{section.label}</strong>}<small>{section.projects.length}</small></span>
            {section.group && props.canCreateProjects ? <div><button onClick={() => setEditingGroupId(section.group!.id)} title="原位重命名分组"><PencilSimple /></button><button onClick={() => props.onDeleteGroup(section.group!)} title="删除分组，项目将移至未分组"><Trash /></button></div> : null}
          </header>
          <div className="project-list">
            {section.projects.map((project) => <article className={project.id === props.currentProjectId ? "current" : ""} key={project.id}>
              <div className="project-open" role="button" tabIndex={0} onClick={() => props.onSwitch(project.id)} onKeyDown={(event) => { if (event.key === "Enter") props.onSwitch(project.id); }}>
                <span className="project-avatar">{project.name.slice(0, 1)}</span>
                <span>{canOwn(project) ? <InlineNameEditor value={project.name} editing={editingProjectId === project.id} onEditingChange={(editing) => setEditingProjectId(editing ? project.id : null)} onCommit={(name) => props.onRename(project, name)} ariaLabel="项目名称" /> : <strong>{project.name}</strong>}<small>{project.id === props.currentProjectId ? "当前打开" : section.shared ? `受邀 · ${projectRoleLabel(project.current_user_role)}` : `更新于 ${new Date(project.updated_at).toLocaleDateString("zh-CN")}`}</small></span>
              </div>
              {canOwn(project) ? <select aria-label={`移动${project.name}到分组`} value={project.group_id || ""} onChange={(event) => props.onMove(project.id, event.target.value || null)}>
                <option value="">未分组</option>
                {props.groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
              </select> : <span />}
              {canOwn(project) ? <button onClick={() => setEditingProjectId(project.id)} aria-label={`原位重命名${project.name}`}><PencilSimple /></button> : null}
              {canOwn(project) ? <button className="danger" disabled={project.id === "default"} onClick={() => props.onTrash(project)} aria-label={`删除${project.name}`}><Trash /></button> : null}
            </article>)}
            {!section.projects.length ? <div className="project-section-empty">把项目移动到此分组后会显示在这里</div> : null}
          </div>
        </section>)}
      </div>
    </section>
  </div>;
}

function projectRoleLabel(role?: Project["current_user_role"]) {
  if (role === "owner") return "项目负责人";
  if (role === "editor") return "制作成员";
  if (role === "reviewer") return "审核成员";
  return "查看成员";
}
