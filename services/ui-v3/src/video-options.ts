import catalog from "../../shared/video-presets.json" with { type: "json" };
import type { WorkbenchParams } from "./types";

export const VIDEO_CATALOG = catalog;
export const VIDEO_QUALITY = [[20, "低 · 20步"], [30, "中 · 30步"], [40, "高 · 40步"]] as const;
export const VIDEO_SIZES: Record<string, number[][]> = {
  "16:9": [[608,352],[832,480],[1024,576],[1344,768]],
  "9:16": [[352,608],[480,832],[576,1024],[768,1344]],
  "1:1": [[448,448],[608,608],[768,768],[992,992]],
  "4:3": [[512,384],[736,544],[896,672],[1152,864]],
  "3:4": [[384,512],[544,736],[672,896],[864,1152]],
  "2.39:1": [[704,288],[992,416],[1152,480],[1536,640]],
};
export const VIDEO_SIZE_LABELS = ["预览", "标准", "精细", "原生"];

export function videoGeometry(params: WorkbenchParams) {
  const width = Number(params.width || 1344), height = Number(params.height || 768);
  const exact = Object.entries(VIDEO_SIZES).find(([, sizes]) => sizes.some(([w,h]) => w === width && h === height));
  const ratios = Object.keys(VIDEO_SIZES);
  const ratio = exact?.[0] || ratios.reduce((best, candidate) => {
    const value = (key: string) => { const [w,h] = key.split(":").map(Number); return Math.abs(Math.log((width / height) / (w / h))); };
    return value(candidate) < value(best) ? candidate : best;
  }, "16:9");
  const tier = VIDEO_SIZES[ratio].findIndex(([w,h]) => w === width && h === height);
  return { width, height, ratio, tier };
}

export function videoSizePatch(params: WorkbenchParams, ratio: string, tier?: number): WorkbenchParams {
  if (!VIDEO_SIZES[ratio]) throw new Error("Unsupported aspect ratio");
  const current = videoGeometry(params);
  const sizeTier = tier ?? (current.tier >= 0 ? current.tier : VIDEO_SIZES[current.ratio].reduce((best, size, index, sizes) =>
    Math.abs(size[0] * size[1] - current.width * current.height) < Math.abs(sizes[best][0] * sizes[best][1] - current.width * current.height) ? index : best, 0));
  const [width, height] = VIDEO_SIZES[ratio][sizeTier];
  return { width, height };
}

export function videoModelId(params: WorkbenchParams): string {
  return catalog.models.find(model => model.profile === (params.profile || "quality"))?.id || "h3-int8-native";
}

export function videoModelPatch(id: string): WorkbenchParams {
  const model = catalog.models.find(item => item.id === id);
  if (!model) throw new Error("Unsupported H3 model");
  return { model_id: model.id, profile: model.profile, steps: model.profile === "preview4" ? 4 : model.profile === "preview8" ? 8 : 30, scheduler: "simple" };
}

export function videoGuidance(params: WorkbenchParams): string[] {
  return catalog.groups.map(group => group.options.find(option => option.id === (params[group.key] || "none"))?.text || "").filter(Boolean);
}

export function effectiveVideoPrompt(params: WorkbenchParams): string {
  const prompt = String(params.prompt || "").trim();
  const guidance = videoGuidance(params);
  return guidance.length ? `${prompt}\n\n${catalog.guidance_header}\n${guidance.join("\n")}` : prompt;
}
