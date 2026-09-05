import { Brain, CaretDown, PaperPlaneRight, Plus, Question, SidebarSimple, Sparkle, X } from "@phosphor-icons/react";
import { useState } from "react";
import type { Asset, Capabilities, Job, WorkbenchNode } from "../types";
import type { AgentRequest, ProductionRun, StoryboardPlan } from "../storyboard";
import type { PromptBindings } from "../prompt-assist";
import { PromptEditor } from "./PromptEditor";

interface AgentPanelProps {
  capabilities: Capabilities | null; selectedNodes: WorkbenchNode[]; assets: Asset[]; contextAssetIds: string[];
  jobs: Job[]; productions: ProductionRun[];
  onSend: (request: AgentRequest) => Promise<void>;
  onMaterialize: (job: Job) => void;
  onExecute: (job: Job, score: boolean) => Promise<void>;
  onControl: (run: ProductionRun, action: "cancel" | "resume") => Promise<void>;
  onShowProduction: (run: ProductionRun) => void;
  onDeselect: (id: string) => void; collapsed: boolean; onToggleCollapsed: () => void; readOnly: boolean;
}
const stateLabels: Record<string, string> = {queued: "排队中", running: "本地推理中", succeeded: "已完成", failed: "失败", cancelled: "已取消", active: "制作中", paused: "已暂停"};

