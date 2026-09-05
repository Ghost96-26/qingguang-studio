import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkbenchNode,
  defaultTargetPort,
  deriveOptions,
  inputPorts,
  migrateCanvas,
  nextCompatiblePort,
  nodeConfigurationSignature,
  normalizeGraphEdges,
  outputKind,
  remapNodeMode,
  serializeCanvas,
} from "../src/model.ts";
import { effectiveSamplingSteps, h3ProfilePatch, imageSamplingDefaults, VIDEO_RESOLUTIONS } from "../src/sampling.ts";

const assets = [
  { id: "image-a", kind: "image", media_type: "image/png" },
  { id: "image-b", kind: "image", media_type: "image/png" },
  { id: "video-a", kind: "video", media_type: "video/mp4" },
  { id: "audio-a", kind: "audio", media_type: "audio/wav" },
] as any[];

function source(id: string, assetId: string) {
  return {
    ...createWorkbenchNode("asset", { x: 0, y: 0 }, { assetId, title: assetId }),
    id,
  };
}

function edge(id: string, sourceId: string, targetId: string, targetHandle: string) {
  return { id, source: sourceId, target: targetId, sourceHandle: "output", targetHandle, data: { output: "output" } } as any;
}

test("legacy video links are assigned to valid roles and duplicate references are removed", () => {
  const video = { ...createWorkbenchNode("video", { x: 300, y: 0 }, { params: { mode: "reference" } }), id: "target" };
  const nodes = [source("a", "image-a"), source("b", "image-b"), source("v", "video-a"), video];
  const normalized = normalizeGraphEdges(nodes, [
    edge("1", "a", "target", "first_frame"),
    edge("2", "a", "target", "reference_image_2"),
    edge("3", "b", "target", "reference_image_2"),
    edge("4", "v", "target", "first_frame"),
  ], assets as any);
  assert.deepEqual(normalized.map((item) => item.targetHandle), ["reference_image_1", "reference_image_2", "reference_video_1"]);
  assert.equal(normalized.filter((item) => item.source === "a").length, 1);
});

test("mode changes preserve compatible images and discard incompatible excess inputs", () => {
  const video = { ...createWorkbenchNode("video", { x: 300, y: 0 }, { params: { mode: "reference" } }), id: "target" };
  const nodes = [source("a", "image-a"), source("b", "image-b"), source("v", "video-a"), source("u", "audio-a"), video];
  const current = normalizeGraphEdges(nodes, [
    edge("1", "a", "target", "reference_image_1"),
    edge("2", "b", "target", "reference_image_2"),
    edge("3", "v", "target", "reference_video_1"),
    edge("4", "u", "target", "reference_audio_1"),
  ], assets as any);
  const migrated = remapNodeMode("target", "fl2v", nodes, current, assets as any);
  assert.deepEqual(migrated.edges.map((item) => item.targetHandle), ["first_frame", "last_frame"]);
  assert.equal(migrated.removed, 2);
});

test("configuration signatures change with prompt and material roles", () => {
  const video = { ...createWorkbenchNode("video", { x: 300, y: 0 }, { params: { mode: "i2v", prompt: "A" } }), id: "target" };
  const first = nodeConfigurationSignature(video, [edge("1", "a", "target", "first_frame")]);
  const changedPrompt = nodeConfigurationSignature({ ...video, data: { ...video.data, params: { ...video.data.params, prompt: "B" } } }, [edge("1", "a", "target", "first_frame")]);
  const changedInput = nodeConfigurationSignature(video, [edge("1", "b", "target", "first_frame")]);
  assert.notEqual(first, changedPrompt);
  assert.notEqual(first, changedInput);
});

test("video defaults respect the selected mode", () => {
  assert.equal(defaultTargetPort("video", "image", { mode: "i2v" }), "first_frame");
  assert.equal(defaultTargetPort("video", "audio", { mode: "audio_drive" }), "guide_audio");
  assert.equal(defaultTargetPort("video", "image", { mode: "t2v" }), "smart_input");
});

test("H3 reference contract exposes exactly 9 images, 3 videos and 3 audios", () => {
  const ports = inputPorts("video", { mode: "reference" });
  assert.equal(ports.filter((port) => port.accepts === "image").length, 9);
  assert.equal(ports.filter((port) => port.accepts === "video").length, 3);
  assert.equal(ports.filter((port) => port.accepts === "audio").length, 3);
});

test("reference inputs fill the next compatible role and reject overflow", () => {
  const target = { ...createWorkbenchNode("video", { x: 300, y: 0 }, { params: { mode: "reference" } }), id: "target" };
  const occupied = Array.from({ length: 9 }, (_, index) => edge(`e-${index}`, `s-${index}`, "target", `reference_image_${index + 1}`));
  assert.equal(nextCompatiblePort(target, "image", occupied)?.id, undefined);
  assert.equal(nextCompatiblePort(target, "video", occupied)?.id, "reference_video_1");
});

test("reference mode defaults to the native quality profile instead of a silent four-step downgrade", () => {
  const target = createWorkbenchNode("video", { x: 0, y: 0 }, { params: { mode: "reference" } });
  assert.equal(target.data.params.profile, "quality");
  assert.equal(target.data.params.width, 1344);
  assert.equal(target.data.params.height, 768);
  const base = createWorkbenchNode("video", { x: 0, y: 0 });
  const remapped = remapNodeMode(base.id, "reference", [base], [], assets as any);
  assert.equal(remapped.nodes[0].data.params.profile, "quality");
});

