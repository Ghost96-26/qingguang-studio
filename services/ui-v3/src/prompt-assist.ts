export interface PromptTrigger { mode: "mention" | "slash"; start: number; end: number; query: string }
export type PromptBindings = Record<string, string>;

/** Match the text before the caret, including Chinese IME full-width triggers. */
export function promptTrigger(text: string, caret: number): PromptTrigger | null {
  const prefix = text.slice(0, caret);
  const match = /([@＠/／])([^@＠/／\s]{0,60})$/u.exec(prefix);
  if (!match) return null;
  const start = match.index;
  if (start && /[A-Za-z0-9_:/.]/.test(prefix[start - 1])) return null;
  return { mode: /[@＠]/.test(match[1]) ? "mention" : "slash", start, end: caret, query: match[2] };
}

export function replacePromptTrigger(text: string, trigger: PromptTrigger, value: string) {
  return { text: text.slice(0, trigger.start) + value + " " + text.slice(trigger.end), caret: trigger.start + value.length + 1 };
}

export function readPromptBindings(value: unknown): PromptBindings {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, id]) => key.startsWith("@「") && typeof id === "string")) as PromptBindings;
  } catch { return {}; }
}

export function mentionToken(name: string, id: string, bindings: PromptBindings): string {
  const existing = Object.keys(bindings).find(key => bindings[key] === id);
  if (existing) return existing;
  const safeName = name.replace(/[\r\n「」]/g, " ");
  const base = `@「${safeName}」`;
  return bindings[base] && bindings[base] !== id ? `@「${safeName} · ${id}」` : base;
}

/** Resolve by stable asset identity and current port order, never by filename. */
export function resolvePromptBindings(text: string, bindings: PromptBindings, labels: Record<string, string>): string {
  return Object.keys(bindings).sort((a, b) => b.length - a.length).reduce((result, token) => {
    if (!result.includes(token)) return result;
    const label = labels[bindings[token]];
    if (!label) throw new Error(`引用已断开或当前模式不支持：${token}。请重新连接素材或删除这段引用。`);
    return result.split(token).join(label);
  }, text);
}
