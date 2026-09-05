import { Aperture, ArrowsClockwise, Copy, CornersOut, FilmSlate, LinkSimple, MagicWand, Minus, MusicNotes, NotePencil, Plus, SelectionSlash, SlidersHorizontal, Sparkle, Stack, Trash, UploadSimple, UsersThree, VideoCamera, Waveform } from "@phosphor-icons/react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type OnMoveEnd,
  type Connection,
  type OnConnectEnd,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasStore } from "../canvas-store";
import { CanvasFocusContext } from "../canvas-focus";
import { inspectorWheelFactor, zoomInspector } from "../focus-layout";
import { defaultTargetPort, deriveOptions, inputCapabilitySummary, mediaLabel, nextCompatiblePort, outputKind, portKind, targetPortLabel } from "../model";
import type { Asset, NodeKind, WorkbenchEdge, WorkbenchNode } from "../types";
import { useWorkspace } from "../workspace-context";
import { WorkbenchNodeView } from "./WorkbenchNode";

const nodeTypes = { workbench: WorkbenchNodeView, group: WorkbenchNodeView };

interface CanvasStageProps {
  assets: Asset[];
  onCreateAt: (kind: NodeKind, position: { x: number; y: number }) => void;
  onAssetAt: (asset: Asset, position: { x: number; y: number }) => void;
  onUploadAt: (files: File[], position: { x: number; y: number }) => Promise<void>;
  onMoveEnd: OnMoveEnd;
  initialViewport: Viewport;
  fitViewOnMount: boolean;
  readOnly: boolean;
}

