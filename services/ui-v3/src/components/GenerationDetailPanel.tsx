import { X } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useViewport } from "@xyflow/react";
import { placeInspectorPanel, visibleCanvasRect, type InspectorPlacement } from "../focus-layout";

interface GenerationDetailPanelProps {
  anchor: HTMLElement;
  heading: ReactNode;
  label: string;
  scale: number;
  onClose: () => void;
  children: ReactNode;
}

export function GenerationDetailPanel({ anchor, heading, label, scale, onClose, children }: GenerationDetailPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const viewport = useViewport();
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; placement: InspectorPlacement["placement"]; ready: boolean }>({ left: 12, top: 12, width: 520, maxHeight: window.innerHeight - 24, placement: "below", ready: false });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const stage = anchor.closest<HTMLElement>(".canvas-stage");
    if (!panel || !stage) {
      onClose();
      return;
    }
    const update = () => {
      // Keep the bottom zoom controls reachable even on a narrow app panel.
      const stageRect = visibleCanvasRect(stage.getBoundingClientRect(), window.innerWidth, window.innerHeight - 56);
      const baseWidth = Math.min(540, Math.max(280, (stageRect.width - 24) / scale));
      const measuredHeight = Math.max(260, panel.scrollHeight || panel.offsetHeight || 560);
      const next = placeInspectorPanel(stageRect, anchor.getBoundingClientRect(), {
        width: baseWidth * scale,
        height: measuredHeight * scale,
      });
      const resolved = {
        left: next.left,
        top: next.top,
        width: next.width / scale,
        maxHeight: next.maxHeight / scale,
        placement: next.placement,
        ready: true,
      };
      setPosition((current) => Object.keys(resolved).every((key) => current[key as keyof typeof current] === resolved[key as keyof typeof resolved]) ? current : resolved);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(anchor);
    observer.observe(stage);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchor, onClose, scale, viewport.x, viewport.y, viewport.zoom]);

  const style: CSSProperties = {
    left: position.left,
    top: position.top,
    width: position.width,
    maxHeight: position.maxHeight,
    transform: `scale(${scale})`,
    visibility: position.ready ? "visible" : "hidden",
  };

  return createPortal(
    <aside
      ref={panelRef}
      className="generation-detail-panel nodrag nopan nowheel"
      data-placement={position.placement}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header><span>{heading}</span><button type="button" onClick={onClose} aria-label="关闭详情"><X /></button></header>
      {children}
    </aside>,
    document.body,
  );
}
