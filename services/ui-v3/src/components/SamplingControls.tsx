import { H3_NATIVE_STEPS, IMAGE_RESOLUTIONS, VIDEO_RESOLUTIONS, effectiveSamplingSteps, imageSamplingDefaults } from "../sampling";
import type { NodeKind, WorkbenchParams } from "../types";

export function SamplingControls({ kind, params, onChange, disabled = false, resultProfile }: {
  kind: NodeKind;
  params: WorkbenchParams;
  onChange: (patch: WorkbenchParams) => void;
  disabled?: boolean;
  resultProfile?: Record<string, unknown>;
}) {
  const video = kind === "video";
  const turbo = video && (params.profile === "preview4" || params.profile === "preview8");
  const steps = effectiveSamplingSteps(kind, params);
  const presets = video ? H3_NATIVE_STEPS : imageSamplingDefaults(kind, String(params.model_id || "krea2-turbo-bf16")).options;
  const stepOptions = turbo ? [steps] : [...new Set([...presets, steps])].sort((a, b) => a - b);
  const resolution = `${params.width}x${params.height}`;
  const resolutions = video ? VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS;
  const highLoad = !video && Math.max(Number(params.width), Number(params.height)) >= 2048;
  return <div className="sampling-settings nodrag nowheel">
    <div className="sampling-controls">
      <label><span>采样步数</span><select aria-label="采样步数" value={steps} disabled={disabled || turbo} onChange={(event) => onChange({ steps: Number(event.target.value) })}>
        {stepOptions.map((value) => <option key={value} value={value}>{value} 步{turbo ? " · LoRA固定" : ""}</option>)}
      </select></label>
      <label><span>输出分辨率</span><select aria-label="输出分辨率" value={resolution} disabled={disabled} onChange={(event) => { const [width, height] = event.target.value.split("x").map(Number); onChange({ width, height }); }}>
        {!resolutions.some(([value]) => value === resolution) ? <option value={resolution}>{params.width}×{params.height} · 当前</option> : null}
        {resolutions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    <small className="sampling-hint">{turbo ? "加速 LoRA 固定步数；切换“原生质量”后可自由调整。" : video ? "原生采样 · 无加速 LoRA · 分辨率独立设置，步数更多不保证更好。" : highLoad ? "2048 为高负载选项；如显存不足可回到 1536，原图不会覆盖。" : "按模型调整采样步数；更换模型会恢复对应推荐步数。"}</small>
    {resultProfile?.steps && resultProfile.width && resultProfile.height ? <small className="sampling-last-run">上次实际生成：{String(resultProfile.steps)} 步 · {String(resultProfile.width)}×{String(resultProfile.height)}{video ? " · 24 fps" : ""}</small> : null}
  </div>;
}
