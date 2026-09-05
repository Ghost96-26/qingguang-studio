import { X } from "@phosphor-icons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeNodePopover } from "../popover-position";

/** A screen-space layer: opening it never participates in React Flow node sizing. */
export function NodeParameterPopover({ title, anchor, trigger, onClose, children, preferredWidth = 368 }: {
  title: string; anchor: HTMLElement; trigger: HTMLButtonElement; onClose: () => void; children: ReactNode;
  preferredWidth?: number;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 368, maxHeight: window.innerHeight - 24 });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const update = () => {
      const width = Math.min(preferredWidth, window.innerWidth - 24);
      const next = placeNodePopover(anchor.getBoundingClientRect(), { width, height: panel.getBoundingClientRect().height }, { width: window.innerWidth, height: window.innerHeight });
      setPosition(current => Object.keys(next).every(key => next[key as keyof typeof next] === current[key as keyof typeof current]) ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(anchor);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [anchor, preferredWidth]);

  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && (panelRef.current?.contains(target) || anchor.contains(target));
    const dismissOutside = (event: Event) => { if (!inside(event.target)) onClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); onClose(); trigger.focus({ preventScroll: true });
    };
    const otherOpened = (event: Event) => { if ((event as CustomEvent).detail !== id) onClose(); };
    document.dispatchEvent(new CustomEvent("clsf:parameter-popover", { detail: id }));
    document.addEventListener("clsf:parameter-popover", otherOpened);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("wheel", dismissOutside, { capture: true, passive: true });
    document.addEventListener("keydown", escape, true);
    (panelRef.current?.querySelector<HTMLElement>("[aria-checked=true]:not(:disabled)") || panelRef.current?.querySelector<HTMLElement>("button:not(:disabled),select:not(:disabled)"))?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("clsf:parameter-popover", otherOpened);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("wheel", dismissOutside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchor, id, onClose, trigger]);

  return createPortal(<div ref={panelRef} role="dialog" aria-label={title} className="node-parameter-popover nodrag nopan nowheel" style={position}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <header><strong>{title}</strong><button type="button" aria-label="关闭参数面板" onClick={() => { onClose(); trigger.focus({ preventScroll: true }); }}><X /></button></header>
    <div className="node-parameter-popover-content">{children}</div>
  </div>, document.body);
}