export function CanvasStage({ assets, onCreateAt, onAssetAt, onUploadAt, onMoveEnd, initialViewport, fitViewOnMount, readOnly }: CanvasStageProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const addDerivedNode = useCanvasStore((state) => state.addDerivedNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const duplicateNodes = useCanvasStore((state) => state.duplicateNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const ungroupNodes = useCanvasStore((state) => state.ungroupNodes);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow<WorkbenchNode>();
  const { notify } = useWorkspace();
  const stageRef = useRef<HTMLElement>(null);
  const contextFileRef = useRef<HTMLInputElement>(null);
  const [dropReady, setDropReady] = useState(false);
  const [connectionMenu, setConnectionMenu] = useState<null | { sourceId: string; output: string; flow: { x: number; y: number }; left: number; top: number }>(null);
  const [paneMenu, setPaneMenu] = useState<null | { flow: { x: number; y: number }; left: number; top: number }>(null);
  const [focus, setFocus] = useState<null | { nodeId: string; scale: number }>(null);
  const selected = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const selectedIds = useMemo(() => selected.map((node) => node.id), [selected]);
  const focusedNodeId = focus?.nodeId || null;
  const detailScale = focus?.scale || 1;
  const closeFocusedNode = useCallback(() => setFocus(null), []);
  useEffect(() => {
    const reveal = (event: Event) => {
      const ids = (event as CustomEvent<{ids: string[]}>).detail?.ids;
      if (!Array.isArray(ids) || !ids.length) return;
      setFocus(null);
      requestAnimationFrame(() => void fitView({nodes: ids.map(id => ({id})), padding: .18, duration: 250, maxZoom: 1}));
    };
    window.addEventListener("clsf:focus-nodes", reveal);
    return () => window.removeEventListener("clsf:focus-nodes", reveal);
  }, [fitView]);
  const zoomDetail = useCallback((factor: number) => {
    setFocus((current) => current ? { ...current, scale: zoomInspector(current.scale, factor) } : null);
  }, []);
  const focusContext = useMemo(() => ({
    focusedNodeId,
    detailScale,
    closeFocusedNode,
  }), [closeFocusedNode, detailScale, focusedNodeId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!focusedNodeId || !stage) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as Element | null;
      // Preserve scrolling inside forms/popovers. Only canvas zoom gestures are
      // redirected; never resize nodes, move ports or serialize inspector zoom.
      if (target?.closest(".nowheel, input, textarea, select, [contenteditable='true'], .react-flow__panel")) return;
      event.preventDefault();
      event.stopPropagation();
      zoomDetail(inspectorWheelFactor(event.deltaY, event.deltaMode, event.ctrlKey));
    };
    stage.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => stage.removeEventListener("wheel", onWheel, true);
  }, [focusedNodeId, zoomDetail]);

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDropReady(false);
    if (readOnly) return;
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const assetId = event.dataTransfer.getData("application/x-workbench-asset");
    if (assetId) {
      const asset = assets.find((item) => item.id === assetId);
      if (asset) onAssetAt(asset, point);
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) await onUploadAt(files, point);
  }, [assets, onAssetAt, onUploadAt, readOnly, screenToFlowPosition]);

  const connect = useCallback((connection: Connection) => {
    if (readOnly) return;
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target) return;
    if (target.data.productionRunId) { notify("制作副本使用确认时的输入，请修改分镜草稿。", "danger"); return; }
    const output = outputKind(source, assets);
    const resolvedPort = connection.targetHandle === "smart_input" ? nextCompatiblePort(target, output, edges) : undefined;
    const targetHandle = resolvedPort?.id || connection.targetHandle;
    if (connection.targetHandle === "smart_input" && !resolvedPort) {
      notify(`无法接入${mediaLabel(output)}。“${target.data.title}”${inputCapabilitySummary(target.data.kind, target.data.params)}，对应输入位已满或当前模式不支持。`, "danger");
      return;
    }
    const accepts = portKind(target.data.kind, target.data.params, targetHandle);
    if (accepts !== "any" && accepts !== output) {
      notify(`无法连接${mediaLabel(output)}：${inputCapabilitySummary(target.data.kind, target.data.params)}。`, "danger");
      return;
    }
    onConnect({ ...connection, targetHandle }, output);
  }, [assets, edges, nodes, notify, onConnect, readOnly]);

  const handleConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    if (readOnly) return;
    if (!state.fromNode || state.toNode || state.fromHandle?.type !== "source") return;
    const target = event.target as Element | null;
    if (!target?.closest(".react-flow__pane")) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const source = nodes.find((node) => node.id === state.fromNode?.id);
    if (!source) return;
    setConnectionMenu({
      sourceId: source.id,
      output: outputKind(source, assets),
      flow: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      left: Math.max(14, Math.min(rect.width - 286, point.clientX - rect.left)),
      top: Math.max(14, Math.min(rect.height - 390, point.clientY - rect.top)),
    });
  }, [assets, nodes, readOnly, screenToFlowPosition]);

  const existingTargets = useMemo(() => connectionMenu ? nodes.flatMap((node) => {
    if (node.id === connectionMenu.sourceId || node.data.kind === "group" || node.data.kind === "asset") return [];
    const port = nextCompatiblePort(node, connectionMenu.output, edges);
    return port ? [{ node, port }] : [];
  }).slice(0, 4) : [], [connectionMenu, edges, nodes]);

  useEffect(() => {
    if (!paneMenu && !connectionMenu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setPaneMenu(null); setConnectionMenu(null); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [connectionMenu, paneMenu]);
  useEffect(() => {
    if (focus && !nodes.some((node) => node.id === focus.nodeId && node.selected)) setFocus(null);
  }, [focus, nodes]);
  useEffect(() => {
    if (!focus) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setFocus(null);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [focus]);

  const paneGroups = [
    { label: "图片", items: [["image_t2i", "图片生成", Aperture], ["image_i2i", "图生图", ArrowsClockwise], ["image_edit", "图片编辑", MagicWand]] },
    { label: "视频", items: [["video", "H3 视频生成", VideoCamera]] },
    { label: "声音", items: [["dialogue", "对白编排", UsersThree], ["music", "音乐生成", MusicNotes], ["sfx", "影视音效", Waveform]] },
    { label: "工具", items: [["media_prepare", "素材适配", SlidersHorizontal], ["note", "便笺", NotePencil], ["group", "镜头分组", FilmSlate]] },
  ] as const;

  return <CanvasFocusContext.Provider value={focusContext}><section ref={stageRef} className={`canvas-stage ${dropReady ? "drop-ready" : ""}`} aria-label="无限创作画布">
    <ReactFlow<WorkbenchNode, WorkbenchEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={connect}
      onConnectEnd={handleConnectEnd}
      onNodeClick={(event, node) => {
        setPaneMenu(null);
        setConnectionMenu(null);
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          setFocus(null);
          return;
        }
        const hasResult = Boolean(node.data.assetId || node.data.assetIds?.length);
        const supportsInspector = !["asset", "group", "note", "media_prepare"].includes(node.data.kind);
        if (!hasResult || !supportsInspector) {
          setFocus(null);
          return;
        }
        setFocus((current) => current?.nodeId === node.id ? current : { nodeId: node.id, scale: 1 });
      }}
      onNodeDragStart={closeFocusedNode}
      onPaneContextMenu={(event) => {
        event.preventDefault();
        if (readOnly) {
          setConnectionMenu(null);
          setPaneMenu(null);
          return;
        }
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return;
        setConnectionMenu(null);
        setFocus(null);
        setPaneMenu({
          flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          left: Math.max(12, Math.min(rect.width - 304, event.clientX - rect.left)),
          top: Math.max(12, Math.min(rect.height - 520, event.clientY - rect.top)),
        });
      }}
      onPaneClick={() => { setPaneMenu(null); setConnectionMenu(null); setFocus(null); }}
      onMoveEnd={onMoveEnd}
      onDrop={handleDrop}
      onDragOver={(event) => { if (readOnly) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropReady(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDropReady(false); }}
      deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      selectionKeyCode="Shift"
      multiSelectionKeyCode={["Shift", "Control", "Meta"]}
      panOnScroll={false}
      zoomOnScroll={!focus}
      zoomOnPinch={!focus}
      zoomOnDoubleClick={!focus}
      selectionOnDrag={!readOnly}
      panOnDrag={[1, 2]}
      minZoom={0.2}
      maxZoom={2.2}
      fitView={fitViewOnMount}
      fitViewOptions={{ padding: 0.18 }}
      defaultViewport={initialViewport}
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgba(132, 143, 170, .38)" />
      <MiniMap pannable zoomable={!focus} position="bottom-left" nodeStrokeWidth={2} nodeColor={(node) => node.data?.kind === "group" ? "rgba(216,174,94,.18)" : node.selected ? "#ef4fa6" : "#353b4b"} maskColor="rgba(5,7,11,.72)" />
      <Panel position="bottom-center" className="canvas-controls">
        <button onClick={() => focus ? zoomDetail(1 / 1.2) : zoomOut()} aria-label={focus ? "缩小编辑框" : "缩小画布"} title={focus ? "仅缩小编辑框，预览保持原位" : "缩小画布"}><Minus /></button>
        <button onClick={() => { closeFocusedNode(); void fitView({ padding: 0.18, duration: 360 }); }} aria-label="适应画布" title="收起编辑框并显示全部节点"><CornersOut /></button>
        <button onClick={() => focus ? zoomDetail(1.2) : zoomIn()} aria-label={focus ? "放大编辑框" : "放大画布"} title={focus ? "仅放大编辑框，预览保持原位" : "放大画布"}><Plus /></button>
      </Panel>
      {!readOnly && selected.length > 1 ? <Panel position="top-center" className="multi-toolbar">
        <span>已选择 {selected.length} 个节点</span>
        <button onClick={() => duplicateNodes(selectedIds)}><Copy />复制</button>
        <button onClick={() => groupNodes(selectedIds)}><Stack />分组</button>
        <button onClick={() => ungroupNodes(selectedIds)}><SelectionSlash />解组</button>
        <button className="danger" onClick={() => deleteNodes(selectedIds)}><Trash />删除</button>
      </Panel> : null}
      <Panel position="top-left" className="canvas-breadcrumb"><strong>{readOnly ? "审片画布" : "创作画布"}</strong><span>{readOnly ? "当前角色可查看、播放与下载授权内容" : "从彩色端口拖出连线，在空白处松开继续创作"}</span></Panel>
      <Panel position="bottom-right" className="canvas-shortcuts">{readOnly ? "只读审片 · 素材菜单可下载" : "Shift 多选　Delete 删除　Ctrl+Z 撤销"}</Panel>
    </ReactFlow>
    {dropReady ? <div className="drop-overlay"><ImagesDropIcon /><strong>释放素材到画布</strong><span>将在当前位置创建可预览素材节点</span></div> : null}
    {connectionMenu ? <>
      <button className="connection-menu-scrim" aria-label="关闭节点菜单" onClick={() => setConnectionMenu(null)} />
      <div className="connection-create-menu" style={{ left: connectionMenu.left, top: connectionMenu.top }}>
        <header><span style={{ background: `var(--port-${connectionMenu.output}, #a9b1c4)` }} /><div><strong>继续创作</strong><small>{mediaLabel(connectionMenu.output)}输出</small></div></header>
        <p>创建新节点</p>
        {deriveOptions(connectionMenu.output).map((option) => <button key={`${option.kind}-${option.label}`} onClick={() => {
          const port = option.port || defaultTargetPort(option.kind, connectionMenu.output, option.params);
          addDerivedNode(connectionMenu.sourceId, option.kind, connectionMenu.flow, port, { params: option.params || {} }, connectionMenu.output);
          notify("已创建兼容节点并自动连接素材。", "success");
          setConnectionMenu(null);
        }}><Sparkle /><span><strong>{option.label}</strong><small>新建并接入{targetPortLabel(option.kind, option.params, option.port || defaultTargetPort(option.kind, connectionMenu.output, option.params))}</small></span></button>)}
        {existingTargets.length ? <><p>连接已有节点</p>{existingTargets.map(({ node, port }) => <button key={node.id} onClick={() => {
          connect({ source: connectionMenu.sourceId, sourceHandle: "output", target: node.id, targetHandle: port.id });
          setConnectionMenu(null);
        }}><LinkSimple /><span><strong>{node.data.title}</strong><small>接入 {port.label}</small></span></button>)}</> : null}
      </div>
    </> : null}
    {paneMenu ? <>
      <button className="connection-menu-scrim" aria-label="关闭创建菜单" onClick={() => setPaneMenu(null)} />
      <div className="pane-create-menu" style={{ left: paneMenu.left, top: paneMenu.top }} role="menu" aria-label="新建画布节点">
        <header><Sparkle weight="duotone" /><span><strong>新建节点</strong><small>在当前位置开始创作</small></span></header>
        <button className="pane-import" onClick={() => contextFileRef.current?.click()}><UploadSimple /><span><strong>导入本地素材</strong><small>图片、视频或音频</small></span></button>
        {paneGroups.map((group) => <section key={group.label}><p>{group.label}</p><div>{group.items.map(([kind, label, Icon]) => <button key={kind} onClick={() => { onCreateAt(kind, paneMenu.flow); setPaneMenu(null); }}><Icon /><span>{label}</span></button>)}</div></section>)}
      </div>
    </> : null}
    <input ref={contextFileRef} hidden disabled={readOnly} type="file" multiple accept="image/*,video/*,audio/*,.txt,.md,.json" onChange={async (event) => { const files = [...(event.target.files || [])]; if (files.length && paneMenu) await onUploadAt(files, paneMenu.flow); event.target.value = ""; setPaneMenu(null); }} />
    {!readOnly ? <button className="canvas-quick-create" onDoubleClick={() => undefined} onClick={() => onCreateAt("image_t2i", screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))}><Plus />快速创建</button> : null}
  </section></CanvasFocusContext.Provider>;
}

function ImagesDropIcon() {
  return <Stack weight="duotone" />;
}
