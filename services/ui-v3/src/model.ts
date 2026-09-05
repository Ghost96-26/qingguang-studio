import type { Asset, LegacyCanvasState, NodeKind, WorkbenchEdge, WorkbenchNode, WorkbenchNodeData, WorkbenchParams } from "./types";
import { H3_DEFAULT_STEPS } from "./sampling.ts";
import { defaultDirector } from "./h3-director.ts";

export const nodeLabels: Record<NodeKind, string> = {
  asset: "素材",
  image_t2i: "图片生成",
  image_i2i: "图生图",
  image_edit: "图片编辑",
  media_prepare: "素材适配",
  video: "H3 视频生成",
  tts: "角色对白",
  dialogue: "对白编排",
  music: "音乐生成",
  sfx: "影视音效",
  note: "制作便笺",
  group: "镜头分组",
};

export const defaultParams = (kind: NodeKind): WorkbenchParams => {
  if (kind === "video") return { mode: "t2v", prompt: "", profile: "quality", steps: H3_DEFAULT_STEPS, width: 1344, height: 768, duration_seconds: 5, seed: 7, ref_image_size: "max" };
  if (kind === "image_t2i") return { model_id: "krea2-turbo-bf16", prompt_model: "qwen3.6-27b-q4", prompt: "", width: 1024, height: 1024, seed: 7, style: "auto", style_lora: "none", lora_strength: 1, batch_count: 1 };
  if (kind === "image_i2i") return { model_id: "krea2-turbo-bf16", prompt_model: "qwen3.6-27b-q4", prompt: "", width: 1024, height: 1024, seed: 7, strength: 0.45, style: "preserve", batch_count: 1 };
  if (kind === "image_edit") return { model_id: "krea2-identity-edit-v1.2", prompt_model: "qwen3.6-27b-q4", prompt: "", width: 1024, height: 1024, seed: 7, preservation: 4, edit_mode: "instruction", batch_count: 1 };
  if (kind === "media_prepare") return { fit_mode: "contain", target_width: 1344, target_height: 768, target_frame_rate: 24, target_sample_rate: 48000, target_channels: 2 };
  if (kind === "tts") return { text: "", language: "ZH", seed: 7, duration_factor: 1 };
  if (kind === "dialogue") return {
    dialogue_mode: "compose",
    dialogue_lines: JSON.stringify([{ id: "line-1", speaker: "角色 A", text: "", language: "ZH", voice_slot: 1, gap_seconds: 0.35 }]),
    gap_seconds: 0.35,
    seed: 7,
  };
  if (kind === "music") return { prompt: "", prompt_model: "qwen3.6-27b-q4", lyrics: "[Instrumental]", duration_seconds: 10, seed: 7, audio_mode: "music", timing_mode: "adaptive" };
  if (kind === "sfx") return { prompt: "", prompt_model: "qwen3.6-27b-q4", steps: 50, guidance_scale: 4.5, seed: 1, enable_offload: true };
  if (kind === "note") return { text: "双击标题可重命名，使用右侧 + 继续创作。" };
  return {};
};

function normalizeNodeParams(kind: NodeKind, params: WorkbenchParams): WorkbenchParams {
  if (kind !== "video") return params;
  if (params.mode === "reference" && params.profile === "preview8") return { ...params, profile: "quality", steps: H3_DEFAULT_STEPS, ...(params.model_id ? { model_id: "h3-int8-native" } : {}) };
  if (params.profile === "preview4" || params.profile === "preview8") return { ...params, steps: params.profile === "preview4" ? 4 : 8 };
  return { ...params, steps: params.steps ?? H3_DEFAULT_STEPS };
}

const generatedPreviewKinds = new Set<NodeKind>(["image_t2i", "image_i2i", "image_edit", "video", "tts", "dialogue", "music", "sfx"]);

export function createWorkbenchNode(kind: NodeKind, position: { x: number; y: number }, data?: Partial<WorkbenchNodeData>): WorkbenchNode {
  return {
    id: crypto.randomUUID(),
    type: kind === "group" ? "group" : "workbench",
    position,
    zIndex: kind === "group" ? -1 : 1,
    data: {
      kind,
      title: data?.title || nodeLabels[kind],
      ...data,
      params: normalizeNodeParams(kind, { ...defaultParams(kind), ...(kind === "video" ? { h3_ir_enabled: true, director_json: JSON.stringify(defaultDirector()) } : {}), ...(data?.params || {}) }),
    },
  };
}

function normalizeKind(value: unknown): NodeKind {
  const kind = String(value || "note") as NodeKind;
  return kind in nodeLabels ? kind : "note";
}

