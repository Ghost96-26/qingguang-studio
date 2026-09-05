import assert from "node:assert/strict";
import test from "node:test";
import { mentionToken, promptTrigger, readPromptBindings, replacePromptTrigger, resolvePromptBindings } from "../src/prompt-assist.ts";
import { createWorkbenchNode, serializeCanvas, migrateCanvas } from "../src/model.ts";
import { videoRenderParams } from "../src/h3-director.ts";
import { storyboardGraph, productionJobBindings, referencedImageIds, type StoryboardPlan, type ProductionRun } from "../src/storyboard.ts";
import type { Asset, Job } from "../src/types.ts";

test("caret triggers preserve suffix and support Chinese/fullwidth, not email or URLs", () => {
  for (const value of ["@", "镜头＠", "夜景 /", "夜景／"]) assert.ok(promptTrigger(value, value.length));
  for (const value of ["name@example.com", "https://example.com/", "没有触发词"]) assert.equal(promptTrigger(value, value.length), null);
  const value = "保留前缀 @角色 然后逃跑";
  const caret = value.indexOf(" 然后");
  const trigger = promptTrigger(value, caret)!;
  assert.equal(trigger.query, "角色");
  const result = replacePromptTrigger(value, trigger, "@「演员」");
  assert.equal(result.text, "保留前缀 @「演员」  然后逃跑");
  assert.equal(result.text.slice(result.caret), " 然后逃跑");
});

test("stable reference identity survives duplicate filenames, rename, port reorder and persistence", () => {
  const first = mentionToken("同名.png", "a", {}), bindings = {[first]: "a"};
  const second = mentionToken("同名.png", "b", bindings);
  assert.notEqual(first, second);
  const both = {...bindings, [second]: "b"};
  assert.equal(mentionToken("重命名.png", "a", both), first);
  const original = `${first}看向${second}`;
  assert.equal(resolvePromptBindings(original, both, {a: "<Picture 2>", b: "<Picture 1>"}), "<Picture 2>看向<Picture 1>");
  assert.throws(() => resolvePromptBindings(original, both, {a: "<Picture 1>"}), /引用已断开/);
  assert.deepEqual(readPromptBindings(JSON.stringify(both)), both);
  assert.deepEqual(readPromptBindings("broken"), {});
  const node = createWorkbenchNode("video", {x:0,y:0}, {params:{prompt: original, prompt_bindings_json: JSON.stringify(both)}});
  assert.equal(migrateCanvas(serializeCanvas([node], [], {x:0,y:0,zoom:1}),[]).nodes[0].data.params.prompt, original);
});

const plan: StoryboardPlan = {version:1,title:"逃亡审片",duration_seconds:10,music_prompt:"压迫感弦乐",warnings:[],settings:{width:1344,height:768,fps:24,steps:30,profile:"quality",model_id:"h3-int8-native"},shots:[0,1].map(index => ({id:`shot-${index+1}`,title:`镜头${index+1}`,duration_seconds:5,prompt:"<Picture 1> 静止，随后回头。",sound:"屏息",reference_asset_ids:["a"]}))};
const assets = [{id:"a",project_id:"p",kind:"image",name:"主人公",source_path:"C:/fixture.png"}] as Asset[];
test("storyboard materializes references and nodes idempotently; edits remain and production is separate", () => {
  const first = storyboardGraph("one",plan,assets,[],[]);
  assert.equal(first.nodes.filter(node=>node.data.kind === "video").length,2);
  assert.equal(first.edges.length,2);
  const video = first.nodes.find(node=>node.data.kind === "video")!;
  assert.equal(videoRenderParams(video,first.nodes,first.edges,assets).reference_images?.[0],"C:/fixture.png");
  video.data.params.prompt = "用户修改";
  video.data.assetId = "user-output";
  const repeat = storyboardGraph("one",plan,assets,first.nodes,first.edges);
  assert.deepEqual(repeat,first);
  const run = {id:"run",payload:{plan,include_score:false,attempts:{}},jobs:[{id:"job-1"} as Job,null,null]} as ProductionRun;
  const production = storyboardGraph("one",plan,assets,first.nodes,first.edges,run);
  assert.equal(production.nodes.find(node=>node.id === video.id)?.data.params.prompt,"用户修改");
  assert.equal(production.nodes.find(node=>node.id === "production-run-shot-1")?.data.params.prompt,plan.shots[0].prompt);
  assert.equal(production.nodes.find(node=>node.id === "production-run-shot-1")?.data.jobId,"job-1");
  const restored = migrateCanvas(serializeCanvas(production.nodes, production.edges, {x:0,y:0,zoom:1}),assets);
  assert.equal(restored.nodes.find(node=>node.id === "production-run-shot-1")?.data.productionRunId,"run");
  assert.deepEqual(productionJobBindings(run),[{id:"production-run-shot-1",job:run.jobs[0]}]);
  video.selected = true;
  assert.deepEqual(referencedImageIds(first.nodes,first.edges,assets),["a"]);
  const noEdges = storyboardGraph("one",plan,assets,first.nodes,[]);
  assert.equal(noEdges.edges.length,0); // Don't restore deliberately removed links.
});
