import assert from "node:assert/strict";
import test from "node:test";
import { defaultDirector, directorInputs, readDirector, videoRenderParams } from "../src/h3-director.ts";
import { createWorkbenchNode, migrateCanvas, serializeCanvas, nodeConfigurationSignature } from "../src/model.ts";
import type { Asset, WorkbenchEdge } from "../src/types.ts";

test("legacy nodes remain opt-in; new nodes and explicit states round trip", () => {
  const old = migrateCanvas({ nodes: [{id:"old",kind:"video",params:{prompt:"不要修改我",steps:50}}]}, []);
  assert.notEqual(old.nodes[0].data.params.h3_ir_enabled,true);
  const signature=nodeConfigurationSignature(old.nodes[0],[]);
  old.nodes[0].data.params.h3_ir_enabled=false;
  old.nodes[0].data.params.director_json=JSON.stringify(defaultDirector());
  assert.equal(nodeConfigurationSignature(old.nodes[0],[]),signature);
  assert.equal(old.nodes[0].data.params.prompt,"不要修改我");
  const node=createWorkbenchNode("video",{x:0,y:0});
  assert.equal(node.data.params.h3_ir_enabled,true);
  const roundTrip=migrateCanvas(serializeCanvas([node],[],{x:0,y:0,zoom:1}),[]);
  assert.equal(roundTrip.nodes[0].data.params.director_json,node.data.params.director_json);
  assert.equal(roundTrip.nodes[0].data.params.h3_ir_enabled,true);
});

test("generated outputs become references; deleted ports compact every input type", () => {
  const target=createWorkbenchNode("video",{x:0,y:0},{params:{mode:"reference"}});
  const nodes=[target,...["img2","img9","video","audio"].map((id,i)=>createWorkbenchNode(i<2?"image_t2i":"asset",{x:0,y:0},{assetId:id}))];
  const assets=nodes.slice(1).map(node=>({id:node.data.assetId,name:node.data.assetId,source_path:`${node.data.assetId}.local`}) as Asset);
  const ports=["reference_image_2","reference_image_9","reference_video_3","reference_audio_2"];
  const edges=nodes.slice(1).map((node,i)=>({id:`e${i}`,source:node.id,target:target.id,targetHandle:ports[i]}) as WorkbenchEdge).reverse();
  const inputs=directorInputs(target,nodes,edges,assets);
  assert.deepEqual(inputs.map(input=>input.label),["<Picture 1>","<Picture 2>","<Video 1>","<Audio 1>"]);
  const params=videoRenderParams(target,nodes,edges,assets);
  assert.deepEqual(params.reference_images,["img2.local","img9.local"]);
  assert.equal(params.first_frame,null);
  target.data.params.mode="t2v";
  assert.deepEqual(videoRenderParams(target,nodes,edges,assets).reference_images,[]);
});

test("malformed saved Director data is reported instead of crashing the renderer",()=>{
  assert.deepEqual(readDirector({}),defaultDirector());
  for(const value of ["oops",'{"version":2}','{"version":1,"shots":[null]}','{"version":1,"references":[{}]}']) assert.throws(()=>readDirector({director_json:value}));
});