export function migrateCanvas(state: LegacyCanvasState, assets: Asset[]): { nodes: WorkbenchNode[]; edges: WorkbenchEdge[]; viewport: { x: number; y: number; zoom: number } } {
  const byJob = new Map(assets.filter((asset) => asset.origin_job_id).map((asset) => [asset.origin_job_id, asset]));
  const nodes = (state.nodes || []).map((raw): WorkbenchNode => {
    const legacyData = (raw.data || {}) as Partial<WorkbenchNodeData>;
    const legacyKind = normalizeKind(legacyData.kind || raw.kind || raw.type);
    const legacyParams = { ...((raw.params || {}) as WorkbenchParams), ...(legacyData.params || {}) };
    const kind: NodeKind = legacyKind === "music" && legacyParams.audio_mode === "sfx" ? "sfx" : legacyKind;
    const jobId = String(legacyData.jobId || raw.jobId || "") || undefined;
    const attachedAsset = String(legacyData.assetId || raw.assetId || "") || byJob.get(jobId)?.id;
    const attachedAssetIds = (legacyData.assetIds || raw.assetIds || (attachedAsset ? [attachedAsset] : [])) as string[];
    const resetLegacyPreviewGeometry = generatedPreviewKinds.has(kind) && Boolean(attachedAsset || attachedAssetIds.length);
    const position = (raw.position as { x?: number; y?: number } | undefined) || {};
    return {
      id: String(raw.id || crypto.randomUUID()),
      type: kind === "group" ? "group" : "workbench",
      position: {
        x: Number(position.x ?? raw.x ?? 0),
        y: Number(position.y ?? raw.y ?? 0),
      },
      width: !resetLegacyPreviewGeometry && typeof raw.width === "number" ? raw.width : undefined,
      height: !resetLegacyPreviewGeometry && typeof raw.height === "number" ? raw.height : undefined,
      hidden: Boolean(raw.hidden),
      zIndex: kind === "group" ? -1 : Number(raw.zIndex || 1),
      data: {
        kind,
        title: String(legacyData.title || raw.title || nodeLabels[kind]),
        params: normalizeNodeParams(kind, {
          ...defaultParams(kind),
          ...((raw.params || {}) as WorkbenchParams),
          ...(legacyData.params || {}),
          ...(kind === "dialogue" && !(raw.params as WorkbenchParams | undefined)?.dialogue_mode && !legacyData.params?.dialogue_mode ? { dialogue_mode: "assembly" } : {}),
        }),
        assetId: attachedAsset,
        assetIds: attachedAssetIds,
        jobId,
        jobIds: (legacyData.jobIds || raw.jobIds || (jobId ? [jobId] : [])) as string[],
        groupIds: (legacyData.groupIds || raw.groupIds || []) as string[],
        collapsed: Boolean(legacyData.collapsed ?? raw.collapsed ?? false),
        outputMediaKind: String(legacyData.outputMediaKind || raw.outputMediaKind || "") || undefined,
        runSignature: String(legacyData.runSignature || raw.runSignature || "") || (jobId ? "legacy" : undefined),
        productionRunId: legacyData.productionRunId || undefined,
      },
    };
  });

  const rawEdges = (state.edges || []).map((raw): WorkbenchEdge => {
    const storedData = (raw.data || {}) as Record<string, unknown>;
    const output = String(raw.output || storedData.output || "any");
    const color = connectionColor(output);
    return {
      id: String(raw.id || crypto.randomUUID()),
      source: String(raw.source || raw.from || ""),
      target: String(raw.target || raw.to || ""),
      sourceHandle: "output",
      targetHandle: String(raw.targetHandle || raw.port || "input"),
      type: "smoothstep",
      animated: false,
      style: { stroke: color, strokeWidth: 2 },
      data: { port: raw.port || raw.targetHandle || "input", output, color },
    };
  }).filter((edge) => edge.source && edge.target);
  const edges = normalizeGraphEdges(nodes, rawEdges, assets);
  const technicalMaskSources = new Set(edges.filter((edge) => edge.targetHandle === "mask_image").map((edge) => edge.source));
  nodes.forEach((node) => {
    const isLegacyMaskNode = node.data.kind === "asset" && node.data.title.trim().startsWith("蒙版 ·");
    if (node.data.kind === "asset" && (technicalMaskSources.has(node.id) || isLegacyMaskNode)) node.hidden = true;
  });

  return {
    nodes,
    edges,
    viewport: {
      x: Number(state.viewport?.x ?? 40),
      y: Number(state.viewport?.y ?? 30),
      zoom: Number(state.viewport?.zoom ?? 0.9),
    },
  };
}

