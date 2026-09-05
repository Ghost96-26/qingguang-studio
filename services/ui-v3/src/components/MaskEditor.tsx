import { BoundingBox, Eraser, NotePencil, PaintBrush, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Asset } from "../types";

type Tool = "brush" | "erase" | "rect" | "note";
type Point = { x: number; y: number };
type Annotation = Point & { text: string };

interface MaskEditorProps {
  asset: Asset;
  initialPrompt: string;
  getUrl: (assetId: string) => Promise<string>;
  onClose: () => void;
  onSave: (file: File, annotation: string) => Promise<void>;
}

export function MaskEditor({ asset, initialPrompt, getUrl, onClose, onSave }: MaskEditorProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const startRef = useRef<Point | null>(null);
  const [url, setUrl] = useState("");
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(72);
  const [note, setNote] = useState("");
  const [instruction, setInstruction] = useState(initialPrompt);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => { void getUrl(asset.id).then(setUrl); }, [asset.id, getUrl]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height,
    };
  };

  const stroke = (from: Point, to: Point, erase = false) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = erase ? "destination-out" : "source-over";
    context.strokeStyle = "rgba(255, 72, 154, .72)";
    context.lineWidth = brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
  };

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);
    if (tool === "note") {
      if (note.trim()) {
        setAnnotations((items) => [...items, { ...point, text: note.trim() }]);
        setNote("");
        setDirty(true);
      }
      return;
    }
    drawingRef.current = true;
    setDirty(true);
    startRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "brush" || tool === "erase") stroke(point, { x: point.x + .01, y: point.y + .01 }, tool === "erase");
  };

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !startRef.current || !["brush", "erase"].includes(tool)) return;
    const next = pointFromEvent(event);
    stroke(startRef.current, next, tool === "erase");
    startRef.current = next;
  };

  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !startRef.current) return;
    const end = pointFromEvent(event);
    if (tool === "rect") {
      const context = canvasRef.current?.getContext("2d");
      if (context) {
        context.save();
        context.fillStyle = "rgba(255, 72, 154, .62)";
        context.fillRect(startRef.current.x, startRef.current.y, end.x - startRef.current.x, end.y - startRef.current.y);
        context.restore();
      }
    }
    drawingRef.current = false;
    startRef.current = null;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setAnnotations([]);
    setDirty(true);
  };

  const requestClose = () => dirty ? setConfirmClose(true) : onClose();

  const save = async () => {
    const source = canvasRef.current;
    if (!source) return;
    setBusy(true);
    try {
      const mask = document.createElement("canvas");
      mask.width = source.width;
      mask.height = source.height;
      const context = mask.getContext("2d", { willReadFrequently: true })!;
      context.fillStyle = "black";
      context.fillRect(0, 0, mask.width, mask.height);
      const sourcePixels = source.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, source.width, source.height);
      const output = context.getImageData(0, 0, mask.width, mask.height);
      for (let index = 0; index < sourcePixels.data.length; index += 4) {
        const selected = sourcePixels.data[index + 3] > 8 ? 255 : 0;
        output.data[index] = selected;
        output.data[index + 1] = selected;
        output.data[index + 2] = selected;
        output.data[index + 3] = 255;
      }
      context.putImageData(output, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => mask.toBlob((value) => value ? resolve(value) : reject(new Error("蒙版导出失败")), "image/png"));
      const regionNotes = annotations.map((item, index) => `${index + 1}. ${item.text}（位置 ${Math.round(item.x)},${Math.round(item.y)}）`).join("\n");
      const text = `${instruction.trim()}${instruction.trim() && regionNotes ? "\n\n" : ""}${regionNotes ? `[定位注释]\n${regionNotes}` : ""}`.trim();
      await onSave(new File([blob], `mask-${Date.now()}.png`, { type: "image/png" }), text);
      setDirty(false);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(<div className="mask-editor-backdrop nodrag nowheel" role="dialog" aria-modal="true" aria-label="画布内蒙版编辑器">
    <section className="mask-editor-shell">
      <header><div><strong>区域编辑</strong><span>在原图上直接框选、涂抹并写注释</span></div><button onClick={requestClose} aria-label="关闭蒙版编辑器"><X /></button></header>
      <div className="mask-editor-toolbar">
        {([
          ["brush", PaintBrush, "涂抹"], ["erase", Eraser, "擦除"], ["rect", BoundingBox, "框选"], ["note", NotePencil, "注释"],
        ] as const).map(([value, Icon, label]) => <button key={value} className={tool === value ? "active" : ""} onClick={() => setTool(value)}><Icon />{label}</button>)}
        <label>笔刷<input type="range" min="16" max="240" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
        {tool === "note" ? <label className="mask-note-input">定位注释<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="输入后点击画面定位" /></label> : null}
        <button className="clear" onClick={clear}><Trash />清空</button>
      </div>
      <div className="mask-editor-stage">
        {url ? <div className="mask-media-wrap">
          <img ref={imageRef} src={url} alt={asset.name} onLoad={(event) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = event.currentTarget.naturalWidth;
            canvas.height = event.currentTarget.naturalHeight;
          }} />
          <canvas ref={canvasRef} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} />
          {annotations.map((item, index) => <span key={`${item.x}-${item.y}-${index}`} className="annotation-pin" style={{ left: `${item.x / Math.max(1, canvasRef.current?.width || 1) * 100}%`, top: `${item.y / Math.max(1, canvasRef.current?.height || 1) * 100}%` }}>{index + 1}</span>)}
        </div> : <span className="mask-loading">正在读取本地原图…</span>}
      </div>
      <footer>
        <label><span>编辑指令 · 将直接同步到生成节点，只需写一次</span><textarea value={instruction} onChange={(event) => { setInstruction(event.target.value); setDirty(true); }} placeholder="例如：把框选区域替换为金色桌灯，保持其他区域不变" /></label>
        <div><small>粉色区域会导出为模型蒙版；编辑指令会同时写入节点，原图不会被覆盖。</small><button className="secondary" onClick={requestClose}>取消</button><button className="primary" onClick={() => void save()} disabled={busy || !instruction.trim()}>{busy ? "正在保存…" : "保存蒙版与指令"}</button></div>
      </footer>
      {confirmClose ? <div className="editor-unsaved-backdrop" role="alertdialog" aria-modal="true" aria-label="未保存的图片编辑"><section><header><strong>有未保存的更改</strong><button onClick={() => setConfirmClose(false)} aria-label="返回编辑"><X /></button></header><p>保存后，蒙版与编辑指令会应用到当前图片编辑节点；直接退出不会修改节点。</p><div><button onClick={onClose}>直接退出</button><button className="primary" onClick={() => void save()} disabled={busy || !instruction.trim()}>{busy ? "正在保存…" : "保存并关闭"}</button></div></section></div> : null}
    </section>
  </div>, document.body);
}
