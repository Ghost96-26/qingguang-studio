import type { NodeKind, WorkbenchParams } from "./types";

export const H3_DEFAULT_STEPS = 30;
export const H3_NATIVE_STEPS = [20, 25, 30, 40, 50, 60];
export const VIDEO_RESOLUTIONS = [
  ["608x352", "预览 · 608×352"], ["832x480", "横屏 · 832×480"],
  ["1024x576", "横屏 · 1024×576"], ["1344x768", "横屏 · 1344×768"],
  ["352x608", "竖屏预览 · 352×608"], ["480x832", "竖屏 · 480×832"],
  ["576x1024", "竖屏 · 576×1024"], ["768x1344", "竖屏 · 768×1344"],
  ["512x512", "方形 · 512×512"], ["768x768", "方形 · 768×768"], ["992x992", "方形 · 992×992"],
];
export const IMAGE_RESOLUTIONS = [
  ["1024x1024", "1:1 · 1024×1024"], ["1536x1024", "3:2 · 1536×1024"],
  ["1344x768", "16:9 · 1344×768"], ["768x1344", "9:16 · 768×1344"],
  ["1536x1536", "1:1 · 1536×1536"], ["2048x2048", "1:1 · 2048×2048 · 高负载"],
  ["2048x1152", "16:9 · 2048×1152 · 高负载"], ["1152x2048", "9:16 · 1152×2048 · 高负载"],
];

export function imageSamplingDefaults(kind: NodeKind, modelId: string) {
  if (modelId === "ideogram4-fp8") return { steps: 48, options: [32, 40, 48, 60, 80] };
  if (modelId === "krea2-raw-bf16") return { steps: 40, options: [20, 25, 30, 40, 50, 60] };
  return { steps: kind === "image_t2i" ? 8 : 10, options: [4, 8, 10, 12, 16, 20] };
}

export function effectiveSamplingSteps(kind: NodeKind, params: WorkbenchParams): number {
  if (kind === "video") {
    if (params.profile === "preview4") return 4;
    if (params.profile === "preview8") return 8;
    return Number(params.steps ?? H3_DEFAULT_STEPS);
  }
  return Number(params.steps ?? imageSamplingDefaults(kind, String(params.model_id || "krea2-turbo-bf16")).steps);
}

/** Sampling mode and canvas resolution are independent; switching never resets dimensions. */
export function h3ProfilePatch(profile: string): WorkbenchParams {
  return { profile, steps: profile === "preview4" ? 4 : profile === "preview8" ? 8 : H3_DEFAULT_STEPS };
}