test("legacy technical mask assets stay hidden even when their old edge is missing", () => {
  const migrated = migrateCanvas({
    nodes: [{
      id: "legacy-mask",
      type: "workbench",
      position: { x: 0, y: 0 },
      data: { kind: "asset", title: "蒙版 · 图片编辑", assetId: "image-a" },
    }],
    edges: [],
  } as any, assets as any);
  assert.equal(migrated.nodes[0].hidden, true);
});

test("new H3 nodes use 30 native steps while saved explicit steps survive reload", () => {
  const fresh = createWorkbenchNode("video", { x: 0, y: 0 });
  assert.equal(fresh.data.params.profile, "quality");
  assert.equal(fresh.data.params.steps, 30);
  const old = migrateCanvas({ nodes: [{ id: "saved", kind: "video", params: { profile: "quality", steps: 25, width: 832, height: 480 } }] }, []);
  assert.equal(old.nodes[0].data.params.steps, 25);
  assert.equal(old.nodes[0].data.params.width, 832);
});

test("sampling mode switches preserve resolution and Turbo locks matching steps", () => {
  const params = { width: 1024, height: 576, ...h3ProfilePatch("preview8") };
  assert.equal(effectiveSamplingSteps("video", params), 8);
  const native = { ...params, ...h3ProfilePatch("quality") };
  assert.equal(native.width, 1024);
  assert.equal(native.height, 576);
  assert.equal(effectiveSamplingSteps("video", native), 30);
  const legacy = migrateCanvas({ nodes: [{ id: "saved", kind: "video", params: { mode: "t2v", profile: "preview8", steps: 30 } }] }, []);
  assert.equal(legacy.nodes[0].data.params.steps, 8);
});

test("image defaults and H3 resolution choices match provider contracts", () => {
  assert.equal(imageSamplingDefaults("image_t2i", "krea2-turbo-bf16").steps, 8);
  assert.equal(imageSamplingDefaults("image_edit", "krea2-identity-edit-v1.2").steps, 10);
  assert.equal(imageSamplingDefaults("image_t2i", "krea2-raw-bf16").steps, 40);
  assert.equal(imageSamplingDefaults("image_t2i", "ideogram4-fp8").steps, 48);
  for (const [value] of VIDEO_RESOLUTIONS) {
    const [width, height] = value.split("x").map(Number);
    assert.equal(width % 32, 0);
    assert.equal(height % 32, 0);
    assert.ok(width * height <= 1344 * 768);
  }
});

test("structured dialogue exposes four reusable voice slots while legacy assembly remains compatible", () => {
  const compose = inputPorts("dialogue", { dialogue_mode: "compose" });
  assert.deepEqual(compose.map((port) => port.id), ["voice_1", "voice_2", "voice_3", "voice_4"]);
  assert.ok(compose.every((port) => port.accepts === "audio"));
  const legacy = inputPorts("dialogue", { dialogue_mode: "assembly" });
  assert.equal(legacy.length, 6);
  assert.equal(legacy[0].id, "audio_1");
});

test("Foley is a first-level video-to-audio node and legacy mixed SFX nodes migrate safely", () => {
  assert.deepEqual(inputPorts("sfx", {}), [{ id: "source_video", label: "画面", accepts: "video" }]);
  assert.equal(defaultTargetPort("sfx", "video"), "source_video");
  assert.equal(outputKind(createWorkbenchNode("sfx", { x: 0, y: 0 }), []), "audio");
  assert.ok(deriveOptions("video").some((option) => option.kind === "sfx" && option.port === "source_video"));
  const migrated = migrateCanvas({ nodes: [{ id: "legacy-sfx", kind: "music", params: { audio_mode: "sfx", prompt: "脚步声" } }] }, []);
  assert.equal(migrated.nodes[0].data.kind, "sfx");
  assert.equal(migrated.nodes[0].data.params.prompt, "脚步声");
});

test("batch result ids survive serialization while legacy generated preview geometry is reset on load", () => {
  const node = createWorkbenchNode("image_t2i", { x: 10, y: 20 }, { jobIds: ["job-a", "job-b"], assetIds: ["asset-a", "asset-b"] });
  node.width = 512;
  node.height = 360;
  const state = serializeCanvas([node], [], { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(state.nodes?.[0].jobIds, ["job-a", "job-b"]);
  assert.deepEqual(state.nodes?.[0].assetIds, ["asset-a", "asset-b"]);
  assert.equal(state.nodes?.[0].width, 512);
  assert.equal(state.nodes?.[0].height, 360);
  const migrated = migrateCanvas(state, []);
  assert.equal(migrated.nodes[0].width, undefined);
  assert.equal(migrated.nodes[0].height, undefined);
});

test("manually resized source asset geometry remains stable across reloads", () => {
  const node = createWorkbenchNode("asset", { x: 10, y: 20 }, { assetId: "asset-a" });
  node.width = 360;
  node.height = 280;
  const migrated = migrateCanvas(serializeCanvas([node], [], { x: 0, y: 0, zoom: 1 }), assets as any);
  assert.equal(migrated.nodes[0].width, 360);
  assert.equal(migrated.nodes[0].height, 280);
});
