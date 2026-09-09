import "@xyflow/react/dist/style.css";
import { CheckCircle, SpinnerGap } from "@phosphor-icons/react";
import { ReactFlowProvider, type Viewport } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, localAuthenticate, workbenchApi } from "./api";
import { useCanvasStore } from "./canvas-store";
import { videoRenderParams } from "./h3-director";
import { CreativeAgentPanel } from "./components/CreativeAgentPanel";
import { AccountCenter } from "./components/AccountCenter";
import { AdminConsole } from "./components/AdminConsole";
import { AuthScreen } from "./components/AuthScreen";
import { AssetDrawer } from "./components/AssetDrawer";
import { CanvasStage } from "./components/CanvasStage";
import { parseDialogueLines } from "./components/DialogueComposer";
import { HeaderBar } from "./components/HeaderBar";
import { ProjectManager } from "./components/ProjectManager";
import { ToolRail } from "./components/ToolRail";
import { createWorkbenchNode, defaultTargetPort, inputCapabilitySummary, inputPorts, mediaKind, mediaLabel, migrateCanvas, nextCompatiblePort, nodeConfigurationSignature, outputKind, portKind, remapNodeMode, serializeCanvas, videoModeCapability } from "./model";
import type { Asset, AssetFolder, AuthSession, AuthUser, Capabilities, Job, NodeKind, NodeReadiness, Project, ProjectGroup, UsageSummary, WorkbenchNode, WorkbenchParams } from "./types";
import { WorkspaceContext, type WorkspaceContextValue } from "./workspace-context";
import { videoGuidance } from "./video-options";
import { readPromptBindings, resolvePromptBindings } from "./prompt-assist";
import { productionJobBindings, referencedImageIds, storyboardGraph, type AgentRequest, type ProductionRun, type StoryboardPlan } from "./storyboard";

type ToastState = { message: string; tone: "default" | "success" | "danger" } | null;
type ExternalRenameUndo = { label: string; canvasDepth: number; canvasTail: unknown; undo: () => Promise<void> };

const ADMIN_PATH = window.location.pathname.replace(/\/+$/, "") === "/v3/admin";