export function serializeCanvas(nodes: WorkbenchNode[], edges: WorkbenchEdge[], viewport: { x: number; y: number; zoom: number }): LegacyCanvasState {
  return {
    version: 4,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      kind: node.data.kind,
      x: node.position.x,
      y: node.position.y,
      position: node.position,
      zIndex: node.zIndex,
      width: node.width,
      height: node.height,
      hidden: node.hidden,
      title: node.data.title,
      params: node.data.params,
      assetId: node.data.assetId,
      assetIds: node.data.assetIds,
      jobId: node.data.jobId,
      jobIds: node.data.jobIds,
      collapsed: node.data.collapsed,
      groupIds: node.data.groupIds,
      outputMediaKind: node.data.outputMediaKind,
      runSignature: node.data.runSignature,
      data: { ...node.data, renameRequestedAt: undefined },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      from: edge.source,
      to: edge.target,
      port: edge.targetHandle || edge.data?.port || "input",
      output: edge.data?.output || "any",
    })),
    groups: nodes.filter((node) => node.data.kind === "group").map((node) => ({ id: node.id, title: node.data.title, nodeIds: node.data.groupIds || [] })),
    viewport,
  };
}

export function mediaKind(asset?: Asset): "image" | "video" | "audio" | "text" | "file" {
  const type = asset?.media_type || "";
  if (type.startsWith("image/") || asset?.kind === "image") return "image";
  if (type.startsWith("video/") || asset?.kind === "video") return "video";
  if (type.startsWith("audio/") || asset?.kind === "audio") return "audio";
  if (type.startsWith("text/") || asset?.kind === "text") return "text";
  return "file";
}

export function outputKind(node: WorkbenchNode, assets: Asset[]): string {
  if (node.data.kind === "asset") return mediaKind(assets.find((asset) => asset.id === node.data.assetId));
  if (node.data.kind === "media_prepare") {
    const result = assets.find((asset) => asset.id === node.data.assetId);
    return result ? mediaKind(result) : node.data.outputMediaKind || "any";
  }
  if (["image_t2i", "image_i2i", "image_edit"].includes(node.data.kind)) return "image";
  if (node.data.kind === "video") return "video";
  if (["tts", "dialogue", "music", "sfx"].includes(node.data.kind)) return "audio";
  return "text";
}

export function defaultTargetPort(kind: NodeKind, sourceOutput = "any", params?: WorkbenchParams): string {
  if (kind === "media_prepare") return "media_input";
  if (kind === "image_i2i" || kind === "image_edit") return "source_image";
  if (kind === "video") {
    const mode = String(params?.mode || "t2v");
    const compatible = inputPorts(kind, { ...defaultParams(kind), ...(params || {}), mode }).find((port) => port.accepts === sourceOutput);
    return compatible?.id || "smart_input";
  }
  if (kind === "tts") return "reference_audio";
  if (kind === "dialogue") return params?.dialogue_mode === "assembly" ? "audio_1" : "voice_1";
  if (kind === "sfx") return "source_video";
  return "input";
}

export type PortKind = "image" | "video" | "audio" | "text" | "any";

export interface InputPort {
  id: string;
  label: string;
  accepts: PortKind;
}

export interface VideoModeCapability {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  limits: { image: number; video: number; audio: number };
  required: string[];
}

export const H3_VIDEO_MODES: Record<string, VideoModeCapability> = {
  t2v: { id: "t2v", label: "文生视频", shortLabel: "文生", description: "仅使用提示词生成", limits: { image: 0, video: 0, audio: 0 }, required: [] },
  i2v: { id: "i2v", label: "首帧生成", shortLabel: "首帧", description: "1 张图片作为首帧", limits: { image: 1, video: 0, audio: 0 }, required: ["first_frame"] },
  fl2v: { id: "fl2v", label: "首尾帧生成", shortLabel: "首尾帧", description: "首帧和尾帧各 1 张", limits: { image: 2, video: 0, audio: 0 }, required: ["first_frame", "last_frame"] },
  reference: { id: "reference", label: "全能参考", shortLabel: "全能参考", description: "最多 9 图 · 3 视频 · 3 音频", limits: { image: 9, video: 3, audio: 3 }, required: ["any_reference"] },
  audio_drive: { id: "audio_drive", label: "对白驱动", shortLabel: "对白驱动", description: "1 段对白，可选 1 张首帧", limits: { image: 1, video: 0, audio: 1 }, required: ["guide_audio"] },
};

