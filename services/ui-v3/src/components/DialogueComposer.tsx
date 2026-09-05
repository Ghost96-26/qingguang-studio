import { MicrophoneStage, Plus, Trash, UserSound } from "@phosphor-icons/react";
import type { WorkbenchParams } from "../types";

export interface DialogueLine {
  id: string;
  speaker: string;
  text: string;
  language: string;
  voice_slot: number;
  gap_seconds: number;
}

const LANGUAGES = ["ZH", "EN", "JA", "ES", "AR"];

export function parseDialogueLines(value: unknown): DialogueLine[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 16).map((line, index) => ({
      id: String(line?.id || `line-${index + 1}`),
      speaker: String(line?.speaker || `角色 ${String.fromCharCode(65 + Math.min(index, 25))}`),
      text: String(line?.text || ""),
      language: LANGUAGES.includes(String(line?.language || "ZH").toUpperCase()) ? String(line.language || "ZH").toUpperCase() : "ZH",
      voice_slot: Math.max(1, Math.min(4, Number(line?.voice_slot || 1))),
      gap_seconds: Math.max(0, Math.min(5, Number(line?.gap_seconds ?? .35))),
    }));
  } catch {
    return [];
  }
}

function createLine(index: number): DialogueLine {
  return { id: crypto.randomUUID(), speaker: `角色 ${String.fromCharCode(65 + Math.min(index, 25))}`, text: "", language: "ZH", voice_slot: Math.min(4, index + 1), gap_seconds: .35 };
}

export function DialogueComposer({ params, onChange, disabled }: { params: WorkbenchParams; onChange: (patch: WorkbenchParams) => void; disabled?: boolean }) {
  const lines = parseDialogueLines(params.dialogue_lines);
  const safeLines = lines.length ? lines : [createLine(0)];
  const commit = (next: DialogueLine[]) => onChange({ dialogue_lines: JSON.stringify(next) });
  const patchLine = (index: number, patch: Partial<DialogueLine>) => commit(safeLines.map((line, itemIndex) => itemIndex === index ? { ...line, ...patch } : line));

  return <section className="dialogue-composer nodrag nowheel" aria-label="角色对白编排">
    <header>
      <span><UserSound weight="duotone" /><strong>{safeLines.length > 1 ? "多人对白" : "角色对白"}</strong><small>逐句锁定角色音色与停顿</small></span>
      <button onClick={() => commit([...safeLines, createLine(safeLines.length)])} disabled={disabled || safeLines.length >= 16}><Plus />添加台词</button>
    </header>
    <div className="dialogue-lines">
      {safeLines.map((line, index) => <article key={line.id}>
        <span className="dialogue-index">{String(index + 1).padStart(2, "0")}</span>
        <input value={line.speaker} onChange={(event) => patchLine(index, { speaker: event.target.value })} aria-label={`第${index + 1}句角色名`} disabled={disabled} />
        <label title="连接在节点左侧的角色参考音色"><MicrophoneStage /><select value={line.voice_slot} onChange={(event) => patchLine(index, { voice_slot: Number(event.target.value) })} disabled={disabled}>{[1, 2, 3, 4].map((slot) => <option value={slot} key={slot}>音色 {slot}</option>)}</select></label>
        <select value={line.language} onChange={(event) => patchLine(index, { language: event.target.value })} aria-label={`第${index + 1}句语言`} disabled={disabled}>{LANGUAGES.map((language) => <option key={language}>{language}</option>)}</select>
        <textarea value={line.text} onChange={(event) => patchLine(index, { text: event.target.value })} placeholder="输入这句台词…" aria-label={`第${index + 1}句台词`} disabled={disabled} />
        <label className="dialogue-gap">停顿<input type="number" min="0" max="5" step="0.05" value={line.gap_seconds} onChange={(event) => patchLine(index, { gap_seconds: Number(event.target.value) })} disabled={disabled} />秒</label>
        <button className="dialogue-remove" onClick={() => commit(safeLines.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled || safeLines.length === 1} aria-label={`删除第${index + 1}句`}><Trash /></button>
      </article>)}
    </div>
    <small className="dialogue-hint">一名角色可重复使用同一音色槽；多人轮流对话只需增加台词行。生成时按行合成本地音色并自动拼接。</small>
  </section>;
}