export function CreativeAgentPanel({capabilities, selectedNodes, assets, contextAssetIds, jobs, productions, onSend, onMaterialize, onExecute, onControl, onShowProduction, onDeselect, collapsed, onToggleCollapsed, readOnly}: AgentPanelProps) {
  const models = capabilities?.providers?.agent?.models || [];
  const [modelId, setModelId] = useState(capabilities?.providers?.agent?.default_model || "qwen3.6-27b-q4");
  const [skill, setSkill] = useState<"chat" | "storyboard">("storyboard");
  const [prompt, setPrompt] = useState("");
  const [bindings, setBindings] = useState<PromptBindings>({});
  const [attached, setAttached] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [duration, setDuration] = useState(30);
  const [steps, setSteps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const [confirmJob, setConfirmJob] = useState<Job | null>(null);
  const [includeScore, setIncludeScore] = useState(false);
  const ids = [...new Set([...contextAssetIds, ...attached])].filter(id => !excluded.includes(id) && assets.some(asset => asset.id === id && asset.kind === "image"));
  const agentJobs = jobs.filter(job => job.type.startsWith("agent.")).slice(0, 20);
  const action = async (callback: () => Promise<void>) => { if (busy || readOnly) return; setBusy(true); setError(""); try { await callback(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { setBusy(false); } };
  const submit = () => action(async () => {
    if (!prompt.trim()) return;
    if (!capabilities?.providers?.agent?.ready) throw new Error("本地 Agent 模型尚未就绪，请先检查模型服务。");
    if (ids.length > 9) throw new Error("最多引用 9 张图片，请先移除多余素材。");
    for (const [token, assetId] of Object.entries(bindings)) if (prompt.includes(token) && !ids.includes(assetId)) throw new Error(`引用已移除：${token}，请重新添加或删除该标记。`);
    await onSend({prompt: prompt.trim(), modelId, skill, duration, steps, assetIds: ids, descriptions});
    setPrompt(""); setBindings({});
  });
  if (collapsed) return <aside className="agent-panel agent-collapsed"><button onClick={onToggleCollapsed} aria-label="展开制作 Agent"><Brain weight="duotone" /><span>Agent</span><SidebarSimple /></button></aside>;
  return <aside className="agent-panel">
    <header className="agent-header"><div><span className="agent-icon"><Brain weight="duotone" /></span><span><strong>制作 Agent</strong><small>规划 · 制作 · 审片</small></span></div><span className="agent-header-actions"><button onClick={() => setHelp(!help)} aria-label="查看使用说明"><Question /></button><button onClick={onToggleCollapsed} aria-label="收起到侧边栏"><SidebarSimple /></button><button onClick={() => {setPrompt("");setBindings({});setAttached([]);setExcluded(contextAssetIds);setError("");}} aria-label="清空当前输入" title="清空输入，保留任务记录"><Plus /></button></span></header>
    <div className="agent-toolbar"><label className="agent-model"><Sparkle /><select value={modelId} onChange={event => setModelId(event.target.value)} aria-label="Agent 模型">{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select><CaretDown /></label><select value={skill} onChange={event => setSkill(event.target.value as typeof skill)} aria-label="Agent 能力"><option value="storyboard">分镜创作</option><option value="chat">创作问答</option></select></div>
    {help && <section className="agent-help"><header><strong>从素材到审片版</strong><button onClick={() => setHelp(false)} aria-label="关闭说明"><X /></button></header><ol><li>用 @ 添加图片，并补充角色与场景描述。</li><li>规划后审核镜头，再创建节点或确认生成审片版。</li><li>视频逐镜生成，可停止；已完成结果保留。</li></ol><p>规划也会使用本地 LLM / GPU。当前未接通图片视觉理解；声音说明不是实际音轨，可另外选择生成配乐。</p><button onClick={() => {setPrompt("基于参考素材，创作一段 30 秒逃亡戏。保持角色身份与服装一致，紧张克制，声音设计体现屏息与压迫感。分镜由发现危险、潜行、追逃、暂时藏身组成。请先列出方案供审核。");setSkill("storyboard");setDuration(30);setHelp(false);}}>填入逃亡戏示例（不自动提交）</button></section>}
    <section className="agent-thread">
      {!agentJobs.length && <div className="agent-welcome"><span><Brain /></span><h2>先确认镜头，再开始制作</h2><p>分镜结果、生成进度和审片文件会保留在当前项目。</p></div>}
      {selectedNodes.length > 0 && <div className="agent-context"><header>已选择的画布节点</header><div>{selectedNodes.map(node => <span key={node.id}>{node.data.title}<button onClick={() => onDeselect(node.id)} aria-label={`取消选择${node.data.title}`}><X /></button></span>)}</div></div>}
      {productions.map(run => <section className="production-card" key={run.id}>
        <strong>{run.payload.plan.title} · {stateLabels[run.status] || run.status}</strong>
        <p>{run.jobs.filter(job => job?.status === "succeeded").length}/{run.jobs.length} 步完成 · 已完成镜头保留</p>
        {run.error && <p role="status">{run.error}</p>}
        <div><button disabled={readOnly} onClick={() => onShowProduction(run)}>显示制作节点</button>
          {run.status === "active" && <button disabled={busy || readOnly} onClick={() => void action(() => onControl(run, "cancel"))}>停止制作</button>}
          {["paused", "cancelled"].includes(run.status) && <button disabled={busy || readOnly} onClick={() => void action(() => onControl(run, "resume"))}>继续 / 重试一次</button>}
        </div>
      </section>)}
      {agentJobs.map(job => {
        const plan = job.result?.storyboard as StoryboardPlan | undefined;
        return <article className="agent-response" key={job.id}><header><strong>{job.type === "agent.h3_ir" ? "H3-IR 导演增强" : job.type === "agent.storyboard" ? "分镜方案" : "创作问答"}</strong><span>{stateLabels[job.status] || job.status}</span></header>
          <p className="agent-user-brief">{String(job.params.brief || job.params.user_brief || job.params.prompt || "").slice(0, 240)}</p>
          {job.result?.text ? <details open={job === agentJobs[0]}><summary>查看完整结果</summary><div className="agent-response-text">{String(job.result.text)}</div></details> : null}
          {job.error && <details><summary>查看错误（未自动重试）</summary><pre>{job.error}</pre></details>}
          {plan && job.status === "succeeded" && <div className="agent-plan-actions"><button disabled={readOnly || busy} onClick={() => {try {onMaterialize(job);} catch (failure) {setError(String(failure));}}}>创建分镜节点</button><button disabled={readOnly || busy || productions.some(run => run.plan_job_id === job.id)} onClick={() => {setConfirmJob(job);setIncludeScore(false);}}>生成审片版…</button></div>}
        </article>;
      })}
    </section>
    <footer className="agent-composer agent-creative-composer">
      {ids.length > 0 && <details className="agent-reference-list"><summary>参考图片 {ids.length}/9 · 补充描述</summary>{ids.map(id => <div key={id}><label>{assets.find(asset => asset.id === id)?.name}<input aria-label={`素材描述 ${assets.find(asset => asset.id === id)?.name}`} placeholder="说明角色、服装、场景；当前未读取图片像素" value={descriptions[id] || ""} maxLength={2000} disabled={readOnly} onChange={event => setDescriptions({...descriptions,[id]:event.target.value})}/></label><button onClick={() => setExcluded([...excluded,id])} aria-label="移除 Agent 参考" disabled={readOnly}><X /></button></div>)}</details>}
      <PromptEditor value={prompt} bindings={bindings} onChange={(value, nextBindings) => {setPrompt(value);setBindings(nextBindings);}} kind="agent" assets={assets.filter(asset => asset.kind === "image")} onAttach={asset => {setAttached(current => [...new Set([...current,asset.id])]);setExcluded(current => current.filter(id => id !== asset.id));return true;}} disabled={readOnly || busy} label="Agent 指令" placeholder="描述你的创作目标；@ 引用图片，Ctrl+Enter 提交" onSubmit={() => void submit()} />
      <div className="agent-submit-row">{skill === "storyboard" && <><label>时长<select value={duration} disabled={busy} onChange={event => setDuration(Number(event.target.value))}>{[10,15,20,30,45,60].map(value => <option key={value} value={value}>{value}s</option>)}</select></label><label>采样<select value={steps} disabled={busy} onChange={event => setSteps(Number(event.target.value))}>{[20,30,40].map(value => <option key={value}>{value}</option>)}</select></label></>}<small>仅规划，不生成媒体</small><button className="agent-send" onClick={() => void submit()} disabled={readOnly || !prompt.trim() || busy || !capabilities?.providers?.agent?.ready} aria-label="发送给 Agent"><PaperPlaneRight /></button></div>
      {error && <p className="agent-inline-error" role="alert">{error}</p>}
    </footer>
    {confirmJob && <section className="agent-production-confirm" role="dialog" aria-label="确认审片制作范围"><header><strong>确认本次制作</strong><button onClick={() => setConfirmJob(null)} aria-label="取消制作确认"><X /></button></header><p>按此分镜方案生成 {String((confirmJob.result?.storyboard as StoryboardPlan).shots.length)} 个镜头，{String((confirmJob.result?.storyboard as StoryboardPlan).duration_seconds)} 秒，1344 × 768，{String((confirmJob.result?.storyboard as StoryboardPlan).settings.steps)} 步。单卡顺序执行，失败暂停。</p><p>以本条方案为准；已在画布单独修改的节点不回写此方案。尚未完成图片视觉理解和自动精确拟音，请先审核参考描述。</p><label><input type="checkbox" checked={includeScore} disabled={busy} onChange={event => setIncludeScore(event.target.checked)} />另外生成整片配乐（增加一个音乐任务）</label><button disabled={busy || readOnly} onClick={() => void action(async () => {await onExecute(confirmJob, includeScore);setConfirmJob(null);})}>{busy ? "正在提交…" : "确认并加入生产队列"}</button><button disabled={busy} onClick={() => setConfirmJob(null)}>返回检查方案</button>{error && <p role="alert">{error}</p>}</section>}
  </aside>;
}