export function App() {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const replaceGraph = useCanvasStore((state) => state.replaceGraph);
  const addNode = useCanvasStore((state) => state.addNode);
  const addDerivedNode = useCanvasStore((state) => state.addDerivedNode);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const removeEdges = useCanvasStore((state) => state.removeEdges);
  const renameStoreNode = useCanvasStore((state) => state.renameNode);
  const [authState, setAuthState] = useState<"checking" | "ready" | "login">("checking");
  const [authError, setAuthError] = useState("");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [accountUsage, setAccountUsage] = useState<UsageSummary | null>(null);
  const [accountCenterOpen, setAccountCenterOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [projectId, setProjectId] = useState(localStorage.getItem("h3-project-id") || "default");
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetFolders, setAssetFolders] = useState<AssetFolder[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [productions, setProductions] = useState<ProductionRun[]>([]);
  const [assetOpen, setAssetOpen] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(() => window.innerWidth < 900);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 899px)");
    const adapt = () => { if (narrow.matches) setAgentCollapsed(true); };
    narrow.addEventListener("change", adapt);
    return () => narrow.removeEventListener("change", adapt);
  }, []);
  const [toast, setToast] = useState<ToastState>(null);
  const [loaded, setLoaded] = useState(false);
  const [initialViewport, setInitialViewport] = useState<Viewport>({ x: 30, y: 30, zoom: 0.85 });
  const [fitViewOnMount, setFitViewOnMount] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [runtimeStarting, setRuntimeStarting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const viewportRef = useRef<Viewport>(initialViewport);
  const projectIdRef = useRef(projectId);
  const renameUndoRef = useRef<ExternalRenameUndo[]>([]);
  const renameUndoBusyRef = useRef(false);
  const currentProject = projects.find((project) => project.id === projectId);
  const currentProjectRole = currentProject?.current_user_role || "viewer";
  const canEditCurrentProject = currentProjectRole === "owner" || currentProjectRole === "editor";
  const canCreateProjects = Boolean(currentUser?.can_create_projects);

  const pushRenameUndo = useCallback((label: string, undo: () => Promise<void>) => {
    const temporal = useCanvasStore.temporal.getState();
    renameUndoRef.current.push({
      label,
      canvasDepth: temporal.pastStates.length,
      canvasTail: temporal.pastStates.at(-1),
      undo,
    });
  }, []);

  const withoutCanvasHistory = useCallback((action: () => void) => {
    const temporal = useCanvasStore.temporal.getState();
    const wasTracking = temporal.isTracking;
    if (wasTracking) temporal.pause();
    try { action(); } finally { if (wasTracking) temporal.resume(); }
  }, []);

  const notify = useCallback((message: string, tone: "default" | "success" | "danger" = "default") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast((current) => current?.message === message ? null : current), 3600);
  }, []);

  const loadProject = useCallback(async (nextProjectId: string) => {
    setLoaded(false);
    setJobs([]);
    setAssets([]);
    setAssetFolders([]);
    setProductions([]);
    const [canvas, nextJobs, nextAssets, nextFolders, nextProductions] = await Promise.all([
      workbenchApi.canvas(nextProjectId),
      workbenchApi.jobs(nextProjectId),
      workbenchApi.assets(nextProjectId),
      workbenchApi.assetFolders(nextProjectId),
      workbenchApi.productions(nextProjectId),
    ]);
    if (projectIdRef.current !== nextProjectId) return;
    const migrated = migrateCanvas(canvas.state || {}, nextAssets);
    let nextNodes = migrated.nodes;
    const isStarterCanvas = !nextNodes.length;
    if (isStarterCanvas) {
      const starter = [
        createWorkbenchNode("note", { x: 40, y: 30 }, { title: "从这里开始", params: { text: "拖入素材，或从左侧创建节点。从输出端口拖到空白处松开，可继续创建兼容工作流。" } }),
        createWorkbenchNode("image_t2i", { x: 430, y: 30 }, { title: "概念图生成" }),
        createWorkbenchNode("video", { x: 880, y: 80 }, { title: "H3 镜头" }),
      ];
      if (nextAssets[0]) starter.unshift(createWorkbenchNode("asset", { x: -340, y: 30 }, { title: nextAssets[0].name, assetId: nextAssets[0].id }));
      nextNodes = starter;
    }
    replaceGraph(nextNodes, migrated.edges);
    useCanvasStore.temporal.getState().clear();
    renameUndoRef.current = [];
    setAssets(nextAssets);
    setAssetFolders(nextFolders);
    setJobs(nextJobs);
    setProductions(nextProductions);
    setInitialViewport(migrated.viewport);
    setFitViewOnMount(isStarterCanvas);
    viewportRef.current = migrated.viewport;
    setCanvasKey((value) => value + 1);
    projectIdRef.current = nextProjectId;
    localStorage.setItem("h3-project-id", nextProjectId);
    setLoaded(true);
  }, [replaceGraph]);

  const boot = useCallback(async () => {
    if (ADMIN_PATH) {
      setAuthState("ready");
      return;
    }
    const [nextCapabilities, nextProjects, nextGroups, nextUsage] = await Promise.all([
      workbenchApi.capabilities(),
      workbenchApi.projects(true),
      workbenchApi.projectGroups(),
      workbenchApi.accountUsage().catch(() => null),
    ]);
    setCapabilities(nextCapabilities);
    setProjects(nextProjects);
    setProjectGroups(nextGroups);
    setAccountUsage(nextUsage);
    const activeProjects = nextProjects.filter((project) => !project.deleted_at);
    const desired = activeProjects.some((project) => project.id === projectIdRef.current) ? projectIdRef.current : activeProjects[0]?.id || "default";
    setProjectId(desired);
    projectIdRef.current = desired;
    await loadProject(desired);
    setAuthState("ready");
  }, [loadProject]);

  const renameNode = useCallback((id: string) => {
    const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
    if (!node) return;
    withoutCanvasHistory(() => updateNodeData(id, { renameRequestedAt: Date.now() }));
  }, [updateNodeData, withoutCanvasHistory]);

  const undoExternalRename = useCallback(async () => {
    if (renameUndoBusyRef.current) return false;
    const action = renameUndoRef.current.pop();
    if (!action) return false;
    renameUndoBusyRef.current = true;
    try {
      await action.undo();
      notify(`已撤回${action.label}。`, "success");
      return true;
    } catch (error) {
      renameUndoRef.current.push(action);
      notify(`撤回失败：${error instanceof Error ? error.message : String(error)}`, "danger");
      return true;
    } finally {
      renameUndoBusyRef.current = false;
    }
  }, [notify]);

  useEffect(() => {
    localAuthenticate().then(async (session) => { setCurrentUser(session.user); await boot(); }).catch((error) => {
      setAuthError(error instanceof Error ? error.message : String(error));
      setAuthState("login");
    });
  }, [boot]);

  useEffect(() => {
    if (!loaded || authState !== "ready" || !canEditCurrentProject) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const state = serializeCanvas(nodes, edges, viewportRef.current);
      workbenchApi.saveCanvas(projectIdRef.current, state).catch((error) => notify(`画布保存失败：${error.message}`, "danger"));
    }, 850);
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); };
  }, [authState, canEditCurrentProject, edges, loaded, nodes, notify]);

  useEffect(() => {
    if (authState !== "ready" || ADMIN_PATH) return;
    const timer = window.setInterval(async () => {
      try {
        const refreshingProject = projectIdRef.current;
        const [nextJobs, nextAssets, nextProductions] = await Promise.all([workbenchApi.jobs(refreshingProject), workbenchApi.assets(refreshingProject), workbenchApi.productions(refreshingProject)]);
        if (projectIdRef.current !== refreshingProject) return;
        setJobs(nextJobs);
        setAssets(nextAssets);
        setProductions(nextProductions);
        withoutCanvasHistory(() => nextProductions.flatMap(productionJobBindings).forEach(({id, job}) => {
          const node = useCanvasStore.getState().nodes.find(item => item.id === id);
          if (node && job && node.data.jobId !== job.id) updateNodeData(id, {jobId: job.id, jobIds: [job.id]});
        }));
        const byJob = new Map(nextAssets.filter((asset) => asset.origin_job_id).map((asset) => [asset.origin_job_id, asset.id]));
        const current = useCanvasStore.getState().nodes;
        current.forEach((node) => {
          const jobIds = node.data.jobIds?.length ? node.data.jobIds : node.data.jobId ? [node.data.jobId] : [];
          const nextAssetIds = jobIds.map((jobId) => byJob.get(jobId)).filter((assetId): assetId is string => Boolean(assetId));
          if (!nextAssetIds.length) return;
          const currentIds = node.data.assetIds || [];
          const changed = nextAssetIds.length !== currentIds.length || nextAssetIds.some((assetId, index) => assetId !== currentIds[index]);
          const activeAssetId = node.data.assetId && nextAssetIds.includes(node.data.assetId) ? node.data.assetId : nextAssetIds[0];
          if (changed || node.data.assetId !== activeAssetId) updateNodeData(node.id, { assetId: activeAssetId, assetIds: nextAssetIds });
        });
      } catch {
        // The current canvas remains usable when a background refresh misses once.
      }
    }, 3800);
    return () => window.clearInterval(timer);
  }, [authState, updateNodeData, withoutCanvasHistory]);

  useEffect(() => {
    if (authState !== "ready" || ADMIN_PATH) return;
    const refresh = () => workbenchApi.capabilities().then(setCapabilities).catch(() => undefined);
    const timer = window.setInterval(refresh, 12000);
    return () => window.clearInterval(timer);
  }, [authState]);

  useEffect(() => {
    if (authState !== "ready" || ADMIN_PATH) return;
    const refresh = () => workbenchApi.accountUsage().then(setAccountUsage).catch(() => undefined);
    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [authState]);

  useEffect(() => {
    if (authState === "ready" && new URLSearchParams(window.location.search).has("invite")) {
      setAccountCenterOpen(true);
    }
  }, [authState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!canEditCurrentProject) return;
      if ((event.target as HTMLElement)?.matches("input,textarea,select,[contenteditable='true']")) return;
      const temporal = useCanvasStore.temporal.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) temporal.redo();
        else {
          const pendingRename = renameUndoRef.current.at(-1);
          const canvasIsAtRenamePoint = pendingRename
            && temporal.pastStates.length === pendingRename.canvasDepth
            && temporal.pastStates.at(-1) === pendingRename.canvasTail;
          if (canvasIsAtRenamePoint) void undoExternalRename();
          else temporal.undo();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        temporal.redo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        const graph = useCanvasStore.getState();
        const selectedIds = graph.nodes.filter((node) => node.selected).map((node) => node.id);
        event.shiftKey ? graph.ungroupNodes(selectedIds) : graph.groupNodes(selectedIds);
      }
      if (event.key === "F2") {
        event.preventDefault();
        const selected = useCanvasStore.getState().nodes.find((node) => node.selected);
        if (selected) renameNode(selected.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEditCurrentProject, renameNode, undoExternalRename]);

  const addNodeAt = useCallback((kind: NodeKind, position: { x: number; y: number }) => {
    const node = createWorkbenchNode(kind, position);
    addNode({ ...node, selected: true });
    notify(`已创建${node.data.title}节点。`, "success");
  }, [addNode, notify]);

  const quickAdd = useCallback((kind: NodeKind) => {
    const viewport = viewportRef.current;
    addNodeAt(kind, {
      x: (window.innerWidth * 0.46 - viewport.x) / viewport.zoom + Math.random() * 34,
      y: (window.innerHeight * 0.4 - viewport.y) / viewport.zoom + Math.random() * 34,
    });
  }, [addNodeAt]);

  const addAssetAt = useCallback((asset: Asset, position: { x: number; y: number }) => {
    addNode({ ...createWorkbenchNode("asset", position, { title: asset.name, assetId: asset.id }), selected: true });
    notify("素材节点已放入画布。", "success");
  }, [addNode, notify]);

  const uploadAt = useCallback(async (files: File[], position: { x: number; y: number }, folderId?: string | null) => {
    notify(`正在导入 ${files.length} 个素材…`);
    const uploaded: Asset[] = [];
    for (const file of files) uploaded.push(await workbenchApi.upload(projectIdRef.current, file, folderId));
    setAssets((current) => [...uploaded, ...current]);
    uploaded.forEach((asset, index) => addNode(createWorkbenchNode("asset", { x: position.x + index * 34, y: position.y + index * 34 }, { title: asset.name, assetId: asset.id })));
    notify(`已导入 ${uploaded.length} 个素材并创建节点。`, "success");
  }, [addNode, notify]);

  const createAssetFolder = useCallback(async (parentId?: string | null) => {
    const name = window.prompt(parentId ? "新建子文件夹名称" : "新建素材文件夹名称")?.trim();
    if (!name) return;
    const folder = await workbenchApi.createAssetFolder(projectIdRef.current, name, parentId);
    setAssetFolders((current) => [...current, folder]);
    notify("素材文件夹已创建。", "success");
  }, [notify]);

  const renameAssetFolder = useCallback(async (folder: AssetFolder, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === folder.name) return;
    const updated = await workbenchApi.updateAssetFolder(folder.id, { name });
    setAssetFolders((current) => current.map((item) => item.id === updated.id ? updated : item));
    pushRenameUndo("文件夹重命名", async () => {
      const restored = await workbenchApi.updateAssetFolder(folder.id, { name: folder.name });
      setAssetFolders((current) => current.map((item) => item.id === restored.id ? restored : item));
    });
    notify("素材文件夹已重命名。", "success");
  }, [notify, pushRenameUndo]);

  const deleteAssetFolder = useCallback(async (folder: AssetFolder) => {
    if (!window.confirm(`删除文件夹“${folder.name}”？其中素材会移入“未归档”，原文件不会删除。`)) return;
    await workbenchApi.deleteAssetFolder(folder.id);
    const [nextFolders, nextAssets] = await Promise.all([workbenchApi.assetFolders(projectIdRef.current), workbenchApi.assets(projectIdRef.current)]);
    setAssetFolders(nextFolders);
    setAssets(nextAssets);
    notify("文件夹已删除，素材已移入未归档。", "success");
  }, [notify]);

  const moveAsset = useCallback(async (asset: Asset, folderId: string) => {
    const updated = await workbenchApi.updateAsset(asset.id, { folder_id: folderId });
    setAssets((current) => current.map((item) => item.id === updated.id ? updated : item));
    notify("素材已移动到目标文件夹。", "success");
  }, [notify]);

  const renameAsset = useCallback(async (asset: Asset, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === asset.name) return;
    const updated = await workbenchApi.updateAsset(asset.id, { name });
    setAssets((current) => current.map((item) => item.id === updated.id ? updated : item));
    withoutCanvasHistory(() => useCanvasStore.getState().nodes.filter((node) => node.data.assetId === updated.id).forEach((node) => renameStoreNode(node.id, updated.name)));
    pushRenameUndo("素材重命名", async () => {
      const restored = await workbenchApi.updateAsset(asset.id, { name: asset.name });
      setAssets((current) => current.map((item) => item.id === restored.id ? restored : item));
      withoutCanvasHistory(() => useCanvasStore.getState().nodes.filter((node) => node.data.assetId === restored.id).forEach((node) => renameStoreNode(node.id, restored.name)));
    });
    notify("素材已重命名。", "success");
  }, [notify, pushRenameUndo, renameStoreNode, withoutCanvasHistory]);

  const inspectAsset = useCallback(async (assetId: string) => {
    const inspected = await workbenchApi.inspectAsset(assetId);
    setAssets((current) => current.map((asset) => asset.id === inspected.id ? inspected : asset));
    return inspected;
  }, []);

  const downloadAsset = useCallback(async (asset: Asset) => {
    try {
      const ticket = await workbenchApi.createDownloadTicket(asset.id, 15);
      const link = document.createElement("a");
      link.href = ticket.url;
      link.download = asset.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      notify("已创建15分钟有效的安全下载任务。", "success");
    } catch (error) {
      notify(`下载失败：${error instanceof Error ? error.message : String(error)}`, "danger");
    }
  }, [notify]);

  const saveMask = useCallback(async (nodeId: string, file: File, instruction: string) => {
    const graph = useCanvasStore.getState();
    const target = graph.nodes.find((node) => node.id === nodeId);
    if (!target) throw new Error("图片编辑节点已不存在");
    const unfiled = assetFolders.find((folder) => folder.system_key === "unfiled");
    const mask = await workbenchApi.upload(projectIdRef.current, file, unfiled?.id);
    setAssets((current) => [mask, ...current]);
    const maskNode = { ...createWorkbenchNode("asset", {
      x: target.position.x - 390,
      y: target.position.y + 190,
    }, { title: `蒙版 · ${target.data.title}`, assetId: mask.id }), hidden: true };
    addNode(maskNode);
    connectNodes({ source: maskNode.id, sourceHandle: "output", target: nodeId, targetHandle: "mask_image" }, "image");
    if (instruction.trim()) updateNodeData(nodeId, { params: { ...target.data.params, prompt: instruction.trim() } });
    notify("蒙版和编辑指令已一次保存，并接入图片编辑节点。", "success");
  }, [addNode, assetFolders, connectNodes, notify, updateNodeData]);

  const deriveNode = useCallback((sourceId: string, kind: NodeKind, targetPort?: string, params?: WorkbenchParams) => {
    const graph = useCanvasStore.getState();
    const source = graph.nodes.find((node) => node.id === sourceId);
    if (!source) return;
    const sourceType = outputKind(source, assets);
    const port = targetPort || defaultTargetPort(kind, sourceType, params);
    addDerivedNode(sourceId, kind, { x: source.position.x + (source.measured?.width || 340) + 150, y: source.position.y + 10 }, port, { params: params || {} }, sourceType);
    notify("已创建下游节点并自动连接素材。", "success");
  }, [addDerivedNode, assets, notify]);

  const connectedAssetPath = useCallback((nodeId: string, targetHandle: string) => {
    const graph = useCanvasStore.getState();
    const edge = graph.edges.find((item) => item.target === nodeId && item.targetHandle === targetHandle);
    const source = graph.nodes.find((item) => item.id === edge?.source);
    return assets.find((asset) => asset.id === source?.data.assetId)?.source_path || null;
  }, [assets]);

  const connectedAssetPaths = useCallback((nodeId: string, targetPrefix: string) => {
    const graph = useCanvasStore.getState();
    return graph.edges
      .filter((edge) => edge.target === nodeId && String(edge.targetHandle || "").startsWith(targetPrefix))
      .sort((left, right) => String(left.targetHandle).localeCompare(String(right.targetHandle)))
      .map((edge) => {
        const source = graph.nodes.find((item) => item.id === edge.source);
        return assets.find((asset) => asset.id === source?.data.assetId)?.source_path;
      })
      .filter((path): path is string => Boolean(path));
  }, [assets]);

  const getNodeReadiness = useCallback((nodeId: string): NodeReadiness => {
    const graph = useCanvasStore.getState();
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return { ready: false, reason: "节点已不存在" };
    if (node.data.productionRunId) return {ready: false, reason: "制作副本由 Agent 队列控制；修改请使用分镜草稿"};
    if (["asset", "note", "group"].includes(node.data.kind)) return { ready: false, reason: "此节点无需运行" };

    const dialogueCompose = node.data.kind === "dialogue" && String(node.data.params.dialogue_mode || "compose") === "compose";
    if (dialogueCompose && (!capabilities?.providers?.tts?.ready || !capabilities?.providers?.audio_tools?.ready)) return { ready: false, reason: "多人对白需要 IndexTTS 2.5 与本地音频工具同时就绪" };
    const provider = node.data.kind === "video" ? capabilities?.providers?.h3
      : node.data.kind.startsWith("image_") ? capabilities?.providers?.image
        : node.data.kind === "tts" ? capabilities?.providers?.tts
          : node.data.kind === "music" ? capabilities?.providers?.music
            : node.data.kind === "sfx" ? capabilities?.providers?.foley
            : capabilities?.providers?.audio_tools;
    if (!provider?.ready) return { ready: false, reason: node.data.kind === "video" || node.data.kind.startsWith("image_") ? "本地 GPU 引擎未启动" : "对应的本地模型尚未就绪" };
    if (node.data.kind.startsWith("image_")) {
      const selectedModel = capabilities?.providers?.image?.models?.find((model) => model.id === node.data.params.model_id);
      if (selectedModel && !selectedModel.ready) return { ready: false, reason: `${selectedModel.label} 尚未通过本地就绪检查` };
    }

    const incoming = graph.edges.filter((edge) => edge.target === node.id);
    const ports = inputPorts(node.data.kind, node.data.params);
    for (const edge of incoming) {
      const source = graph.nodes.find((item) => item.id === edge.source);
      const descriptor = ports.find((port) => port.id === edge.targetHandle);
      if (!source || !descriptor) return { ready: false, reason: "存在已失效的素材连接，请重新接入" };
      const output = outputKind(source, assets);
      if (descriptor.accepts !== "any" && descriptor.accepts !== output) return { ready: false, reason: `${mediaLabel(output)}素材与当前输入角色不匹配` };
    }
    const handles = new Set(incoming.map((edge) => edge.targetHandle));
    const prompt = String(node.data.params.prompt || "").trim();
    if (["image_t2i", "image_i2i", "image_edit", "video", "music", "sfx"].includes(node.data.kind) && !prompt) return { ready: false, reason: "请先输入创作提示词" };
    if (node.data.kind === "image_i2i" && !handles.has("source_image")) return { ready: false, reason: "请接入一张源图片" };
    if (node.data.kind === "image_edit" && !handles.has("source_image")) return { ready: false, reason: "请接入待编辑图片" };
    if (node.data.kind === "video") {
      const mode = String(node.data.params.mode || "t2v");
      if (mode === "i2v" && !handles.has("first_frame")) return { ready: false, reason: "请接入首帧图片" };
      if (mode === "fl2v" && (!handles.has("first_frame") || !handles.has("last_frame"))) return { ready: false, reason: "请同时接入首帧和尾帧" };
      if (mode === "reference" && !incoming.length) return { ready: false, reason: "请至少接入一项参考素材" };
      if (mode === "audio_drive" && !handles.has("guide_audio")) return { ready: false, reason: "请接入对白或引导音频" };
    }
    if (node.data.kind === "tts") {
      if (!String(node.data.params.text || "").trim()) return { ready: false, reason: "请输入角色台词" };
      if (!handles.has("reference_audio")) return { ready: false, reason: "请接入角色参考音色" };
    }
    if (node.data.kind === "dialogue") {
      if (dialogueCompose) {
        const lines = parseDialogueLines(node.data.params.dialogue_lines);
        if (!lines.length || lines.some((line) => !line.text.trim())) return { ready: false, reason: "请填写每一行角色台词" };
        const missingVoice = [...new Set(lines.map((line) => line.voice_slot))].find((slot) => !handles.has(`voice_${slot}`));
        if (missingVoice) return { ready: false, reason: `请为音色 ${missingVoice} 接入角色参考音频` };
      } else if (incoming.length < 2) return { ready: false, reason: "请至少接入两段已生成对白" };
    }
    if (node.data.kind === "sfx" && !handles.has("source_video")) return { ready: false, reason: "请接入需要生成拟音的视频" };
    if (node.data.kind === "media_prepare" && !handles.has("media_input")) return { ready: false, reason: "请接入需要适配的素材" };
    return { ready: true, reason: "可以加入本地队列" };
  }, [assets, capabilities]);

  const changeVideoMode = useCallback((nodeId: string, mode: string) => {
    const graph = useCanvasStore.getState();
    if (graph.nodes.find(node => node.id === nodeId)?.data.productionRunId) { notify("制作副本使用确认时的参数，请修改分镜草稿。", "danger"); return; }
    const migration = remapNodeMode(nodeId, mode, graph.nodes, graph.edges, assets);
    replaceGraph(migration.nodes, migration.edges);
    const changed = migration.moved + migration.removed;
    const capability = videoModeCapability(mode);
    notify(`已切换为${capability.label}。${capability.description}${changed ? `；自动整理 ${changed} 条旧连接` : ""}。`, "success");
  }, [assets, notify, replaceGraph]);

  const disconnectInput = useCallback((edgeId: string) => {
    const graph = useCanvasStore.getState();
    const edge = graph.edges.find(item => item.id === edgeId);
    if (graph.nodes.find(node => node.id === edge?.target)?.data.productionRunId) { notify("制作副本使用确认时的输入，请修改分镜草稿。", "danger"); return; }
    removeEdges([edgeId]);
    notify("已移除这项参考素材。", "success");
  }, [notify, removeEdges]);

  const attachAsset = useCallback((nodeId: string, assetId: string, requestedPort?: string) => {
    const graph = useCanvasStore.getState();
    const target = graph.nodes.find((node) => node.id === nodeId);
    const selectedAsset = assets.find((asset) => asset.id === assetId);
    if (!target || !selectedAsset || !canEditCurrentProject || target.data.productionRunId) return false;
    const alreadyConnected = graph.edges.some(edge => edge.target === nodeId && graph.nodes.find(item => item.id === edge.source)?.data.assetId === assetId
      && inputPorts(target.data.kind, target.data.params).some(port => port.id === edge.targetHandle && (port.accepts === "any" || port.accepts === mediaKind(selectedAsset))));
    if (alreadyConnected) return true;
    const output = mediaKind(selectedAsset);
    const requested = requestedPort ? inputPorts(target.data.kind, target.data.params).find((port) => port.id === requestedPort) : undefined;
    const port = requested && requested.accepts === output ? requested : nextCompatiblePort(target, output, graph.edges);
    if (!port) {
      notify(`无法添加${mediaLabel(output)}：${inputCapabilitySummary(target.data.kind, target.data.params)}。`, "danger");
      return false;
    }
    const duplicate = graph.edges.some((edge) => {
      if (edge.target !== nodeId) return false;
      return graph.nodes.find((node) => node.id === edge.source)?.data.assetId === assetId;
    });
    if (duplicate) { notify("这项素材存在不兼容的旧连线，请先移除旧连线。", "danger"); return false; }
    const descendants = new Set<string>([nodeId]);
    const visit = (id: string) => graph.edges.filter(edge => edge.source === id).forEach(edge => {
      if (!descendants.has(edge.target)) { descendants.add(edge.target); visit(edge.target); }
    });
    visit(nodeId);
    let source = graph.nodes.find((node) => !descendants.has(node.id) && node.data.assetId === assetId);
    if (!source) {
      const incomingCount = graph.edges.filter((edge) => edge.target === nodeId).length;
      source = createWorkbenchNode("asset", {
        x: target.position.x - 310,
        y: target.position.y + Math.min(300, incomingCount * 42),
      }, { title: selectedAsset.name, assetId: selectedAsset.id });
      addNode(source);
    }
    connectNodes({ source: source.id, sourceHandle: "output", target: nodeId, targetHandle: port.id }, output);
    notify(`已将${mediaLabel(output)}添加为“${port.label}”。`, "success");
    return true;
  }, [addNode, assets, canEditCurrentProject, connectNodes, notify]);

  const startRuntime = useCallback(async () => {
    if (runtimeStarting) return;
    setRuntimeStarting(true);
    notify("正在启动本地 GPU 引擎，首次加载可能需要约一分钟…");
    try {
      const result = await workbenchApi.startRuntime();
      setCapabilities(result.capabilities);
      notify("本地 GPU 引擎已就绪。", "success");
    } catch (error) {
      notify(`引擎启动失败：${error instanceof Error ? error.message : String(error)}`, "danger");
      throw error;
    } finally {
      setRuntimeStarting(false);
    }
  }, [notify, runtimeStarting]);

  const validateNodeInputs = useCallback((node: WorkbenchNode) => {
    const graph = useCanvasStore.getState();
    for (const edge of graph.edges.filter((item) => item.target === node.id)) {
      const source = graph.nodes.find((item) => item.id === edge.source);
      if (!source) continue;
      const output = outputKind(source, assets);
      const descriptor = inputPorts(node.data.kind, node.data.params).find((port) => port.id === edge.targetHandle);
      if (!descriptor && edge.targetHandle !== "input") {
        throw new Error(`当前“${node.data.title}”模式不存在 ${edge.targetHandle} 端口。请删除旧连线后重新连接。`);
      }
      const accepts = descriptor?.accepts || portKind(node.data.kind, node.data.params, edge.targetHandle);
      if (accepts !== "any" && accepts !== output) {
        throw new Error(`连线类型不匹配：${mediaLabel(output)}不能进入${mediaLabel(accepts)}端口。请删除旧连线后按颜色重新连接。`);
      }
    }
  }, [assets]);

  const compileH3 = useCallback(async (id: string) => {
    const graph = useCanvasStore.getState();
    const node = graph.nodes.find(item => item.id === id);
    if (!node || node.data.kind !== "video") throw new Error("视频节点不存在");
    return workbenchApi.compileH3(videoRenderParams(node, graph.nodes, graph.edges, assets));
  }, [assets]);

  const runNode = useCallback(async (id: string) => {
    const graph = useCanvasStore.getState();
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) return;
    const readiness = getNodeReadiness(id);
    if (!readiness.ready) { notify(readiness.reason, "danger"); return; }
    try { validateNodeInputs(node); } catch (error) { notify(error instanceof Error ? error.message : String(error), "danger"); return; }
    const params: Record<string, unknown> = { ...node.data.params };
    if (node.data.kind.startsWith("image_")) {
      const ordered = inputPorts(node.data.kind, node.data.params).flatMap(port => graph.edges.filter(edge => edge.target === id && edge.targetHandle === port.id).map(edge => graph.nodes.find(item => item.id === edge.source)?.data.assetId)).filter(Boolean);
      params.prompt = resolvePromptBindings(String(params.prompt || ""), readPromptBindings(params.prompt_bindings_json), Object.fromEntries(ordered.map((assetId, index) => [assetId, `参考图${index + 1}`])));
    }
    const batchCount = node.data.kind.startsWith("image_") ? Math.max(1, Math.min(4, Number(params.batch_count || 1))) : 1;
    delete params.batch_count;
    let type = "";
    if (node.data.kind === "image_t2i") type = "image.t2i";
    if (node.data.kind === "image_i2i") { type = "image.i2i"; params.source_image = connectedAssetPath(id, "source_image"); params.style_image = connectedAssetPath(id, "style_image"); }
    if (node.data.kind === "image_edit") { type = "image.edit"; params.source_image = connectedAssetPath(id, "source_image"); params.reference_image = connectedAssetPath(id, "reference_image"); params.mask_image = connectedAssetPath(id, "mask_image"); }
    if (node.data.kind === "video") {
      type = "h3.t2v";
      Object.assign(params, videoRenderParams(node, graph.nodes, graph.edges, assets));
    }
    if (node.data.kind === "tts") { type = "tts.clone"; params.reference_audio = connectedAssetPath(id, "reference_audio"); }
    if (node.data.kind === "dialogue") {
      const compose = String(node.data.params.dialogue_mode || "compose") === "compose";
      if (compose) {
        type = "dialogue.generate";
        params.lines = parseDialogueLines(node.data.params.dialogue_lines).map((line) => ({ ...line, reference_audio: connectedAssetPath(id, `voice_${line.voice_slot}`) }));
        delete params.dialogue_lines;
      } else {
        type = "audio.sequence";
        params.inputs = connectedAssetPaths(id, "audio_");
      }
    }
    if (node.data.kind === "music") {
      type = "music.generate";
      const audioMode = String(params.audio_mode || "music");
      if (audioMode === "score") {
        params.prompt = `影视场景配乐、服从画面节奏与情绪弧线：${String(params.prompt || "")}`;
        if (!String(params.lyrics || "").trim()) params.lyrics = "[Instrumental]";
      }
    }
    if (node.data.kind === "sfx") {
      type = "foley.generate";
      params.video_path = connectedAssetPath(id, "source_video");
    }
    if (node.data.kind === "media_prepare") { type = "media.normalize"; params.source_path = connectedAssetPath(id, "media_input"); }
    if (!type) { notify("这个节点不需要运行。", "danger"); return; }
    if (type === "media.normalize" && !params.source_path) { notify("请先把素材连接到“原始素材”端口。", "danger"); return; }
    try {
      const created: Job[] = [];
      for (let index = 0; index < batchCount; index += 1) {
        const batchParams = batchCount > 1 ? { ...params, seed: Number(params.seed || 0) + index } : params;
        created.push(await workbenchApi.createJob(projectIdRef.current, type, batchParams, type === "h3.t2v" ? 100 : 120));
      }
      updateNodeData(id, { jobId: created[0].id, jobIds: created.map((job) => job.id), assetId: undefined, assetIds: [], runSignature: nodeConfigurationSignature(node, graph.edges) });
      setJobs((current) => [...created, ...current]);
      notify(batchCount > 1 ? `${batchCount} 个图片任务已叠放加入本地队列。` : "任务已加入本地 GPU 队列。", "success");
    } catch (error) {
      notify(`任务提交失败：${error instanceof Error ? error.message : String(error)}`, "danger");
      throw error;
    }
  }, [assets, connectedAssetPath, connectedAssetPaths, getNodeReadiness, notify, updateNodeData, validateNodeInputs]);

  const optimizePrompt = useCallback(async (id: string) => {
    const graph = useCanvasStore.getState();
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) return;
    const current = String(node.data.params.prompt || "").trim();
    if (!current) return;
    const modelId = String(node.data.params.prompt_model || capabilities?.providers?.agent?.default_model || "qwen3.6-27b-q4");
    const originProject = projectIdRef.current;
    const director = node.data.kind === "video" && node.data.params.h3_ir_enabled === true;
    const videoParams = director ? videoRenderParams(node, graph.nodes, graph.edges, assets) : null;
    const originalSnapshot = JSON.stringify(videoParams);
    const guidance = node.data.kind === "video" ? videoGuidance(node.data.params) : [];
    const direction = guidance.length ? `\n以下风格与摄影选项由系统在生成时另行附加，请使正文与它们相容，但不要在输出中重复这些描述：\n${guidance.join("\n")}\n` : "";
    const instruction = `你是擎光绘影的专业提示词导演。请针对${node.data.kind.includes("image") ? "高质量图片生成/编辑" : node.data.kind === "video" ? "电影级视频生成" : node.data.kind === "sfx" ? "影视拟音生成；只描述可听见的声音、材质、空间、距离和时间变化，不写音乐或对白" : "音乐生成"}优化下面的提示词。保持原意与主体身份，不添加用户没有要求的角色，不解释，只输出可直接使用的中文提示词。${node.data.kind === "video" && node.data.params.mode === "reference" ? "使用<Picture 1>等与素材顺序一致的标准标记，明确参考素材的作用。" : ""}${direction}\n${current}`;
    const job = await workbenchApi.createJob(originProject, director ? "agent.h3_ir" : "agent.chat", director ? { video_params: videoParams, model_id: modelId } : { prompt: instruction, model_id: modelId, max_tokens: 900, context: 8192, temperature: 0.2, reasoning: false }, 80);
    setJobs((items) => [job, ...items]);
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1100));
      const currentJob = await api<Job>(`/v1/jobs/${job.id}`);
      if (currentJob.status === "succeeded") {
        const text = String((currentJob.result as { text?: string } | null)?.text || "").trim();
        const latestGraph = useCanvasStore.getState();
        const latestNode = latestGraph.nodes.find(item => item.id === id);
        let applied = false;
        if (latestNode && projectIdRef.current === originProject) {
          if (director) {
            const result = currentJob.result as { director_json?: string } | null;
            if (result?.director_json && JSON.stringify(videoRenderParams(latestNode, latestGraph.nodes, latestGraph.edges, assets)) === originalSnapshot) {
              updateNodeData(id, { params: { ...latestNode.data.params, director_json: result.director_json } });
              applied = true;
            }
          } else if (text && String(latestNode.data.params.prompt || "").trim() === current) {
            updateNodeData(id, { params: { ...latestNode.data.params, prompt: text } });
            applied = true;
          }
        }
        setJobs((items) => items.map((item) => item.id === currentJob.id ? currentJob : item));
        notify(applied ? (director ? "H3-IR增强已应用；原文、素材绑定与台词保持不变。" : "提示词优化完成。") : "配置或项目已改变，保留你的输入；优化结果可在任务记录查看。", applied ? "success" : "default");
        return;
      }
      if (["failed", "cancelled"].includes(currentJob.status)) throw new Error(currentJob.error || "提示词优化未完成");
    }
    throw new Error("提示词优化等待超时");
  }, [assets, capabilities, notify, updateNodeData]);

  const sendAgent = useCallback(async (request: AgentRequest) => {
    if (!canEditCurrentProject) throw new Error("当前项目为只读权限。");
    const sendingProject = projectIdRef.current;
    const refs = request.assetIds.map(id => {
      const asset = assets.find(item => item.id === id && item.project_id === sendingProject);
      if (!asset) throw new Error("引用素材不属于当前项目或已不可用。");
      return {id, name: asset.name, description: request.descriptions[id] || ""};
    });
    const instruction = `你是本地创作顾问。本次只回答创作问题，不声称已经执行任务。你未收到图片像素，仅有用户提供的素材名称和描述。\n参考素材：${JSON.stringify(refs)}\n用户请求：${request.prompt}`;
    const job = request.skill === "storyboard"
      ? await workbenchApi.planStoryboard(sendingProject, request)
      : await workbenchApi.createJob(sendingProject, "agent.chat", { prompt: instruction, user_brief: request.prompt, model_id: request.modelId, max_tokens: 2400, context: 12288, temperature: 0.25, reasoning: false }, 70);
    if (projectIdRef.current !== sendingProject) return;
    setJobs(current => [job, ...current]);
    notify(request.skill === "storyboard" ? "已提交分镜规划，完成后可审核并创建节点。" : "已提交创作问答。", "success");
  }, [assets, canEditCurrentProject, notify]);

  const materializeStoryboard = useCallback((job: Job, run?: ProductionRun) => {
    if (!canEditCurrentProject || job.project_id !== projectIdRef.current || job.status !== "succeeded") throw new Error("当前项目无权使用此分镜方案。");
    const plan = job.result?.storyboard as StoryboardPlan | undefined;
    if (!plan || !Array.isArray(plan.shots)) throw new Error("分镜方案尚未完成。");
    const graph = useCanvasStore.getState();
    const next = storyboardGraph(job.id, plan, assets, graph.nodes, graph.edges, run);
    if (next.nodes.length !== graph.nodes.length || next.edges.length !== graph.edges.length || next.nodes.some((node, index) => node !== graph.nodes[index])) replaceGraph(next.nodes, next.edges);
    const prefix = run ? `production-${run.id}` : `plan-${job.id}`;
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("clsf:focus-nodes", {detail: {ids: plan.shots.map(shot => `${prefix}-${shot.id}`)}})));
    notify(run ? "已创建制作副本，结果将自动回到对应节点。" : "已创建分镜草稿，可编辑；尚未提交生成。", "success");
  }, [assets, canEditCurrentProject, notify, replaceGraph]);

  const executeStoryboard = useCallback(async (job: Job, score: boolean) => {
    if (!canEditCurrentProject || job.project_id !== projectIdRef.current) throw new Error("当前项目无权执行此方案。");
    const sendingProject = projectIdRef.current;
    const run = await workbenchApi.executeStoryboard(job.id, score);
    if (projectIdRef.current !== sendingProject) return;
    setProductions(current => [run, ...current.filter(item => item.id !== run.id)]);
    materializeStoryboard(job, run);
  }, [canEditCurrentProject, materializeStoryboard]);

  const controlProduction = useCallback(async (run: ProductionRun, action: "cancel" | "resume") => {
    if (!canEditCurrentProject || run.project_id !== projectIdRef.current) throw new Error("当前项目无权控制此任务。");
    const updated = await workbenchApi.controlProduction(run.id, action);
    if (projectIdRef.current === run.project_id) setProductions(current => current.map(item => item.id === run.id ? updated : item));
  }, [canEditCurrentProject]);

  const showProduction = useCallback(async (run: ProductionRun) => {
    try {
      if (!canEditCurrentProject || run.project_id !== projectIdRef.current) return;
      const job = jobs.find(item => item.id === run.plan_job_id) || await workbenchApi.job(run.plan_job_id);
      if (run.project_id === projectIdRef.current) materializeStoryboard(job, run);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "danger"); }
  }, [canEditCurrentProject, jobs, materializeStoryboard, notify]);

  const changeProject = useCallback(async (next: string) => {
    setProjectId(next);
    projectIdRef.current = next;
    await loadProject(next);
  }, [loadProject]);

  const refreshProjects = useCallback(async (preferredProjectId?: string) => {
    const nextProjects = await workbenchApi.projects(true);
    setProjects(nextProjects);
    const activeProjects = nextProjects.filter((project) => !project.deleted_at);
    const preferred = preferredProjectId && activeProjects.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : activeProjects.some((project) => project.id === projectIdRef.current)
        ? projectIdRef.current
        : activeProjects[0]?.id;
    if (preferred && preferred !== projectIdRef.current) await changeProject(preferred);
  }, [changeProject]);

  const createProject = useCallback(async () => {
    const name = window.prompt("新项目名称")?.trim();
    if (!name) return;
    const project = await workbenchApi.createProject(name);
    setProjects((current) => [project, ...current]);
    setProjectId(project.id);
    projectIdRef.current = project.id;
    await loadProject(project.id);
  }, [loadProject]);

  const renameProject = useCallback(async (project: Project, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === project.name) return;
    const updated = await workbenchApi.updateProject(project.id, { name });
    setProjects((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
    pushRenameUndo("项目重命名", async () => {
      const restored = await workbenchApi.updateProject(project.id, { name: project.name });
      setProjects((current) => current.map((item) => item.id === restored.id ? { ...item, ...restored } : item));
    });
    notify("项目已重命名。", "success");
  }, [notify, pushRenameUndo]);

  const moveProject = useCallback(async (targetProjectId: string, groupId: string | null) => {
    const updated = await workbenchApi.updateProject(targetProjectId, { group_id: groupId });
    setProjects((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
    notify(groupId ? "项目已移动到分组。" : "项目已移至未分组。", "success");
  }, [notify]);

  const trashProject = useCallback(async (project: Project) => {
    if (!window.confirm(`将“${project.name}”移入回收站？画布和素材仍可恢复。`)) return;
    const removed = await workbenchApi.trashProject(project.id);
    setProjects((current) => current.map((item) => item.id === removed.id ? { ...item, ...removed } : item));
    if (project.id === projectIdRef.current) {
      const fallback = projects.find((item) => item.id !== project.id && !item.deleted_at) || projects.find((item) => item.id === "default");
      if (fallback) { setProjectId(fallback.id); projectIdRef.current = fallback.id; await loadProject(fallback.id); }
    }
    notify("项目已移入回收站，可随时恢复。", "success");
  }, [loadProject, notify, projects]);

  const restoreProject = useCallback(async (project: Project) => {
    const restored = await workbenchApi.restoreProject(project.id);
    setProjects((current) => current.map((item) => item.id === restored.id ? { ...item, ...restored } : item));
    notify("项目已恢复。", "success");
  }, [notify]);

  const createProjectGroup = useCallback(async () => {
    const name = window.prompt("新分组名称")?.trim();
    if (!name) return;
    const group = await workbenchApi.createProjectGroup(name);
    setProjectGroups((current) => [...current, group]);
    notify("项目分组已创建。", "success");
  }, [notify]);

  const renameProjectGroup = useCallback(async (group: ProjectGroup, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === group.name) return;
    const updated = await workbenchApi.renameProjectGroup(group.id, name);
    setProjectGroups((current) => current.map((item) => item.id === updated.id ? updated : item));
    pushRenameUndo("项目分组重命名", async () => {
      const restored = await workbenchApi.renameProjectGroup(group.id, group.name);
      setProjectGroups((current) => current.map((item) => item.id === restored.id ? restored : item));
    });
    notify("分组已重命名。", "success");
  }, [notify, pushRenameUndo]);

  const deleteProjectGroup = useCallback(async (group: ProjectGroup) => {
    if (!window.confirm(`删除分组“${group.name}”？其中的项目会移至“未分组”，不会删除。`)) return;
    await workbenchApi.deleteProjectGroup(group.id);
    setProjectGroups((current) => current.filter((item) => item.id !== group.id));
    setProjects((current) => current.map((project) => project.group_id === group.id ? { ...project, group_id: null } : project));
    notify("分组已删除，项目已移至未分组。", "success");
  }, [notify]);

  const batchFinal = useCallback(async () => {
    const approved = jobs.filter((job) => job.type === "h3.t2v" && job.status === "succeeded" && job.approval_status === "approved" && !job.final_job_id);
    if (!approved.length) { notify("当前没有等待进入终稿队列的已审批预览。", "danger"); return; }
    await api("/v1/finals/batch", { method: "POST", body: JSON.stringify({ preview_job_ids: approved.map((job) => job.id), mode: "reproduce", steps: 20, priority: 200 }) });
    notify(`已将 ${approved.length} 条预览加入复现终稿队列。`, "success");
  }, [jobs, notify]);

  const workspaceValue = useMemo<WorkspaceContextValue>(() => ({
    assets,
    jobs,
    capabilities,
    projectId,
    canEditProject: Boolean(canEditCurrentProject),
    canReviewProject: currentProjectRole !== "viewer",
    reviewJob: async (jobId, status) => {
      const updated = await workbenchApi.reviewJob(jobId, status);
      setJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
      notify(status === "approved" ? "预览已通过审核，可由制作成员排入终稿。" : status === "rejected" ? "已标记为需要修改。" : "已恢复为待审核。", "success");
    },
    notify,
    renameNode,
    deriveNode,
    runNode,
    optimizePrompt,
    compileH3,
    getPlaybackUrl: workbenchApi.playback,
    inspectAsset,
    saveMask,
    changeVideoMode,
    disconnectInput,
    attachAsset,
    getNodeReadiness,
    startRuntime,
    runtimeStarting,
  }), [assets, attachAsset, canEditCurrentProject, currentProjectRole, capabilities, changeVideoMode, compileH3, deriveNode, disconnectInput, getNodeReadiness, inspectAsset, jobs, notify, optimizePrompt, projectId, renameNode, runNode, runtimeStarting, saveMask, startRuntime]);

  if (authState === "checking") return <div className="boot-screen"><span><SpinnerGap className="spin" /></span><strong>正在连接本地创作引擎</strong><small>模型与素材不会离开这台设备</small></div>;
  if (authState === "login") return <AuthScreen error={authError} onAuthenticated={async (session: AuthSession) => { setCurrentUser(session.user); await boot(); }} />;
  if (!currentUser) return <AuthScreen error="账户会话已失效，请重新登录" onAuthenticated={async (session: AuthSession) => { setCurrentUser(session.user); await boot(); }} />;
  if (ADMIN_PATH) return currentUser.is_admin
    ? <AdminConsole user={currentUser} />
    : <div className="boot-screen"><span><CheckCircle /></span><strong>此账户没有管理权限</strong><small>请使用平台主管账户，或返回创作台继续工作。</small><a className="admin-access-back" href="/v3">返回创作台</a></div>;

  const selectedNodes = nodes.filter((node) => node.selected && node.data.kind !== "group");
  const activeQueue = jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  return <WorkspaceContext.Provider value={workspaceValue}>
    <div className="app-shell">
      <HeaderBar projects={projects.filter((project) => !project.deleted_at)} projectId={projectId} capabilities={capabilities} accountUsage={accountUsage} queueCount={activeQueue} runtimeStarting={runtimeStarting} onStartRuntime={startRuntime} onProjectChange={changeProject} onCreateProject={createProject} onManageProjects={() => setProjectManagerOpen(true)} onOpenAssets={() => setAssetOpen(true)} onUpload={() => fileInputRef.current?.click()} onBatchFinal={batchFinal} user={currentUser} onOpenAccount={() => setAccountCenterOpen(true)} canCreateProjects={canCreateProjects} canEditProject={Boolean(canEditCurrentProject)} />
      <div className={`workbench-layout ${assetOpen ? "asset-mode" : ""} ${agentCollapsed ? "agent-is-collapsed" : ""}`}>
        <ToolRail onAdd={quickAdd} assetOpen={assetOpen} onToggleAssets={() => setAssetOpen((value) => !value)} readOnly={!canEditCurrentProject} />
        <AssetDrawer
          open={assetOpen}
          projectName={projects.find((project) => project.id === projectId)?.name || "当前项目"}
          assets={assets}
          folders={assetFolders}
          onClose={() => setAssetOpen(false)}
          onAdd={(asset) => addAssetAt(asset, quickPosition(viewportRef.current))}
          onUpload={(folderId) => { uploadFolderRef.current = folderId || null; fileInputRef.current?.click(); }}
          onCreateFolder={(parentId) => void createAssetFolder(parentId)}
          onRenameFolder={(folder, name) => void renameAssetFolder(folder, name)}
          onDeleteFolder={(folder) => void deleteAssetFolder(folder)}
          onMoveAsset={(asset, folderId) => void moveAsset(asset, folderId)}
          onRenameAsset={(asset, name) => void renameAsset(asset, name)}
          onDownload={(asset) => void downloadAsset(asset)}
          readOnly={!canEditCurrentProject}
        />
        <ReactFlowProvider key={canvasKey}>
          <CanvasStage assets={assets} initialViewport={initialViewport} fitViewOnMount={fitViewOnMount} onCreateAt={addNodeAt} onAssetAt={addAssetAt} onUploadAt={uploadAt} onMoveEnd={(_, viewport) => { viewportRef.current = viewport; }} readOnly={!canEditCurrentProject} />
        </ReactFlowProvider>
        <CreativeAgentPanel key={projectId} capabilities={capabilities} selectedNodes={selectedNodes} assets={assets} contextAssetIds={referencedImageIds(nodes, edges, assets)} jobs={jobs} productions={productions} onMaterialize={job => materializeStoryboard(job)} onShowProduction={run => void showProduction(run)} onExecute={executeStoryboard} onControl={controlProduction} collapsed={agentCollapsed} onToggleCollapsed={() => setAgentCollapsed((value) => !value)} onSend={sendAgent} onDeselect={(id) => useCanvasStore.getState().onNodesChange([{ id, type: "select", selected: false }])} readOnly={!canEditCurrentProject} />
      </div>
      <input ref={fileInputRef} hidden type="file" multiple accept="image/*,video/*,audio/*,.txt,.md,.json" onChange={async (event) => {
        const files = [...(event.target.files || [])];
        if (files.length) await uploadAt(files, quickPosition(viewportRef.current), uploadFolderRef.current);
        uploadFolderRef.current = null;
        event.target.value = "";
      }} />
      {toast ? <div className={`toast ${toast.tone}`} role={toast.tone === "danger" ? "alert" : "status"} aria-live={toast.tone === "danger" ? "assertive" : "polite"}><CheckCircle weight="fill" />{toast.message}</div> : null}
      <ProjectManager
        open={projectManagerOpen}
        projects={projects}
        groups={projectGroups}
        currentProjectId={projectId}
        onClose={() => setProjectManagerOpen(false)}
        onSwitch={(id) => { void changeProject(id); setProjectManagerOpen(false); }}
        onCreate={() => void createProject()}
        onRename={(project, name) => void renameProject(project, name)}
        onMove={(id, groupId) => void moveProject(id, groupId)}
        onTrash={(project) => void trashProject(project)}
        onRestore={(project) => void restoreProject(project)}
        onCreateGroup={() => void createProjectGroup()}
        onRenameGroup={(group, name) => void renameProjectGroup(group, name)}
        onDeleteGroup={(group) => void deleteProjectGroup(group)}
        canCreateProjects={canCreateProjects}
      />
      <AccountCenter
        open={accountCenterOpen}
        user={currentUser}
        projects={projects}
        currentProjectId={projectId}
        onClose={() => setAccountCenterOpen(false)}
        notify={notify}
        onUserChanged={setCurrentUser}
        onProjectUpdated={(updated) => setProjects((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item))}
        onProjectsChanged={refreshProjects}
        onLogout={async () => { await workbenchApi.logout(); setAccountCenterOpen(false); setCurrentUser(null); setAccountUsage(null); setAuthState("login"); setAuthError(""); }}
      />
    </div>
  </WorkspaceContext.Provider>;
}

function quickPosition(viewport: Viewport) {
  return { x: (window.innerWidth * 0.42 - viewport.x) / viewport.zoom, y: (window.innerHeight * 0.35 - viewport.y) / viewport.zoom };
}
