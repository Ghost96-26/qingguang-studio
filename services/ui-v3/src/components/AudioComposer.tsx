import { MagicWand, MusicNotes, SpeakerHigh } from "@phosphor-icons/react";
import type { WorkbenchParams } from "../types";

const MODES = [
  { id: "music", label: "音乐", icon: MusicNotes },
  { id: "score", label: "配乐", icon: SpeakerHigh },
] as const;

export function AudioComposer({ variant, params, onChange, onOptimize, optimizeDisabled, disabled }: { variant: "music" | "sfx"; params: WorkbenchParams; onChange: (patch: WorkbenchParams) => void; onOptimize: () => void; optimizeDisabled?: boolean; disabled?: boolean }) {
  const mode = String(params.audio_mode || "music");
  return <section className="audio-composer nodrag nowheel">
    {variant === "music" ? <div className="audio-mode-tabs" role="tablist" aria-label="音乐生成类型">
      {MODES.map(({ id, label, icon: Icon }) => <button role="tab" aria-selected={mode === id} key={id} onClick={() => onChange({ audio_mode: id })} disabled={disabled}><Icon />{label}</button>)}
    </div> : null}
    <div className="prompt-composer audio-prompt">
      <textarea value={String(params.prompt || "")} onChange={(event) => onChange({ prompt: event.target.value })} placeholder={variant === "sfx" ? "描述画面中应出现的声音、材质、空间、距离与时间变化…" : mode === "score" ? "描述场景情绪、节奏变化与画面时长…" : "描述曲风、乐器、节奏与情绪…"} />
      <button className="optimize-button" onClick={onOptimize} disabled={optimizeDisabled}><MagicWand />优化</button>
    </div>
    {variant === "music" ? <div className="audio-timing-row">
      <span>MiniMax Music 3</span>
      <label><select value={String(params.timing_mode || "adaptive")} onChange={(event) => onChange({ timing_mode: event.target.value })} disabled={disabled}><option value="adaptive">LLM 自适应编排</option><option value="custom">自定义时长</option></select></label>
      {params.timing_mode === "custom" ? <label><input type="number" min="3" max="300" value={Number(params.duration_seconds || 10)} onChange={(event) => onChange({ duration_seconds: Number(event.target.value) })} disabled={disabled} />秒</label> : <span>{Number(params.duration_seconds || 10)} 秒目标</span>}
    </div> : <div className="audio-timing-row">
      <span>Hunyuan Foley XXL · BF16</span>
      <label><select aria-label="音效质量" value={String(params.steps || 50)} onChange={(event) => onChange({ steps: Number(event.target.value) })} disabled={disabled}><option value="25">预览 · 25 步</option><option value="50">高质量 · 50 步</option><option value="75">精细 · 75 步</option></select></label>
      <label><select aria-label="提示词引导强度" value={String(params.guidance_scale || 4.5)} onChange={(event) => onChange({ guidance_scale: Number(event.target.value) })} disabled={disabled}><option value="3.5">自然引导</option><option value="4.5">平衡引导</option><option value="6">强提示词</option></select></label>
    </div>}
  </section>;
}
