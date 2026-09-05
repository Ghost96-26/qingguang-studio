import {
  Aperture,
  ArrowsClockwise,
  CaretDown,
  Check,
  Copy,
  DotsThree,
  FilmSlate,
  Image as ImageIcon,
  MagicWand,
  MicrophoneStage,
  MusicNotes,
  NotePencil,
  PaintBrush,
  PencilSimple,
  Plus,
  SlidersHorizontal,
  Sparkle,
  SpinnerGap,
  Stack,
  Trash,
  UsersThree,
  VideoCamera,
  Waveform,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Handle, NodeResizer, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasFocus } from "../canvas-focus";
import { useCanvasStore } from "../canvas-store";
import { inputCapabilitySummary, inputPorts, mediaKind, mediaLabel, nextCompatiblePort, nodeConfigurationSignature, nodeLabels, outputKind } from "../model";
import { imageSamplingDefaults } from "../sampling";
import type { Asset, WorkbenchNode, WorkbenchParams } from "../types";
import { useWorkspace } from "../workspace-context";
import { AudioComposer } from "./AudioComposer";
import { DialogueComposer, parseDialogueLines } from "./DialogueComposer";
import { GenerationDetailPanel } from "./GenerationDetailPanel";
import { InlineNameEditor } from "./InlineNameEditor";
import { MaskEditor } from "./MaskEditor";
import { MediaPreview } from "./MediaPreview";
import { PromptEditor } from "./PromptEditor";
import { readPromptBindings } from "../prompt-assist";
import { videoGuidance } from "../video-options";
import { SamplingControls } from "./SamplingControls";
import { VideoControls } from "./VideoControls";

const iconByKind = {
  asset: ImageIcon,
  image_t2i: Aperture,
  image_i2i: ArrowsClockwise,
  image_edit: MagicWand,
  media_prepare: SlidersHorizontal,
  video: VideoCamera,
  tts: MicrophoneStage,
  dialogue: UsersThree,
  music: MusicNotes,
  sfx: Waveform,
  note: NotePencil,
  group: FilmSlate,
} as const;

const statusLabel: Record<string, string> = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };

function friendlyJobError(error?: string | null) {
  if (!error) return "生成未完成，请检查输入后重试。";
  if (/out of memory|allocation on device|cuda.*memory/i.test(error)) return "显存不足，生成引擎正在自动恢复。建议先用 5 秒预览或减少参考素材后重试。";
  if (/connectionreset|10054|connection refused|actively refused|remote.*closed/i.test(error)) return "生成引擎异常退出，系统正在自动恢复；恢复后可直接重新提交。";
  if (/at least 5 frames/i.test(error)) return "参考视频过短或不是有效视频，请换用至少 0.2 秒的视频素材。";
  if (/requires a non-empty prompt/i.test(error)) return "请先输入提示词。";
  const match = error.match(/exception_message["']?\s*:\s*["']([^"'\r\n]+)/i);
  return match?.[1] || "生成未完成。系统已保留上一版结果，可调整参数后重试。";
}

function ParameterSelect({ value, onChange, label, children }: { value: string; onChange: (value: string) => void; label: string; children: React.ReactNode }) {
  return <label className="parameter-select nodrag"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select><CaretDown /></label>;
}

