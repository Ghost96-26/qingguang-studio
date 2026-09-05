import copy
import json
import unittest
from services.orchestrator.workbench.h3_ir import apply_enhancement, duration_frames, enhancement_instruction
from services.orchestrator.workbench.video_options import video_options, video_catalog
from services.orchestrator.workbench.providers import ProviderRegistry


class H3IRTests(unittest.TestCase):
    def setUp(self):
        self.doc = {"version":1,"references":[{"key":"woman.png","name":"女主","role":"character","description":"黑发女性","preserve":"脸型","change":"表情"},{"key":"man.png","role":"character"}],"shots":[{"id":"a","start":0,"action":"图一与图2交谈","performance":"先警惕后微笑","camera":"固定中景","dialogue":[{"speaker_key":"woman.png","language":"Chinese","text":"别担心，我在这里。"}]},{"id":"b","start":2.5,"action":"男人回应","dialogue":[{"speaker_key":"man.png","language":"English","text":"I know."},{"speaker_key":"woman.png","language":"Chinese","text":"好。"}]}]}
        self.params = {"mode":"reference","profile":"quality","prompt":"两人平静交谈。","h3_ir_enabled":True,"duration_seconds":5,"reference_images":["woman.png","man.png"],"director_json":json.dumps(self.doc,ensure_ascii=False)}

    def compile(self, params=None, doc=None):
        p = {**self.params, **(params or {})}
        if doc is not None: p["director_json"] = json.dumps(doc,ensure_ascii=False)
        return video_options(p["mode"], p)

    def response(self, ir):
        return {"summary":"Two people talk calmly.","references":{ref["key"]:{"description":"A character.","preserve":"identity","change":"expression"} for ref in ir["references"]},"shots":{shot["id"]:{"action":"They talk.","performance":"A subtle smile.","camera":"Static shot."} for shot in ir["shots"]},"soundscape":"Quiet room ambience.","music":"N/A"}

    def test_original_is_not_mutated_and_speaker_ids_are_global(self):
        original = copy.deepcopy(self.params)
        value = self.compile()["effective_prompt"]
        self.assertIn("<Subject 1> (S1)",value)
        self.assertIn("<Subject 2> (S2)",value)
        self.assertIn("[Shot 2] At 00:02.500",value)
        self.assertIn("<d>[Chinese] 别担心，我在这里。</d>",value)
        self.assertEqual(self.params,original)
        self.assertEqual(duration_frames(self.params),124)

    def test_legacy_is_opt_in(self):
        self.assertEqual(self.compile({"h3_ir_enabled":False})["effective_prompt"],self.params["prompt"])

    def test_binding_order_compacts_actual_references(self):
        value = self.compile({"reference_images":["man.png","woman.png"]})["effective_prompt"]
        self.assertIn("<Subject 2> (S1)",value)
        self.assertIn("<Subject 1> (S2)",value)

    def test_disconnected_speaker_fails(self):
        with self.assertRaisesRegex(ValueError,"对白角色"):
            self.compile({"reference_images":["woman.png"]})

    def test_invalid_reference_and_timeline_fail(self):
        for patch in ({"prompt":"Look at <Picture 9>"},{"reference_images":["woman.png"]*2},{"duration_seconds":float("nan")},{"director_json":"oops"}):
            with self.subTest(patch=patch),self.assertRaises(ValueError):self.compile(patch)
        for start in (0,7,-1):
            doc=copy.deepcopy(self.doc);doc["shots"][1]["start"]=start
            with self.subTest(start=start),self.assertRaises(ValueError):self.compile(doc=doc)

    def test_structural_invalid_data_fails_cleanly(self):
        for doc in ({"version":2},{"version":1,"references":[{}]},{"version":1,"shots":[None]}, {"version":1,"enhancement":[]}):
            with self.subTest(doc=doc),self.assertRaises(ValueError):self.compile(doc=doc)

    def test_enhancement_preserves_dialogue_and_invalidates_after_edit(self):
        ir=self.compile()["h3_ir"]
        request=enhancement_instruction(ir,self.params,self.params["prompt"])
        self.assertNotIn("别担心",request)
        updated=apply_enhancement(json.dumps(self.response(ir)),ir,self.params,"local-test")
        value=self.compile(updated)
        self.assertTrue(value["h3_ir"]["enhanced"])
        self.assertIn("<d>[Chinese] 别担心，我在这里。</d>",value["effective_prompt"])
        self.assertEqual(updated["prompt"],self.params["prompt"])
        self.assertFalse(self.compile({**updated,"prompt":"changed"})["h3_ir"]["enhanced"])
        self.assertTrue(self.compile({**updated,"steps":40,"seed":42})["h3_ir"]["enhanced"])

    def test_bad_llm_output_cannot_change_structure(self):
        ir=self.compile()["h3_ir"]
        for field in ("references","summary","shots"):
            data=self.response(ir);data[field]={} if field!="summary" else "<d>replace words</d>"
            with self.subTest(field=field),self.assertRaises(ValueError):apply_enhancement(json.dumps(data),ir,self.params,"test")

    def test_presets_still_reach_enhanced_prompt(self):
        params={**self.params,"video_style":"fuji-classic"}
        ir=self.compile(params)["h3_ir"]
        params=apply_enhancement(json.dumps(self.response(ir)),ir,params,"test")
        style=next(o["text"] for o in video_catalog()["groups"][0]["options"] if o["id"]=="fuji-classic")
        self.assertIn(style,self.compile(params)["effective_prompt"])

    def test_native_anchor_graph_matches_compiled_preview(self):
        doc=copy.deepcopy(self.doc);doc["references"][0]["anchor"]=0
        params={**self.params,"director_json":json.dumps(doc)}
        graph=ProviderRegistry._h3_workflow("test","reference",params["prompt"],1344,768,124,7,40,None,{"reference_images":["a.png","b.png"]},params)
        self.assertEqual(graph["6"]["inputs"]["prompt"],self.compile(params)["effective_prompt"])
        guides=[(key,node) for key,node in graph.items() if node["class_type"]=="MiniMaxH3AddGuide"]
        self.assertEqual(len(guides),1)
        key,node=guides[0]
        self.assertEqual(node["inputs"]["frame_idx"],0)
        self.assertEqual(node["inputs"]["image"],graph["6"]["inputs"]["ref_images.ref_image_0"])
        self.assertEqual(graph["8"]["inputs"]["conditioning"],[key,0])
        doc["references"][1]["anchor"]=0
        with self.assertRaisesRegex(ValueError,"同一时刻"):self.compile(doc=doc)

    def test_audio_binding_uses_global_speaker_number(self):
        doc=copy.deepcopy(self.doc);doc["references"].append({"key":"voice.wav","role":"voice","speaker_key":"man.png"})
        value=self.compile({"reference_audios":["voice.wav"]},doc)["effective_prompt"]
        self.assertIn("Voice reference for <Subject 2> (S2)",value)
        self.assertIn("audio reference",value)

    def test_video_audio_numbering_and_mode_switch_anchor_safety(self):
        for enabled in (True,False):
            params={**self.params,"h3_ir_enabled":enabled,"reference_videos":["v.mp4"],"reference_audios":["a.wav"]}
            graph=ProviderRegistry._h3_workflow("test","reference",params["prompt"],1344,768,124,7,40,None,{"reference_images":["a.png","b.png"],"reference_videos":["v.mp4"],"reference_audios":["a.wav"]},params)
            self.assertEqual("ref_video_audios.ref_video_audio_0" in graph["6"]["inputs"],not enabled)
        doc={"version":1,"references":[{"key":"woman.png","anchor":3,"role":"character"}]}
        result=self.compile({"mode":"i2v","first_frame":"woman.png"},doc)["h3_ir"]
        self.assertEqual(result["anchors"],[])
        self.assertTrue(any("暂不使用" in message for message in result["warnings"]))

    def test_base_modes_use_their_own_format(self):
        for mode in ("t2v","i2v","fl2v","audio_drive"):
            value=self.compile({"mode":mode,"first_frame":"a.png","last_frame":"b.png","guide_audio":"a.wav"}, {"version":1})["effective_prompt"]
            self.assertIn("integrated_multimodal_description:\n[Shot 1]",value)
            self.assertNotIn("<Subject",value)
            if mode in ("i2v","audio_drive"):self.assertTrue(value.startswith("For the target video"))
            if mode=="fl2v":self.assertIn("5.17-second",value)

if __name__ == "__main__":unittest.main()
