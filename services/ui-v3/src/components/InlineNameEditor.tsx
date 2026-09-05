import { useEffect, useRef, useState } from "react";

interface InlineNameEditorProps {
  value: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onCommit: (value: string) => void | Promise<void>;
  className?: string;
  ariaLabel?: string;
}

export function InlineNameEditor({ value, editing, onEditingChange, onCommit, className = "", ariaLabel = "名称" }: InlineNameEditorProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);
  const commit = async () => {
    const next = draft.trim();
    onEditingChange(false);
    if (next && next !== value) await onCommit(next);
    else setDraft(value);
  };
  if (!editing) return <button className={`inline-name-display ${className}`} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); onEditingChange(true); }} title="双击原位重命名">{value}</button>;
  return <input ref={inputRef} className={`inline-name-input ${className}`} value={draft} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={(event) => {
    if (event.key === "Enter") { event.preventDefault(); void commit(); }
    if (event.key === "Escape") { event.preventDefault(); setDraft(value); onEditingChange(false); }
  }} aria-label={ariaLabel} />;
}