function WorkbenchNodeComponent({ id, data, selected }: NodeProps<WorkbenchNode>) {
  const { assets, jobs, capabilities, canEditProject: projectEditable, notify, deriveNode, runNode, optimizePrompt, compileH3, getPlaybackUrl, inspectAsset, saveMask, changeVideoMode, disconnectInput, attachAsset, getNodeReadiness } = useWorkspace();
  const canEditProject = projectEditable && !data.productionRunId;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const renameNode = useCanvasStore((state) => state.renameNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const duplicateNodes = useCanvasStore((state) => state.duplicateNodes);
  const allEdges = useCanvasStore((state) => state.edges);
  const nodes = useCanvasStore((state) => state.nodes);
  const { focusedNodeId, detailScale, closeFocusedNode } = useCanvasFocus();
  const nodeRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<"run" | "optimize" | "">("");
  const [maskOpen, setMaskOpen] = useState(false);
  const [pickerPort, setPickerPort] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [promptView, setPromptView] = useState<"original" | "effective">("original");
  const [compiledPrompt, setCompiledPrompt] = useState("");
  const [compileError, setCompileError] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const kind = data.kind;
  const Icon = iconByKind[kind] || Sparkle;
  const resultAssets = (data.assetIds?.length ? data.assetIds : data.assetId ? [data.assetId] : []).map((assetId) => assets.find((item) => item.id === assetId)).filter((item): item is Asset => Boolean(item));
  const asset = assets.find((item) => item.id === data.assetId) || resultAssets[0];
  const nodeJobs = (data.jobIds?.length ? data.jobIds : data.jobId ? [data.jobId] : []).map((jobId) => jobs.find((item) => item.id === jobId)).filter(Boolean);
  const job = jobs.find((item) => item.id === data.jobId) || nodeJobs[0];
  const output = outputKind({ id, data } as WorkbenchNode, assets);
  const ports = inputPorts(kind, data.params);
  const incoming = useMemo(() => allEdges.filter((edge) => edge.target === id), [allEdges, id]);
  const referenceItems = useMemo(() => incoming.flatMap((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const connectedAsset = assets.find((item) => item.id === source?.data.assetId);
    const port = ports.find((item) => item.id === edge.targetHandle);
    return connectedAsset && port ? [{ edge, asset: connectedAsset, port }] : [];
  }), [assets, incoming, nodes, ports]);
  const assetForPort = (portId: string) => {
    const edge = incoming.find((item) => item.targetHandle === portId);
    const source = nodes.find((node) => node.id === edge?.source);
    return assets.find((item) => item.id === source?.data.assetId);
  };
  const sourceAsset = kind === "media_prepare" ? assetForPort("media_input") : assetForPort("source_image");
  const imageModels = capabilities?.providers?.image?.models || [];
  const promptModels = capabilities?.providers?.agent?.models || [];
  const readiness = getNodeReadiness(id);
  const currentSignature = nodeConfigurationSignature({ id, data } as WorkbenchNode, allEdges);
  const resultIsStale = Boolean(job && data.runSignature && data.runSignature !== currentSignature);
  const jobActive = nodeJobs.some((item) => item?.status === "queued" || item?.status === "running") || job?.status === "queued" || job?.status === "running";
  const isAsset = kind === "asset";
  const isImageGeneration = ["image_t2i", "image_i2i", "image_edit"].includes(kind);
  const isGeneratedPreview = Boolean(asset) && !isAsset && kind !== "media_prepare";
  const isFocusLocked = isGeneratedPreview && focusedNodeId === id;
  const prompt = String(data.params.prompt || data.params.text || "");
  const guidanceSignature = JSON.stringify([data.params.director_json, data.params.h3_ir_enabled, videoGuidance(data.params)]);
  const previousGuidance = useRef(guidanceSignature);
  const compileSignature = JSON.stringify([data.params, referenceItems.map(item => [item.edge.targetHandle, item.asset.id, item.asset.source_path])]);
  useEffect(() => {
    if (previousGuidance.current !== guidanceSignature && kind === "video") setPromptView("effective");
    previousGuidance.current = guidanceSignature;
  }, [guidanceSignature, kind]);
  useEffect(() => {
    if (kind !== "video" || promptView !== "effective") return;
    let current = true;
    setCompiling(true); setCompiledPrompt(""); setCompileError("");
    const timer = window.setTimeout(() => {
      void compileH3(id).then(result => { if (current) setCompiledPrompt(result.effective_prompt); })
        .catch(error => { if (current) setCompileError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (current) setCompiling(false); });
    }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [id, kind, promptView, compileSignature, compileH3]);

  useEffect(() => {
    if (kind !== "media_prepare" || !sourceAsset || sourceAsset.metadata?.probed_at) return;
    void inspectAsset(sourceAsset.id).catch(() => undefined);
  }, [inspectAsset, kind, sourceAsset]);
  useEffect(() => {
    if (projectEditable && data.renameRequestedAt) setRenaming(true);
  }, [projectEditable, data.renameRequestedAt]);
  const updateParams = (patch: WorkbenchParams) => { if (canEditProject) updateNodeData(id, { params: { ...data.params, ...patch } }); };
  const handleRun = async () => { if (!canEditProject || jobActive) return; setBusy("run"); try { await runNode(id); } catch (error) { notify(error instanceof Error ? error.message : String(error), "danger"); } finally { setBusy(""); } };
  const handleOptimize = async () => { if (!canEditProject) return; setBusy("optimize"); try { await optimizePrompt(id); if (kind === "video") setPromptView("effective"); } catch (error) { notify(error instanceof Error ? error.message : String(error), "danger"); } finally { setBusy(""); } };

  const missingPorts = ports.filter((port) => !incoming.some((edge) => edge.targetHandle === port.id));
  const pickerDescriptor = ports.find((port) => port.id === pickerPort) || missingPorts[0];
  const connectedAssetIds = new Set(referenceItems.map((item) => item.asset.id));
  const compatibleAssets = pickerDescriptor ? assets.filter((item) => (pickerDescriptor.accepts === "any" || mediaKind(item) === pickerDescriptor.accepts) && !connectedAssetIds.has(item.id)) : [];
  const compactMissingPorts = missingPorts.filter((port, index, all) => all.findIndex((item) => item.accepts === port.accepts) === index);
  const compatibleMentionAssets = assets.filter(item => connectedAssetIds.has(item.id) || (item.id !== data.assetId && missingPorts.some(port => port.accepts === "any" || port.accepts === mediaKind(item))));
  const isReferenceVideo = kind === "video" && data.params.mode === "reference";
  const referenceImageCount = referenceItems.filter((item) => item.port.accepts === "image").length;
  const qualityRisk = isReferenceVideo && (referenceImageCount > 1 || Number(data.params.duration_seconds || 5) >= 10) && data.params.profile !== "quality";
  const lockedReason = data.productionRunId ? "制作副本由 Agent 队列控制" : "当前项目为只读";
  const generateAction = <button className="generate-button" onClick={handleRun} disabled={!canEditProject || Boolean(busy) || jobActive || !readiness.ready} aria-label={!canEditProject ? lockedReason : jobActive ? "当前任务正在生成" : readiness.ready ? "加入本地生成队列" : readiness.reason} title={!canEditProject ? lockedReason : jobActive ? "当前任务正在生成，请等待完成" : readiness.reason}>{busy === "run" || jobActive ? <SpinnerGap className="spin" /> : <Sparkle weight="fill" />}</button>;

  const referenceStrip = ports.length ? <div className="reference-material-strip nodrag nowheel">
    <span className="reference-strip-label">参考素材 <small>{referenceItems.length}/{ports.length}</small></span>
    <div className="reference-strip-items">
      {referenceItems.map(({ edge, asset: referenceAsset, port }) => <div className={`reference-material type-${port.accepts}`} key={edge.id} title={`${port.label} · ${referenceAsset.name}`}><MediaPreview asset={referenceAsset} compact /><span>{port.label}</span><button aria-label={`移除${port.label}`} title="移除参考" onClick={() => disconnectInput(edge.id)}><X /></button></div>)}
      {compactMissingPorts.map((port) => <button className={`reference-material empty type-${port.accepts}`} key={port.id} title={`添加${port.label}`} onClick={() => setPickerPort(port.id)}><Plus /><small>{mediaLabel(port.accepts)}</small></button>)}
    </div>
    <small className="reference-strip-hint">{inputCapabilitySummary(kind, data.params)} · 可拖线、点 + 或输入 @ 添加</small>
    {pickerPort && pickerDescriptor ? <div className="reference-picker"><header><span><strong>添加{pickerDescriptor.label}</strong><small>仅显示兼容的{mediaLabel(pickerDescriptor.accepts)}</small></span><button onClick={() => setPickerPort(null)}><X /></button></header><div>{compatibleAssets.length ? compatibleAssets.map((item) => <button key={item.id} onClick={() => { attachAsset(id, item.id, pickerDescriptor.id); setPickerPort(null); }}><MediaPreview asset={item} compact /><span><strong>{item.name}</strong><small>{mediaLabel(mediaKind(item))} · {Math.max(1, Math.round(item.size_bytes / 1024))} KB</small></span></button>) : <p>素材库暂无可用的{mediaLabel(pickerDescriptor.accepts)}，请先导入。</p>}</div></div> : null}
  </div> : null;

  const promptComposer = <div className="prompt-editor-region nodrag nowheel">
    {kind === "video" && <div className="prompt-view-switch" role="tablist" aria-label="提示词视图"><button role="tab" aria-selected={promptView === "original"} onClick={() => setPromptView("original")}>创作原文</button><button role="tab" aria-selected={promptView === "effective"} onClick={() => setPromptView("effective")}>生效指令</button>{promptView === "effective" && <small role="status">{compiling ? "更新中…" : compileError ? "请检查配置" : "后端实际编译 · 只读"}</small>}</div>}
    {kind === "video" && promptView === "effective" ? <div className="prompt-composer effective-prompt"><textarea readOnly aria-label="生效指令" value={compiledPrompt} placeholder={compiling ? "正在编译当前参数…" : "校验通过后显示"} />{compileError && <p role="alert">{compileError}</p>}</div> : <PromptEditor value={prompt} bindings={readPromptBindings(data.params.prompt_bindings_json)} kind={kind} assets={compatibleMentionAssets} disabled={!canEditProject}
      onChange={(value, bindings) => updateParams({ ...(kind === "tts" ? { text: value } : { prompt: value }), prompt_bindings_json: JSON.stringify(bindings) })}
      onAttach={selectedAsset => attachAsset(id, selectedAsset.id)} label={kind === "tts" ? "角色台词" : "生成提示词"}
      placeholder={kind === "tts" ? "输入角色台词…" : "描述画面、动作、镜头；@ 引用素材，/ 调用指令…"}>
    {["image_t2i", "image_i2i", "image_edit", "video"].includes(kind) ? <button className="optimize-button" onClick={handleOptimize} disabled={!prompt.trim() || Boolean(busy) || !capabilities?.providers?.agent?.ready}><MagicWand />{busy === "optimize" ? "优化中" : "优化"}</button> : null}
    </PromptEditor>}
  </div>;

  const standardFooter = <footer className="parameter-bar nodrag">
    {isImageGeneration ? <ParameterSelect label="图片模型" value={String(data.params.model_id || "krea2-turbo-bf16")} onChange={(value) => updateParams({ model_id: value, steps: imageSamplingDefaults(kind, value).steps })}>{imageModels.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</ParameterSelect> : null}
    {isImageGeneration && promptModels.length ? <ParameterSelect label="提示词模型" value={String(data.params.prompt_model || capabilities?.providers?.agent?.default_model || "")} onChange={(value) => updateParams({ prompt_model: value })}>{promptModels.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</ParameterSelect> : null}
    {isImageGeneration ? <ParameterSelect label="生成数量" value={String(data.params.batch_count || 1)} onChange={(value) => updateParams({ batch_count: Number(value) })}><option value="1">1 张</option><option value="2">2 张</option><option value="4">4 张</option></ParameterSelect> : null}
    {kind === "tts" ? <ParameterSelect label="语言" value={String(data.params.language || "ZH")} onChange={(value) => updateParams({ language: value })}>{(capabilities?.providers?.tts?.languages || ["ZH"]).map((language) => <option key={language}>{language}</option>)}</ParameterSelect> : null}
    {kind === "dialogue" ? <><span className="parameter-pill">IndexTTS 2.5</span><span className="parameter-pill">{parseDialogueLines(data.params.dialogue_lines).length || 1} 句</span></> : null}
    {kind === "music" ? <span className="parameter-pill">MiniMax Music 3</span> : null}
    {kind === "sfx" ? <><span className="parameter-pill">Hunyuan Foley XXL</span><span className="parameter-pill">{Number(data.params.steps || 50)} 步</span></> : null}
    {generateAction}
  </footer>;

  const configuration = <div className="generation-configuration">
    {referenceStrip}
    {kind === "dialogue" ? <DialogueComposer params={data.params} onChange={updateParams} disabled={jobActive} /> : kind === "music" || kind === "sfx" ? <AudioComposer variant={kind} params={data.params} onChange={updateParams} onOptimize={handleOptimize} optimizeDisabled={!prompt.trim() || Boolean(busy) || !capabilities?.providers?.agent?.ready} disabled={jobActive} /> : promptComposer}
    {kind === "image_edit" && sourceAsset ? <button className="inline-mask-button nodrag" onClick={() => setMaskOpen(true)}><PaintBrush />打开区域编辑器</button> : null}
    {isImageGeneration ? <SamplingControls kind={kind} params={data.params} onChange={updateParams} disabled={jobActive} resultProfile={job?.result?.profile as Record<string, unknown> | undefined} /> : null}
    {kind === "video" ? <VideoControls nodeId={id} params={data.params} onChange={updateParams} onModeChange={(mode) => changeVideoMode(id, mode)} disabled={jobActive || Boolean(busy)} resultProfile={job?.result?.profile as Record<string, unknown> | undefined} promptModels={promptModels} defaultPromptModel={capabilities?.providers?.agent?.default_model} qualityRisk={qualityRisk} action={generateAction} /> : standardFooter}
    {!readiness.ready ? <div className="node-readiness"><WarningCircle />{readiness.reason}</div> : null}
  </div>;
  const configurationView = canEditProject ? configuration : <fieldset className="configuration-readonly" disabled aria-label="只读生成参数">{configuration}</fieldset>;
  const mediaPrepareView = <MediaPrepareBody sourceAsset={sourceAsset} params={data.params} updateParams={updateParams} handleRun={handleRun} busy={busy} />;

  const preview = asset ? <div className={`result-preview ${resultIsStale ? "is-stale" : ""}`}><MediaPreview asset={asset} /><span className="result-badge">{resultIsStale ? "上一版结果" : "最新结果"}</span>{resultAssets.length > 1 ? <button className="result-count nodrag" onClick={() => setGalleryOpen((value) => !value)} aria-expanded={galleryOpen}><Stack />{resultAssets.length}</button> : null}{galleryOpen && resultAssets.length > 1 ? <div className="result-gallery nodrag nowheel">{resultAssets.map((item, index) => <button key={item.id} className={item.id === asset.id ? "active" : ""} onClick={() => { updateNodeData(id, { assetId: item.id }); setGalleryOpen(false); }}><MediaPreview asset={item} compact /><span>{index + 1}</span></button>)}</div> : null}{canEditProject && output === "image" ? <button className="result-continue nodrag" onClick={() => deriveNode(id, "image_i2i", "source_image")}><ArrowsClockwise />作为输入继续</button> : null}</div> : null;

  const displayName = projectEditable ? <InlineNameEditor value={data.title} editing={renaming} onEditingChange={setRenaming} onCommit={(value) => renameNode(id, value)} className="node-title nodrag" ariaLabel="节点名称" /> : <span className="node-title">{data.title}</span>;

  if (kind === "group") return <div className={`group-node ${selected ? "selected" : ""}`}><NodeToolbar isVisible={selected && canEditProject} position={Position.Top} offset={8} className="node-toolbar"><button onClick={() => setRenaming(true)} aria-label="原位重命名分组"><PencilSimple /></button><button className="danger" onClick={() => deleteNodes([id])} aria-label="删除分组"><Trash /></button></NodeToolbar><div className="group-label"><FilmSlate weight="duotone" />{displayName}</div></div>;

  return <>
    <article ref={nodeRef} aria-label={`${data.title} · ${nodeLabels[kind]}`} className={`workbench-node node-${kind} ${asset ? "has-result" : ""} ${isGeneratedPreview ? "preview-only" : ""} ${isFocusLocked ? "is-focus-locked" : ""} ${!canEditProject ? "is-readonly" : ""} ${selected ? "is-selected" : ""} ${job?.status || "idle"}`}>
      {isAsset ? <NodeResizer isVisible={selected && canEditProject} keepAspectRatio minWidth={220} minHeight={150} lineClassName="node-resizer-line" handleClassName="node-resizer-handle" /> : null}
      <NodeToolbar isVisible={selected && canEditProject} position={Position.Top} offset={10} className="node-toolbar"><button onClick={() => setRenaming(true)} aria-label="重命名节点" title="原位重命名"><PencilSimple /></button><button onClick={() => duplicateNodes([id])} aria-label="复制节点" title="复制"><Copy /></button>{asset && output === "image" ? <button onClick={() => deriveNode(id, "image_edit", "source_image")} aria-label="继续图片编辑"><MagicWand /></button> : null}{asset && output === "image" ? <button onClick={() => deriveNode(id, "image_i2i", "source_image")} aria-label="作为下一节点输入"><ArrowsClockwise /></button> : null}{asset && output === "video" ? <button onClick={() => deriveNode(id, "video", "reference_video_1", { mode: "reference" })} aria-label="继续视频创作"><VideoCamera /></button> : null}{asset ? <button onClick={() => deriveNode(id, "media_prepare", "media_input")} aria-label="适配素材规格"><SlidersHorizontal /></button> : null}{!isGeneratedPreview ? <button onClick={() => updateNodeData(id, { collapsed: !data.collapsed })} aria-label={data.collapsed ? "展开节点" : "收起节点"}><DotsThree /></button> : null}<button className="danger" onClick={() => deleteNodes([id])} aria-label="删除节点"><Trash /></button></NodeToolbar>
      {ports.map((port) => <Handle key={port.id} id={port.id} type="target" position={Position.Left} className={`node-handle semantic-input type-${port.accepts}`} isConnectable={canEditProject} />)}{ports.length ? <Handle id="smart_input" type="target" position={Position.Left} className="node-handle smart-input type-any" title="系统会按素材类型自动分配输入角色" isConnectable={canEditProject} /> : null}<Handle id="output" type="source" position={Position.Right} className={`node-handle output type-${output}`} title={projectEditable ? `拖出 ${output} 连线，在空白处松开以创建下游节点` : "当前项目为只读"} isConnectable={projectEditable} />
      {!isGeneratedPreview && !isAsset ? <header className="node-header"><span className="node-kind-icon"><Icon weight="duotone" /></span>{displayName}{resultIsStale ? <span className="job-status stale"><WarningCircle />配置已修改</span> : job ? <span className={`job-status ${job.status}`}>{job.status === "succeeded" ? <Check /> : job.status === "running" ? <SpinnerGap className="spin" /> : null}{statusLabel[job.status]}</span> : <span className="node-type">{nodeLabels[kind]}</span>}</header> : null}
      {isAsset ? <div className="asset-node-body"><MediaPreview asset={asset} /><div className="asset-meta">{displayName}<span>{asset ? `${mediaKind(asset).toUpperCase()} · ${Math.max(1, Math.round(asset.size_bytes / 1024))} KB` : "本地素材"}</span></div></div> : kind === "note" ? <div className="note-node-body nodrag nowheel"><textarea value={prompt} onChange={(event) => updateParams({ text: event.target.value })} aria-label="便笺内容" placeholder="记录镜头想法、制作要求或团队备注…" disabled={!canEditProject} /></div> : <div className={`generator-body ${data.collapsed ? "collapsed" : ""}`}>{isGeneratedPreview ? preview : kind === "media_prepare" ? (canEditProject ? mediaPrepareView : <fieldset className="configuration-readonly" disabled>{mediaPrepareView}</fieldset>) : data.collapsed ? <p className="collapsed-prompt">{prompt || "点击展开并输入创作描述"}</p> : configurationView}{job?.status === "failed" ? <div className="job-error-summary"><WarningCircle weight="fill" /><span>{friendlyJobError(job.error)}</span></div> : null}</div>}
    </article>
    {isFocusLocked && nodeRef.current ? <GenerationDetailPanel anchor={nodeRef.current} scale={detailScale} onClose={closeFocusedNode} label={`${data.title}提示词与参数`} heading={<><Icon weight="duotone" /><span className="detail-heading">{displayName}</span></>}><div className="generation-inspector-content">{configurationView}{job ? <PreviewReview job={job} /> : null}</div></GenerationDetailPanel> : null}
    {maskOpen && sourceAsset ? <MaskEditor asset={sourceAsset} initialPrompt={prompt} getUrl={getPlaybackUrl} onClose={() => setMaskOpen(false)} onSave={(file, instruction) => saveMask(id, file, instruction)} /> : null}
  </>;
}

function PreviewReview({ job }: { job: import("../types").Job }) {
  const { canReviewProject, reviewJob, notify } = useWorkspace();
  const [saving, setSaving] = useState(false);
  if (job.type !== "h3.t2v" || job.status !== "succeeded" || job.params.profile === "quality" || job.preview_job_id) return null;
  const status = job.approval_status || "pending";
  const save = async (next: "approved" | "rejected" | "pending") => {
    if (!canReviewProject || saving) return;
    setSaving(true);
    try { await reviewJob(job.id, next); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "danger"); }
    finally { setSaving(false); }
  };
  return <footer className="preview-review" aria-label="预览审核"><span>{status === "approved" ? "已通过审核" : status === "rejected" ? "需要修改" : "待审核"}</span>{canReviewProject ? <><button disabled={saving || status === "approved"} onClick={() => void save("approved")}><Check />通过</button><button disabled={saving || status === "rejected"} onClick={() => void save("rejected")}>需修改</button>{status !== "pending" ? <button disabled={saving} onClick={() => void save("pending")}>撤回</button> : null}</> : null}</footer>;
}

function MediaPrepareBody({ sourceAsset, params, updateParams, handleRun, busy }: { sourceAsset?: Asset; params: WorkbenchParams; updateParams: (patch: WorkbenchParams) => void; handleRun: () => Promise<void>; busy: string }) {
  return <div className="media-prepare-body nodrag nowheel">{sourceAsset ? <><div className="media-source-summary"><MediaPreview asset={sourceAsset} compact /><span><strong>{sourceAsset.name}</strong><small>已自动识别为 {mediaKind(sourceAsset).toUpperCase()}</small></span></div><div className="media-metadata-grid"><span><small>分辨率</small><strong>{sourceAsset.metadata?.width && sourceAsset.metadata?.height ? `${sourceAsset.metadata.width} × ${sourceAsset.metadata.height}` : "—"}</strong></span><span><small>画幅比</small><strong>{sourceAsset.metadata?.aspect_ratio ? Number(sourceAsset.metadata.aspect_ratio).toFixed(3) : "—"}</strong></span><span><small>编码</small><strong>{String(sourceAsset.metadata?.video_codec || sourceAsset.metadata?.audio_codec || sourceAsset.metadata?.container || "—")}</strong></span><span><small>{mediaKind(sourceAsset) === "audio" ? "采样率" : mediaKind(sourceAsset) === "image" ? "像素格式" : "帧率"}</small><strong>{String(mediaKind(sourceAsset) === "audio" ? sourceAsset.metadata?.sample_rate || "—" : mediaKind(sourceAsset) === "image" ? sourceAsset.metadata?.pixel_format || "—" : sourceAsset.metadata?.frame_rate || "—")}</strong></span><span><small>文件大小</small><strong>{(sourceAsset.size_bytes / 1024 / 1024).toFixed(2)} MB</strong></span><span><small>{mediaKind(sourceAsset) === "audio" ? "声道" : "时长"}</small><strong>{String(mediaKind(sourceAsset) === "audio" ? sourceAsset.metadata?.channels || "—" : sourceAsset.metadata?.duration_seconds ? `${Number(sourceAsset.metadata.duration_seconds).toFixed(2)} 秒` : "—")}</strong></span></div>{mediaKind(sourceAsset) !== "audio" ? <div className="prepare-controls"><ParameterSelect label="目标尺寸" value={`${params.target_width}x${params.target_height}`} onChange={(value) => { const [target_width, target_height] = value.split("x").map(Number); updateParams({ target_width, target_height }); }}><option value="1344x768">H3 横屏 · 1344×768</option><option value="768x1344">H3 竖屏 · 768×1344</option><option value="992x992">H3 方形 · 992×992</option><option value="1024x1024">图片 · 1024×1024</option></ParameterSelect><ParameterSelect label="适配方式" value={String(params.fit_mode || "contain")} onChange={(value) => updateParams({ fit_mode: value })}><option value="contain">完整保留 · 留边</option><option value="cover">铺满画面 · 智能裁切</option></ParameterSelect></div> : <div className="prepare-controls"><span className="parameter-pill">48 kHz · 24-bit PCM</span><span className="parameter-pill">{params.target_channels === 1 ? "单声道" : "双声道"}</span></div>}<button className="prepare-run" onClick={handleRun} disabled={Boolean(busy)}>{busy === "run" ? <SpinnerGap className="spin" /> : <SlidersHorizontal />}生成模型兼容副本</button><small className="quality-note">Lanczos 高质量缩放；图片无损 PNG，视频 CRF 14，音频 24-bit PCM。原素材保持不变。</small></> : <div className="media-empty-input"><SlidersHorizontal /><strong>连接任意图片、视频或音频</strong><span>系统会先读取分辨率、尺寸、编码与采样参数</span></div>}</div>;
}

export const WorkbenchNodeView = memo(WorkbenchNodeComponent);
