import type { Asset, WorkbenchEdge, WorkbenchNode, WorkbenchParams } from "./types";
import { readPromptBindings, resolvePromptBindings } from "./prompt-assist.ts";

export interface DirectorReference {
  key: string; name: string; role: string; description: string; preserve: string; change: string;
  retention: string; speaker_key?: string; anchor?: number | null;
}
export interface DirectorLine { speaker_key: string; language: string; text: string }
export interface DirectorShot { id: string; start: number; action: string; performance: string; camera: string; dialogue: DirectorLine[] }
export interface DirectorDocument {
  version: 1; references: DirectorReference[]; shots: DirectorShot[]; soundscape: string; music: string;
  enhancement?: Record<string, unknown>;
}
export interface DirectorInput { key: string; asset: Asset; port: string; kind: string; label: string }
export interface H3IRPreview {
  effective_prompt: string;
  h3_ir?: { version: string; fingerprint: string; frames: number; seconds: number; enhanced: boolean; source_model?: string; warnings: string[]; anchors: { frame: number; key: string }[] };
}

export function defaultDirector(): DirectorDocument {
  return { version: 1, references: [], shots: [{ id: "shot-1", start: 0, action: "", performance: "", camera: "", dialogue: [] }], soundscape: "", music: "" };
}

export function readDirector(params: WorkbenchParams): DirectorDocument {
  if (!params.director_json) return defaultDirector();
  const doc = JSON.parse(String(params.director_json));
  if (!doc || doc.version !== 1 || (doc.shots && !Array.isArray(doc.shots)) || (doc.references && !Array.isArray(doc.references))) throw new Error("导演台配置无效，请恢复空白导演配置；原提示词不会被修改。");
  if (doc.shots && (!doc.shots.length || doc.shots.some((shot: DirectorShot) => {
    return !shot || typeof shot.id !== "string" || typeof shot.start !== "number" || !Array.isArray(shot.dialogue)
      || shot.dialogue.some(line => !line || typeof line.text !== "string" || typeof line.speaker_key !== "string")
      || [shot.action, shot.performance, shot.camera].some(value => typeof value !== "string");
  }))) throw new Error("镜头配置无效，请恢复配置。");
  if (doc.references?.some((ref: DirectorReference) => !ref || [ref.key, ref.name, ref.role, ref.description, ref.preserve, ref.change, ref.retention].some(value => typeof value !== "string"))) throw new Error("参考素材配置无效，请恢复配置。");
  return { ...defaultDirector(), ...doc };
}

/** One input ordering for the preview, prompt optimizer and actual render. */
export function directorInputs(node: WorkbenchNode, nodes: WorkbenchNode[], edges: WorkbenchEdge[], assets: Asset[]): DirectorInput[] {
  const mode = String(node.data.params.mode || "t2v");
  const ports = mode === "reference" ? ["reference_image_", "reference_video_", "reference_audio_"] : mode === "fl2v" ? ["first_frame", "last_frame"] : mode === "audio_drive" ? ["first_frame", "guide_audio"] : mode === "i2v" ? ["first_frame"] : [];
  return ports.flatMap(prefix => edges.filter(edge => edge.target === node.id && (prefix.endsWith("_") ? String(edge.targetHandle).startsWith(prefix) : edge.targetHandle === prefix))
    .sort((a,b) => String(a.targetHandle).localeCompare(String(b.targetHandle), undefined, { numeric: true }))
    .flatMap(edge => {
      const source = nodes.find(item => item.id === edge.source);
      const asset = assets.find(item => item.id === source?.data.assetId);
      return asset ? [{ key: asset.source_path, asset, port: String(edge.targetHandle), kind: prefix.includes("video") ? "video" : prefix.includes("audio") ? "audio" : "image", label: "" }] : [];
    }).map((input, i) => ({ ...input, label: mode === "reference" ? `<${input.kind === "image" ? "Picture" : input.kind === "video" ? "Video" : "Audio"} ${i + 1}>` : input.port === "first_frame" ? "首帧" : input.port === "last_frame" ? "尾帧" : "引导音频" })));
}

export function videoRenderParams(node: WorkbenchNode, nodes: WorkbenchNode[], edges: WorkbenchEdge[], assets: Asset[]): WorkbenchParams {
  const inputs = directorInputs(node, nodes, edges, assets);
  return { ...node.data.params,
    prompt: resolvePromptBindings(String(node.data.params.prompt || ""), readPromptBindings(node.data.params.prompt_bindings_json), Object.fromEntries(inputs.map(item => [item.asset.id, item.label]))),
    first_frame: inputs.find(item => item.port === "first_frame")?.key || null,
    last_frame: inputs.find(item => item.port === "last_frame")?.key || null,
    guide_audio: inputs.find(item => item.port === "guide_audio")?.key || null,
    reference_images: inputs.filter(item => item.port.startsWith("reference_image_")).map(item => item.key),
    reference_videos: inputs.filter(item => item.port.startsWith("reference_video_")).map(item => item.key),
    reference_audios: inputs.filter(item => item.port.startsWith("reference_audio_")).map(item => item.key),
  };
}

export function defaultReference(input: DirectorInput): DirectorReference {
  return { key: input.key, name: input.asset.name, role: input.kind === "audio" ? "sound" : input.kind === "video" ? "motion" : "character", description: "", preserve: "", change: "", retention: "fully_preserved" };
}

export function directorSnapshot(params: WorkbenchParams): string {
  return JSON.stringify(params);
}
