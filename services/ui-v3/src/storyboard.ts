import type { Asset, Job, WorkbenchEdge, WorkbenchNode } from "./types";
import { createWorkbenchNode, connectionColor } from "./model.ts";

export interface StoryboardPlan {
  version: 1; title: string; duration_seconds: number; music_prompt: string; warnings: string[];
  settings: { width: number; height: number; fps: number; steps: number; profile: string; model_id: string };
  shots: { id: string; title: string; duration_seconds: number; prompt: string; sound: string; reference_asset_ids: string[] }[];
}
export interface ProductionRun {
  id: string; plan_job_id: string; project_id: string; status: string; error?: string;
  payload: { plan: StoryboardPlan; include_score: boolean; attempts: Record<string, number> };
  jobs: (Job | null)[];
}
export interface AgentRequest {
  prompt: string; modelId: string; skill: "chat" | "storyboard"; duration: number; steps: number;
  assetIds: string[]; descriptions: Record<string, string>;
}

export function storyboardGraph(planId: string, plan: StoryboardPlan, assets: Asset[], nodes: WorkbenchNode[], edges: WorkbenchEdge[], run?: ProductionRun) {
  const nextNodes = [...nodes], nextEdges = [...edges];
  // Production is a frozen copy, never attach a different prompt's output to an edited draft.
  const prefix = run ? `production-${run.id}` : `plan-${planId}`;
  const anchor = nodes.find(node => node.id === `${prefix}-${plan.shots[0]?.id}`)?.position;
  const startX = anchor?.x ?? (nodes.length ? Math.max(...nodes.map(node => node.position.x + (node.width || 380))) + 120 : 80);
  const add = (id: string, node: WorkbenchNode) => {
    const found = nextNodes.find(item => item.id === id);
    if (found) {
      if (run && found.data.productionRunId !== run.id) {
        const tagged = {...found, data: {...found.data, productionRunId: run.id}};
        nextNodes[nextNodes.indexOf(found)] = tagged;
        return tagged;
      }
      return found;
    }
    const created = { ...node, id, selected: false, data: {...node.data, productionRunId: run?.id} }; nextNodes.push(created); return created;
  };
  const linkJob = (id: string, job: Job | null | undefined) => {
    const index = nextNodes.findIndex(item => item.id === id);
    if (index >= 0 && job && nextNodes[index].data.jobId !== job.id) {
      nextNodes[index] = { ...nextNodes[index], data: { ...nextNodes[index].data, jobId: job.id, jobIds: [job.id] } };
    }
  };
  plan.shots.forEach((shot, index) => {
    const id = `${prefix}-${shot.id}`;
    add(id, createWorkbenchNode("video", { x: startX + (index % 3) * 480, y: 100 + Math.floor(index / 3) * 440 }, {
      title: `${index + 1}. ${shot.title}`,
      params: { ...plan.settings, prompt: shot.prompt, duration_seconds: shot.duration_seconds, seed: 20260904 + index,
        mode: shot.reference_asset_ids.length ? "reference" : "t2v", h3_ir_enabled: true,
        director_json: JSON.stringify({version: 1, references: [], shots: [{id: "shot-1", start: 0, action: "", performance: "", camera: "", dialogue: []}], soundscape: shot.sound, music: ""}) },
    }));
    shot.reference_asset_ids.forEach((assetId, refIndex) => {
      const asset = assets.find(item => item.id === assetId);
      if (!asset) throw new Error("分镜引用的素材已不可用，请重新检查当前项目。");
      const source = nextNodes.find(item => item.id !== id && item.data.assetId === assetId)
        || add(`${prefix}-ref-${assetId}`, createWorkbenchNode("asset", {x: startX - 320, y: 100 + refIndex * 240}, { title: asset.name, assetId }));
      const edgeId = `${id}-ref-${refIndex}`;
      // Existing nodes belong to the user; don't restore a deliberately removed edge.
      if (!nodes.some(item => item.id === id) && !nextEdges.some(edge => edge.id === edgeId)) nextEdges.push({id: edgeId, source: source.id, target: id, sourceHandle: "output", targetHandle: `reference_image_${refIndex + 1}`, type: "default", style: {stroke: connectionColor("image"), strokeWidth: 2}, data: {port: `reference_image_${refIndex + 1}`, output: "image"}});
    });
    linkJob(id, run?.jobs[index]);
  });
  if (run?.payload.include_score) {
    const id = `${prefix}-score`;
    add(id, createWorkbenchNode("music", {x: startX, y: 100 + Math.ceil(plan.shots.length / 3) * 440}, {title: "整片配乐", params: {prompt: plan.music_prompt, duration_seconds: plan.duration_seconds, lyrics: "[Instrumental]", audio_mode: "score"}}));
    linkJob(id, run.jobs[plan.shots.length]);
  }
  if (run) {
    const id = `${prefix}-assembly`;
    add(id, createWorkbenchNode("asset", {x: startX + 490, y: 100 + Math.ceil(plan.shots.length / 3) * 440}, {title: `${plan.title} · 审片版`, outputMediaKind: "video"}));
    linkJob(id, run.jobs.at(-1));
  }
  const members = plan.shots.map(shot => `${prefix}-${shot.id}`);
  const group = createWorkbenchNode("group", {x: startX - 32, y: 42}, {title: plan.title, groupIds: members});
  group.style = {width: 3 * 480, height: Math.ceil(plan.shots.length / 3) * 440 + 64};
  add(`${prefix}-group`, group);
  return { nodes: nextNodes, edges: nextEdges };
}

export function productionJobBindings(run: ProductionRun) {
  const prefix = `production-${run.id}`;
  const ids = run.payload.plan.shots.map(shot => `${prefix}-${shot.id}`);
  if (run.payload.include_score) ids.push(`${prefix}-score`);
  ids.push(`${prefix}-assembly`);
  return ids.map((id, index) => ({ id, job: run.jobs[index] })).filter(item => item.job);
}

export function referencedImageIds(nodes: WorkbenchNode[], edges: WorkbenchEdge[], assets: Asset[]) {
  const visited = new Set<string>(), ids = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    if (assets.some(asset => asset.id === node.data.assetId && asset.kind === "image")) ids.add(node.data.assetId!);
    edges.filter(edge => edge.target === id).forEach(edge => visit(edge.source));
  };
  nodes.filter(node => node.selected && node.data.kind !== "group").forEach(node => visit(node.id));
  return [...ids];
}
