import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { At, Command } from "@phosphor-icons/react";
import type { Asset, NodeKind } from "../types";
import { mentionToken, promptTrigger, replacePromptTrigger, type PromptBindings } from "../prompt-assist";
import { PROMPT_PRESETS } from "./PromptAssistMenu";
import { MediaPreview } from "./MediaPreview";

export function PromptEditor({ value, bindings = {}, onChange, assets, kind, onAttach, disabled, label = "生成提示词", placeholder, children, onSubmit }: {
  value: string; bindings?: PromptBindings; onChange: (value: string, bindings: PromptBindings) => void;
  assets: Asset[]; kind: NodeKind | "agent"; onAttach: (asset: Asset) => boolean;
  disabled?: boolean; label?: string; placeholder?: string; children?: ReactNode; onSubmit?: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(true);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 340, maxHeight: 260 });
  const trigger = !dismissed && !disabled ? promptTrigger(value, caret) : null;
  const choices = useMemo(() => {
    if (!trigger) return [];
    const query = trigger.query.toLocaleLowerCase();
    return trigger.mode === "mention"
      ? assets.filter(asset => asset.name.toLocaleLowerCase().includes(query)).slice(0, 50).map(asset => ({ id: asset.id, label: asset.name, description: asset.kind.toUpperCase(), asset, prompt: "" }))
      : PROMPT_PRESETS.filter(preset => (kind === "agent" || preset.kinds.includes(kind)) && `${preset.label} ${preset.description} ${preset.id}`.toLocaleLowerCase().includes(query))
        .map(preset => ({ id: preset.id, label: preset.label, description: preset.description, asset: undefined, prompt: preset.prompt }));
  }, [trigger?.mode, trigger?.query, assets, kind]);
  useEffect(() => { setActive(0); }, [trigger?.mode, trigger?.query]);
  const open = Boolean(trigger);
  useLayoutEffect(() => {
    if (!open || !input.current) return;
    const update = () => {
      const rect = input.current!.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      const height = Math.min(280, window.innerHeight - 24, 70 + Math.max(1, choices.length) * 48);
      const above = rect.top >= height + 12;
      const next = { left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(above ? rect.top - height - 6 : rect.bottom + 6, window.innerHeight - height - 12)), width, maxHeight: height };
      setPosition(current => Object.keys(next).every(key => next[key as keyof typeof next] === current[key as keyof typeof next]) ? current : next);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new ResizeObserver(update); observer.observe(input.current);
    // Transform-only inspector zoom doesn't trigger ResizeObserver. Track only while open.
    let frame = 0;
    const follow = () => { update(); frame = requestAnimationFrame(follow); };
    frame = requestAnimationFrame(follow);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, choices.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !input.current?.contains(event.target)) setDismissed(true);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => { menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  const choose = (index: number) => {
    const item = choices[index];
    if (!item || !trigger || disabled) return;
    const nextBindings = { ...bindings };
    let insert = item.prompt;
    if (item.asset) {
      if (!onAttach(item.asset)) return;
      insert = mentionToken(item.asset.name, item.asset.id, bindings);
      nextBindings[insert] = item.asset.id;
    }
    const next = replacePromptTrigger(value, trigger, insert);
    onChange(next.text, nextBindings); setCaret(next.caret); setDismissed(true);
    requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  return <div className="prompt-composer nodrag nopan nowheel">
    <textarea ref={input} value={value} disabled={disabled} aria-label={label} placeholder={placeholder}
      role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open && choices[active] ? `${id}-${active}` : undefined}
      onCompositionStart={() => { composing.current = true; setDismissed(true); }}
      onCompositionEnd={event => { composing.current = false; setCaret(event.currentTarget.selectionStart); setDismissed(false); }}
      onChange={event => { onChange(event.target.value, bindings); setCaret(event.target.selectionStart); setDismissed(composing.current); }}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onClick={() => setDismissed(false)}
      onKeyDown={event => {
        event.stopPropagation();
        if (composing.current || event.nativeEvent.isComposing) return;
        if (open && ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(event.key)) {
          if (event.key === "Escape" || event.key === "Tab") { setDismissed(true); if (event.key === "Escape") event.preventDefault(); return; }
          event.preventDefault();
          if (event.key === "Enter") choose(active);
          else setActive(index => choices.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length : 0);
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && onSubmit) { event.preventDefault(); onSubmit(); }
      }} />
    {children}
    {open && createPortal(<div ref={menu} id={id} className="prompt-assist-menu prompt-assist-portal nodrag nopan nowheel" style={position} role="listbox" aria-label={trigger?.mode === "mention" ? "素材引用" : "导演指令"}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header>{trigger?.mode === "mention" ? <At /> : <Command />}<span><strong>{trigger?.mode === "mention" ? "引用项目素材" : "导演指令"}</strong><small>输入筛选 · ↑↓ 选择 · Enter 确认 · Esc 关闭</small></span></header>
      {choices.map((item, index) => <button key={item.id} id={`${id}-${index}`} type="button" role="option" aria-selected={index === active} tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>{item.asset ? <MediaPreview asset={item.asset} compact /> : <Command />}<span><strong>{item.label}</strong><small>{item.description}</small></span></button>)}
      {!choices.length && <p>{trigger?.mode === "mention" ? "没有匹配的兼容素材。请检查关键词、参考模式及输入数量。" : "没有匹配的预设指令。"}</p>}
    </div>, document.body)}
  </div>;
}
