import { Camera, Check, DotsThree, FilmSlate, Palette, VideoCamera, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent } from "react";
import { VIDEO_CATALOG, VIDEO_QUALITY, VIDEO_SIZES, VIDEO_SIZE_LABELS, effectiveVideoPrompt, videoGeometry, videoGuidance, videoModelId, videoModelPatch, videoSizePatch } from "../video-options";
import { H3_VIDEO_MODES, videoModeCapability } from "../model";
import { effectiveSamplingSteps } from "../sampling";
import type { WorkbenchParams } from "../types";
import { NodeParameterPopover } from "./NodeParameterPopover";
import { DirectorPanel } from "./DirectorPanel";

type Panel = "model" | "settings" | "style" | "camera" | "director" | "more";
const titles = { model: "视频模型", settings: "生成参数", style: "风格预设", camera: "摄影机控制", director: "Director 导演台", more: "更多设置" };

function navigateChoices(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')];
  const index = options.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault(); event.stopPropagation();
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
  options[next].focus(); options[next].click();
}

function Choices({ label, value, options, onChange, disabled = false, columns = 3 }: {
  label: string; value: string | number; options: { value: string | number; label: string; detail?: string }[];
  onChange: (value: string) => void; disabled?: boolean; columns?: number;
}) {
  return <fieldset className="parameter-choice-group"><legend>{label}</legend><div role="radiogroup" aria-label={label} className="parameter-choices" onKeyDown={navigateChoices} style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` }}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={String(value) === String(option.value)} tabIndex={String(value) === String(option.value) || (!options.some(item => String(item.value) === String(value)) && index === 0) ? 0 : -1} disabled={disabled} onClick={() => onChange(String(option.value))}>
      <span>{option.label}</span>{option.detail ? <small>{option.detail}</small> : null}
    </button>)}
  </div></fieldset>;
}

export function VideoControls({ nodeId, params, onChange, onModeChange, disabled = false, resultProfile, promptModels, defaultPromptModel, qualityRisk, action }: {
  nodeId: string;
  params: WorkbenchParams; onChange: (patch: WorkbenchParams) => void; onModeChange: (mode: string) => void;
  disabled?: boolean; resultProfile?: Record<string, unknown>;
  promptModels: { id: string; label: string }[]; defaultPromptModel?: string; qualityRisk?: boolean; action: ReactNode;
}) {
  const barRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<{ kind: Panel; trigger: HTMLButtonElement } | null>(null);
  const close = useCallback(() => setPanel(null), []);
  const geometry = videoGeometry(params);
  const modelId = videoModelId(params);
  const turbo = params.profile === "preview4" || params.profile === "preview8";
  const steps = effectiveSamplingSteps("video", params);
  const duration = Number(params.duration_seconds || 5);
  const mode = videoModeCapability(params);
  const style = VIDEO_CATALOG.groups[0].options.find(option => option.id === (params.video_style || "none"));
  const guidance = videoGuidance(params);
  const cameraActive = VIDEO_CATALOG.groups.slice(1).some(group => params[group.key] && params[group.key] !== "none");
  const modelLabel = turbo ? `H3 Turbo ${steps}` : "H3 原生";
  const sizeLabel = `${Math.min(geometry.width, geometry.height)}P`;
  const summary = `${mode.shortLabel} · ${geometry.ratio} · ${sizeLabel} · ${steps}步 · ${duration}s`;
  const triggerProps = (kind: Panel) => ({
    "aria-label": titles[kind], "aria-haspopup": "dialog" as const, "aria-expanded": panel?.kind === kind,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      const trigger = event.currentTarget;
      setPanel(current => current?.kind === kind ? null : { kind, trigger });
    },
  });

  return <footer ref={barRef} className="video-parameter-bar nodrag nopan nowheel" aria-label="视频生成参数">
    <button type="button" className="video-model-trigger" {...triggerProps("model")} title={modelLabel}><VideoCamera /><span>{modelLabel}</span></button>
    <button type="button" className="video-summary-trigger" {...triggerProps("settings")} title={`${summary} · 实际${geometry.width}×${geometry.height}`}><span>{summary}</span></button>
    <button type="button" className={`video-icon-trigger ${params.video_style && params.video_style !== "none" ? "has-value" : ""}`} {...triggerProps("style")} title={`风格：${style?.label || "遵循原提示词"}`}><Palette /></button>
    <button type="button" className={`video-icon-trigger ${cameraActive ? "has-value" : ""}`} {...triggerProps("camera")} title="摄影机控制 · 提示词引导"><Camera /></button>
    <button type="button" className={`video-icon-trigger ${params.h3_ir_enabled ? "has-value" : ""}`} {...triggerProps("director")} title="Director 导演台 · 角色、表演与H3-IR"><FilmSlate /></button>
    <button type="button" className="video-icon-trigger" {...triggerProps("more")} title="提示词模型、采样调度与实际提示词"><DotsThree /></button>
    {action}

    {panel && barRef.current ? <NodeParameterPopover key={panel.kind} title={titles[panel.kind]} anchor={barRef.current} trigger={panel.trigger} onClose={close} preferredWidth={panel.kind === "director" ? 480 : 368}>
      {panel.kind === "director" ? <DirectorPanel nodeId={nodeId} params={params} onChange={onChange} disabled={disabled} /> : null}
      {disabled ? <p className="parameter-explainer">当前任务正在生成，参数暂时锁定；可查看设置。</p> : null}
      {panel.kind === "model" ? <div className="parameter-option-list" role="radiogroup" aria-label="视频模型列表" onKeyDown={navigateChoices}>
        {VIDEO_CATALOG.models.filter(model => model.modes.includes(mode.id)).map(model => <button type="button" role="radio" aria-checked={model.id === modelId} tabIndex={model.id === modelId ? 0 : -1} key={model.id} disabled={disabled} onClick={() => { onChange(videoModelPatch(model.id)); close(); }}>
          <VideoCamera /><span><strong>{model.label}</strong><small>本地 INT8 · {model.profile === "quality" ? "原生20–40步 · 无加速LoRA" : `匹配${model.profile === "preview4" ? 4 : 8}步加速LoRA`}</small></span>{model.id === modelId ? <Check /> : null}
        </button>)}
        <p className="parameter-explainer">只显示当前模式兼容的本地模型。更换模型保留分辨率、时长和参考素材。</p>
      </div> : null}

      {panel.kind === "settings" ? <>
        <Choices label="生成方式" value={mode.id} options={Object.values(H3_VIDEO_MODES).map(item => ({ value: item.id, label: item.shortLabel }))} onChange={onModeChange} disabled={disabled} />
        <p className="parameter-explainer">{mode.description}</p>
        <Choices label="画幅比" value={geometry.ratio} options={Object.keys(VIDEO_SIZES).map(value => ({ value, label: value }))} onChange={value => onChange(videoSizePatch(params, value))} disabled={disabled} columns={6} />
        <Choices label="分辨率" value={geometry.tier} columns={geometry.tier < 0 ? 3 : 4} options={[
          ...(geometry.tier < 0 ? [{ value: -1, label: "当前尺寸", detail: `${geometry.width}×${geometry.height}` }] : []),
          ...VIDEO_SIZES[geometry.ratio].map(([w,h], index) => ({ value: index, label: `${Math.min(w,h)}P`, detail: `${w}×${h} · ${VIDEO_SIZE_LABELS[index]}` })),
        ]} onChange={value => { if (Number(value) >= 0) onChange(videoSizePatch(params, geometry.ratio, Number(value))); }} disabled={disabled} />
        <Choices label="质量 / 采样步数" value={steps} options={turbo ? [{ value: steps, label: `Turbo · 固定${steps}步` }] : [
          ...(!VIDEO_QUALITY.some(([value]) => value === steps) ? [{ value: steps, label: `${steps}步 · 历史设置` }] : []),
          ...VIDEO_QUALITY.map(([value,label]) => ({ value,label })),
        ]} onChange={value => onChange({ steps: Number(value) })} disabled={disabled || turbo} columns={turbo ? 1 : 3} />
        <Choices label="生成时长" value={duration} options={[...new Set([4,5,6,8,10,12,15,duration])].sort((a,b) => a-b).map(value => ({ value, label: `${value}s` }))} onChange={value => onChange({ duration_seconds: Number(value) })} disabled={disabled} columns={7} />
        {qualityRisk ? <p className="parameter-warning"><WarningCircle />多人物或长片的Turbo预览可能损失细节，建议原生对照。</p> : null}
        <p className="parameter-explainer">20/30/40是计算档位，不保证步数越高越清晰。24fps；尺寸按32像素对齐，时长按帧数取整。高分辨率长片建议串行测试。</p>
      </> : null}

      {panel.kind === "style" ? <>
        <p className="parameter-explainer">附加审美引导，不改写正文、不加载额外LoRA。</p>
        <Choices label="视频风格" value={String(params.video_style || "none")} columns={2} options={VIDEO_CATALOG.groups[0].options.map(option => ({ value: option.id, label: option.label }))} disabled={disabled} onChange={value => { onChange({ video_style: value }); close(); }} />
      </> : null}

      {panel.kind === "camera" ? <>
        <p className="parameter-explainer">以下是提示词引导，不是精确光学或3D机位模拟。</p>
        {VIDEO_CATALOG.groups.slice(1).map(group => <Choices key={group.key} label={group.label} value={String(params[group.key] || "none")} options={group.options.map(option => ({ value: option.id, label: option.label }))} disabled={disabled} onChange={value => onChange({ [group.key]: value })} />)}
        <button type="button" className="parameter-text-action" disabled={disabled || !cameraActive} onClick={() => onChange(Object.fromEntries(VIDEO_CATALOG.groups.slice(1).map(group => [group.key,"none"])))}>清除摄影引导</button>
      </> : null}

      {panel.kind === "more" ? <>
        {promptModels.length ? <Choices label="提示词优化模型" value={String(params.prompt_model || defaultPromptModel || "")} options={promptModels.map(model => ({ value: model.id, label: model.label }))} columns={1} disabled={disabled} onChange={value => onChange({ prompt_model: value })} /> : null}
        <Choices label="采样调度" value={String(params.scheduler || "simple")} options={[{ value:"simple",label:"Simple" },{ value:"beta",label:"Beta" },{ value:"normal",label:"Normal" }]} disabled={disabled || turbo} onChange={value => onChange({ scheduler: value })} />
        <p className="parameter-explainer">原生默认保留Simple；Beta/Normal用于单变量对照。Turbo锁定Simple。</p>
        <label className="director-field"><span>随机种子 · 相同配置下复现</span><input aria-label="视频随机种子" type="number" min={0} max={4294967295} step={1} value={Number(params.seed ?? 7)} disabled={disabled} onChange={event => onChange({ seed: Math.max(0, Math.min(4294967295, Math.trunc(Number(event.target.value)))) })} /></label>
        <button type="button" className="parameter-text-action" disabled={disabled} onClick={() => onChange({ seed: crypto.getRandomValues(new Uint32Array(1))[0] })}>换一个种子</button>
        {params.h3_ir_enabled === true ? <DirectorPanel nodeId={nodeId} params={params} onChange={onChange} previewOnly disabled={disabled} /> : <label className="parameter-prompt-preview"><span>实际发送提示词 · {guidance.length ? `${guidance.length}项附加引导` : "正文不变"}</span><textarea aria-label="实际发送视频提示词" readOnly value={effectiveVideoPrompt(params)} /></label>}
        <button type="button" className="parameter-text-action" disabled={disabled || !guidance.length} onClick={() => onChange(Object.fromEntries(VIDEO_CATALOG.groups.map(group => [group.key,"none"])))}>清除风格与摄影引导 · 保留原文</button>
        {resultProfile?.steps && resultProfile.width && resultProfile.height ? <p className="parameter-last-run">上次实际生成：{String(resultProfile.steps)}步 · {String(resultProfile.width)}×{String(resultProfile.height)} · {String(resultProfile.scheduler || "simple")} · 24fps</p> : null}
      </> : null}
    </NodeParameterPopover> : null}
  </footer>;
}
