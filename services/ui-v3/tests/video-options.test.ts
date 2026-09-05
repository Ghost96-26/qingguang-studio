import assert from "node:assert/strict";
import test from "node:test";
import { VIDEO_CATALOG, VIDEO_QUALITY, VIDEO_SIZES, effectiveVideoPrompt, videoGeometry, videoModelPatch, videoSizePatch } from "../src/video-options.ts";
import { createWorkbenchNode, migrateCanvas, remapNodeMode, serializeCanvas } from "../src/model.ts";
import { placeNodePopover } from "../src/popover-position.ts";

test("parameter popup stays in screen space and prefers above the trigger", () => {
  assert.deepEqual(placeNodePopover({left:100,top:600,bottom:636},{width:368,height:450},{width:1280,height:720}), {left:100,top:142,width:368,maxHeight:696});
  for (const width of [360,768,1280]) for (const height of [480,720,1080]) {
    const p = placeNodePopover({left:width-20,top:40,bottom:76},{width:368,height:800},{width,height});
    assert.ok(p.left >= 12 && p.top >= 12 && p.left + p.width <= width-12);
    assert.ok(p.maxHeight <= height-24);
  }
});

test("quality presets are 20/30/40 without overwriting historical steps", () => {
  assert.deepEqual(VIDEO_QUALITY.map(([steps]) => steps), [20,30,40]);
  const old = migrateCanvas({nodes:[{id:"old",kind:"video",params:{steps:50,profile:"quality"}}]}, []);
  assert.equal(old.nodes[0].data.params.steps, 50);
});

test("every aspect and resolution respects native area and 32 pixel alignment", () => {
  for (const sizes of Object.values(VIDEO_SIZES)) for (const [width,height] of sizes) {
    assert.equal(width % 32, 0);
    assert.equal(height % 32, 0);
    assert.ok(width >= 256 && height >= 256 && width * height <= 1344 * 768);
  }
});

test("aspect changes keep quality, duration and reference assets intact", () => {
  const params = {width:1344,height:768,steps:40,duration_seconds:10,reference_images:["a","b"]};
  const changed = {...params,...videoSizePatch(params,"9:16")};
  assert.deepEqual(changed, {...params,width:768,height:1344});
  assert.deepEqual(videoSizePatch(changed,"16:9"), {width:1344,height:768});
  assert.equal(videoGeometry({width:512,height:512}).tier, -1);
});

test("variants use matching steps and reference mode cannot retain Turbo8", () => {
  const base = createWorkbenchNode("video", {x:0,y:0}, {params:videoModelPatch("h3-int8-turbo8")});
  assert.equal(base.data.params.steps,8);
  const result = remapNodeMode(base.id,"reference",[base],[],[]).nodes[0];
  assert.equal(result.data.params.model_id,"h3-int8-native");
  assert.equal(result.data.params.steps,30);
});

test("guidance is additive, reversible, and does not duplicate over repeated previews", () => {
  const params = {prompt:"两人平稳交谈。",video_style:"fuji-classic",camera_lens:"cooke-s4",focal_length:"85mm"};
  const expected = params.prompt + "\n\n" + VIDEO_CATALOG.guidance_header + "\n" + [
    VIDEO_CATALOG.groups[0].options.find(o=>o.id==="fuji-classic")!.text,
    VIDEO_CATALOG.groups[2].options.find(o=>o.id==="cooke-s4")!.text,
    VIDEO_CATALOG.groups[3].options.find(o=>o.id==="85mm")!.text,
  ].join("\n");
  assert.equal(effectiveVideoPrompt(params),expected);
  assert.equal(effectiveVideoPrompt(params),expected);
  assert.equal(params.prompt,"两人平稳交谈。");
  assert.equal(effectiveVideoPrompt({...params,video_style:"none",camera_lens:"none",focal_length:"none"}),params.prompt);
});

test("all creative selections survive canvas save and reload", () => {
  const node = createWorkbenchNode("video", {x:0,y:0}, {params:{model_id:"h3-int8-native",profile:"quality",steps:40,video_style:"woodcut",camera_body:"alexa35",camera_lens:"zeiss-master",focal_length:"50mm",aperture:"f4",camera_motion:"tracking",scheduler:"beta"}});
  const stored = serializeCanvas([node],[],{x:0,y:0,zoom:1});
  assert.deepEqual(migrateCanvas(stored,[]).nodes[0].data.params,node.data.params);
});
