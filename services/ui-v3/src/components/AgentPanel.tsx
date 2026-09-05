import { Brain, CaretDown, ClockCounterClockwise, PaperPlaneRight, Plus, Question, SidebarSimple, Sparkle, SquaresFour, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { Capabilities, Job, WorkbenchNode } from "../types";

interface AgentPanelProps {
  capabilities: Capabilities | null;
  selectedNodes: WorkbenchNode[];
  jobs: Job[];
  onSend: (prompt: string, modelId: string, auto: boolean) => Promise<void>;
  onDeselect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  readOnly: boolean;
}

const AGENT_EXAMPLES = [
  "根据已选人物和场景，规划 3 个连续镜头，并说明每个镜头应使用的节点。",
  "检查当前工作流的素材类型和连接关系，指出会导致生成失败的地方。",
  "把已选视频节点的提示词整理成 H3-IR 导演指令，保持角色身份和台词不变。",
];

export function AgentPanel({ capabilities, selectedNodes, jobs, onSend, onDeselect, collapsed, onToggleCollapsed, readOnly }: AgentPanelProps) {
  const models = capabilities?.providers?.agent?.models || [];
  const [modelId, setModelId] = useState(capabilities?.providers?.agent?.default_model || "qwen3.6-27b-q4");
  const [auto, setAuto] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const agentJobs = useMemo(() => jobs.filter((job) => job.type === "agent.chat" || job.type === "agent.h3_ir").slice(0, 3), [jobs]);
  const submit = async () => {
    if (!prompt.trim() || busy || readOnly) return;
    setBusy(true);
    try { await onSend(prompt.trim(), modelId, auto); setPrompt(""); } finally { setBusy(false); }
  };
  const startNewSession = () => {
    setPrompt("");
    setAddOpen(false);
    setHelpOpen(false);
  };
  if (collapsed) return <aside className="agent-panel agent-collapsed"><button onClick={onToggleCollapsed} aria-label="展开制作 Agent" title="展开制作 Agent"><Brain weight="duotone" /><span>Agent</span><SidebarSimple /></button></aside>;
  return <aside className="agent-panel">
    <header className="agent-header"><div><span className="agent-icon"><Brain weight="duotone" /></span><span><strong>制作 Agent</strong><small>画布上下文助手</small></span></div><span className="agent-header-actions"><button onClick={() => setHelpOpen((value) => !value)} aria-label="查看使用说明" aria-expanded={helpOpen} title="使用说明"><Question /></button><button onClick={onToggleCollapsed} aria-label="收起到侧边栏" title="收起 Agent"><SidebarSimple /></button><button onClick={startNewSession} aria-label="新建会话" title="清空输入并新建会话"><Plus /></button></span></header>
    <div className="agent-toolbar">
      <label className="agent-model"><Sparkle weight="fill" /><select value={modelId} onChange={(event) => setModelId(event.target.value)} aria-label="Agent 模型">{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><CaretDown /></label>
      <button className={`confirm-mode ${auto ? "auto" : "manual"}`} onClick={() => setAuto((value) => !value)} aria-pressed={auto} aria-label={auto ? "当前为自动执行，点击切换为手动确认" : "当前为手动确认，点击切换为自动执行"} disabled={readOnly}>{readOnly ? "只读审片" : auto ? "自动执行" : "手动确认"}</button>
    </div>
    {helpOpen ? <section className="agent-help">
      <header><strong>三步使用 Agent</strong><button onClick={() => setHelpOpen(false)} aria-label="关闭说明"><X /></button></header>
      <ol><li>先在画布点选需要分析的素材或节点</li><li>使用手动确认检查方案；需要时再切换自动执行</li><li>发送前可从下方示例快速开始</li></ol>
      <div>{AGENT_EXAMPLES.map((example) => <button key={example} onClick={() => { setPrompt(example); setHelpOpen(false); }}>{example}</button>)}</div>
    </section> : null}
    <section className="agent-thread">
      <div className="agent-welcome"><span><Brain weight="duotone" /></span><h2>让灵感在画布上继续生长</h2><p>选择素材后，我可以规划镜头、优化提示词并创建工作流。手动确认模式不会直接占用 GPU。</p></div>
      {selectedNodes.length ? <div className="agent-context"><header><SquaresFour />已引用画布内容 <span>{selectedNodes.length}</span></header><div>{selectedNodes.slice(0, 4).map((node) => <span key={node.id}>@{node.data.title}<button onClick={() => onDeselect(node.id)} aria-label="移除引用"><X /></button></span>)}</div></div> : null}
      {agentJobs.map((job) => <div className="agent-history-card" key={job.id}><ClockCounterClockwise /><div><strong>{job.type === "agent.h3_ir" ? "H3-IR · 本地导演指令增强" : String(job.params.prompt || "Agent 任务").slice(0, 42)}</strong><span title={job.error || undefined}>{job.status === "succeeded" ? "已完成" : job.status === "failed" ? "失败 · 原配置未修改" : job.status === "cancelled" ? "已取消" : job.status === "running" ? "本地推理中" : "已加入队列"}</span></div></div>)}
    </section>
    <footer className="agent-composer">
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={readOnly ? "当前项目为只读审片模式" : "让 Agent 规划工作流，或使用 @ 引用素材…"} aria-label="Agent 指令" disabled={readOnly} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
      <div><span className="agent-add-wrap"><button onClick={() => setAddOpen((value) => !value)} aria-label="查看画布上下文添加方式" aria-expanded={addOpen} disabled={readOnly}><Plus /></button>{addOpen ? <span className="agent-add-menu" role="note"><span className="agent-add-hint"><SquaresFour /><span><strong>画布内容自动加入</strong><small>先选中素材或节点，它们会显示在输入框上方；无需再次上传。</small></span></span></span> : null}</span><small>{readOnly ? "仅浏览与审片" : auto ? "允许自动创建节点" : "生成前向你确认"}</small><button className="agent-send" onClick={submit} disabled={readOnly || !prompt.trim() || busy} aria-label={busy ? "Agent 正在处理" : "发送给 Agent"}><PaperPlaneRight weight="fill" /></button></div>
    </footer>
  </aside>;
}