function numberedPorts(prefix: string, label: string, accepts: PortKind, count: number): InputPort[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}_${index + 1}`, label: `${label} ${index + 1}`, accepts }));
}

export function videoModeCapability(paramsOrMode: WorkbenchParams | string): VideoModeCapability {
  const mode = typeof paramsOrMode === "string" ? paramsOrMode : String(paramsOrMode.mode || "t2v");
  return H3_VIDEO_MODES[mode] || H3_VIDEO_MODES.t2v;
}

export function inputCapabilitySummary(kind: NodeKind, params: WorkbenchParams): string {
  if (kind === "video") {
    const capability = videoModeCapability(params);
    return `${capability.label}：${capability.description}`;
  }
  const ports = inputPorts(kind, params);
  if (!ports.length) return "当前任务不接受外部素材";
  const counts = ports.reduce<Record<string, number>>((result, port) => ({ ...result, [port.accepts]: (result[port.accepts] || 0) + 1 }), {});
  return `支持${Object.entries(counts).map(([type, count]) => `${count} 个${mediaLabel(type)}`).join("、")}`;
}

export function inputPorts(kind: NodeKind, params: WorkbenchParams): InputPort[] {
  if (kind === "media_prepare") return [{ id: "media_input", label: "原始素材", accepts: "any" }];
  if (kind === "image_i2i") return [{ id: "source_image", label: "源图片", accepts: "image" }, { id: "style_image", label: "风格参考", accepts: "image" }];
  if (kind === "image_edit") return [{ id: "source_image", label: "待编辑图片", accepts: "image" }, { id: "reference_image", label: "参考图片", accepts: "image" }, { id: "mask_image", label: "蒙版", accepts: "image" }];
  if (kind === "video") {
    const mode = params.mode || "t2v";
    if (mode === "i2v") return [{ id: "first_frame", label: "首帧", accepts: "image" }];
    if (mode === "fl2v") return [{ id: "first_frame", label: "首帧", accepts: "image" }, { id: "last_frame", label: "尾帧", accepts: "image" }];
    if (mode === "reference") return [
      ...numberedPorts("reference_image", "参考图", "image", 9),
      ...numberedPorts("reference_video", "参考视频", "video", 3),
      ...numberedPorts("reference_audio", "参考音频", "audio", 3),
    ];
    if (mode === "audio_drive") return [{ id: "guide_audio", label: "对白", accepts: "audio" }, { id: "first_frame", label: "首帧", accepts: "image" }];
  }
  if (kind === "tts") return [{ id: "reference_audio", label: "参考音色", accepts: "audio" }];
  if (kind === "dialogue") return params.dialogue_mode === "assembly"
    ? numberedPorts("audio", "对白", "audio", 6)
    : numberedPorts("voice", "角色音色", "audio", 4);
  if (kind === "sfx") return [{ id: "source_video", label: "画面", accepts: "video" }];
  return [];
}

export function portKind(kind: NodeKind, params: WorkbenchParams, portId: string | null | undefined): PortKind {
  return inputPorts(kind, params).find((port) => port.id === portId)?.accepts || "any";
}

export function compatiblePort(kind: NodeKind, params: WorkbenchParams, sourceOutput: string): InputPort | undefined {
  return inputPorts(kind, params).find((port) => port.accepts === "any" || port.accepts === sourceOutput);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function nodeConfigurationSignature(node: WorkbenchNode, edges: WorkbenchEdge[]): string {
  const inputs = edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => ({ source: edge.source, role: edge.targetHandle || "input" }))
    .sort((left, right) => `${left.role}:${left.source}`.localeCompare(`${right.role}:${right.source}`));
  const params = { ...node.data.params };
  if (node.data.kind === "video" && params.h3_ir_enabled !== true) {
    delete params.h3_ir_enabled;
    delete params.director_json;
  }
  return JSON.stringify(stableValue({ params, inputs }));
}

/**
 * Repairs legacy/mode-stale links without touching source assets. Existing
 * compatible roles are kept; remaining materials are reassigned in visual
 * order to the next compatible role and excess links are dropped.
 */
export function normalizeGraphEdges(nodes: WorkbenchNode[], edges: WorkbenchEdge[], assets: Asset[]): WorkbenchEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const occupied = new Map<string, Set<string>>();
  const seenReferenceSource = new Map<string, Set<string>>();
  const normalized: WorkbenchEdge[] = [];

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target || source.id === target.id || ["asset", "group"].includes(target.data.kind)) continue;
    const ports = inputPorts(target.data.kind, target.data.params);
    if (!ports.length) continue;
    const inferred = outputKind(source, assets);
    const stored = String(edge.data?.output || "");
    const output = ["image", "video", "audio", "text"].includes(stored) ? stored : inferred;
    const used = occupied.get(target.id) || new Set<string>();
    const isReferenceMode = target.data.kind === "video" && target.data.params.mode === "reference";
    const duplicateSources = seenReferenceSource.get(target.id) || new Set<string>();
    if (isReferenceMode && duplicateSources.has(source.id)) continue;

    const requested = ports.find((port) => port.id === edge.targetHandle && (port.accepts === "any" || port.accepts === output) && !used.has(port.id));
    const assigned = requested || ports.find((port) => (port.accepts === "any" || port.accepts === output) && !used.has(port.id));
    if (!assigned) continue;
    used.add(assigned.id);
    occupied.set(target.id, used);
    if (isReferenceMode) {
      duplicateSources.add(source.id);
      seenReferenceSource.set(target.id, duplicateSources);
    }
    const color = connectionColor(output);
    normalized.push({
      ...edge,
      sourceHandle: "output",
      targetHandle: assigned.id,
      type: "default",
      style: { ...(edge.style || {}), stroke: color, strokeWidth: 2 },
      data: { ...(edge.data || {}), port: assigned.id, output, color },
    });
  }
  return normalized;
}

export function remapNodeMode(
  nodeId: string,
  mode: string,
  nodes: WorkbenchNode[],
  edges: WorkbenchEdge[],
  assets: Asset[],
): { nodes: WorkbenchNode[]; edges: WorkbenchEdge[]; removed: number; moved: number } {
  const before = new Map(edges.filter((edge) => edge.target === nodeId).map((edge) => [edge.id, edge.targetHandle]));
  const nextNodes = nodes.map((node) => node.id === nodeId
    ? { ...node, data: { ...node.data, params: normalizeNodeParams("video", { ...node.data.params, mode }) } }
    : node);
  const nextEdges = normalizeGraphEdges(nextNodes, edges, assets);
  const after = new Map(nextEdges.filter((edge) => edge.target === nodeId).map((edge) => [edge.id, edge.targetHandle]));
  let removed = 0;
  let moved = 0;
  before.forEach((handle, id) => {
    if (!after.has(id)) removed += 1;
    else if (after.get(id) !== handle) moved += 1;
  });
  return { nodes: nextNodes, edges: nextEdges, removed, moved };
}

export function nextCompatiblePort(
  node: WorkbenchNode,
  output: string,
  edges: WorkbenchEdge[],
): InputPort | undefined {
  const used = new Set(edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetHandle));
  return inputPorts(node.data.kind, node.data.params)
    .find((port) => (port.accepts === "any" || port.accepts === output) && !used.has(port.id));
}

export function connectionColor(kind: string): string {
  if (kind === "image") return "#69c8ff";
  if (kind === "video") return "#be8cff";
  if (kind === "audio") return "#ffbd68";
  if (kind === "text") return "#77e4bd";
  return "#a9b1c4";
}

export function mediaLabel(kind: string): string {
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  if (kind === "audio") return "音频";
  if (kind === "text") return "文本";
  return "素材";
}

export function targetPortLabel(kind: NodeKind, params: WorkbenchParams | undefined, portId: string): string {
  return inputPorts(kind, { ...defaultParams(kind), ...(params || {}) }).find((port) => port.id === portId)?.label || "输入";
}

export function deriveOptions(output: string): Array<{ kind: NodeKind; label: string; port?: string; params?: WorkbenchParams }> {
  if (output === "image") return [
    { kind: "image_i2i", label: "图生图", port: "source_image" },
    { kind: "image_edit", label: "图片编辑", port: "source_image" },
    { kind: "video", label: "首帧生成视频", port: "first_frame", params: { mode: "i2v" } },
    { kind: "media_prepare", label: "检查并适配素材", port: "media_input" },
  ];
  if (output === "video") return [
    { kind: "sfx", label: "生成匹配音效", port: "source_video" },
    { kind: "video", label: "参考视频生成", port: "reference_video_1", params: { mode: "reference" } },
    { kind: "media_prepare", label: "检查并适配视频", port: "media_input" },
    { kind: "note", label: "添加镜头说明" },
  ];
  if (output === "audio") return [
    { kind: "video", label: "对白驱动视频", port: "guide_audio", params: { mode: "audio_drive" } },
    { kind: "dialogue", label: "作为角色音色加入对白", port: "voice_1", params: { dialogue_mode: "compose" } },
    { kind: "media_prepare", label: "检查并适配音频", port: "media_input" },
  ];
  return [{ kind: "image_t2i", label: "图片生成" }, { kind: "video", label: "视频生成" }, { kind: "music", label: "生成配乐" }];
}
