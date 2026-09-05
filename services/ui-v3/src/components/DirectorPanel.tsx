import { FilmSlate, Plus, Sparkle, SpinnerGap, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useCanvasStore } from "../canvas-store";
import { defaultDirector, defaultReference, directorInputs, readDirector, type DirectorDocument, type DirectorReference, type H3IRPreview } from "../h3-director";
import type { WorkbenchParams } from "../types";
import { useWorkspace } from "../workspace-context";

const roles = { character: "人物 / 身份", scene: "场景设定", prop: "道具", style: "风格", motion: "动作 / 运镜", composition: "构图 / 关键帧", voice: "音色", sound: "声音 / 节奏" };
function TextField({ label, value, onChange, placeholder = "", multiline = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; multiline?: boolean }) {
  return <label className="director-field"><span>{label}</span>{multiline ? <textarea value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} rows={3} maxLength={4000} /> : <input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} maxLength={4000} />}</label>;
}

export function DirectorPanel({ nodeId, params, onChange, disabled = false, previewOnly = false }: { nodeId: string; params: WorkbenchParams; onChange: (patch: WorkbenchParams) => void; disabled?: boolean; previewOnly?: boolean }) {
  const { assets, compileH3, optimizePrompt, notify } = useWorkspace();
  const nodes = useCanvasStore(state => state.nodes);
  const edges = useCanvasStore(state => state.edges);
  const [tab, setTab] = useState(previewOnly ? "preview" : "references");
  const [preview, setPreview] = useState<H3IRPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const node = nodes.find(item => item.id === nodeId);
  const inputs = useMemo(() => node ? directorInputs(node, nodes, edges, assets) : [], [node, nodes, edges, assets]);
  const inputSignature = JSON.stringify(inputs.map(item => [item.key, item.port]));
  const parsed = useMemo(() => { try { return { doc: readDirector(params), error: "" }; } catch (failure) { return { doc: defaultDirector(), error: String(failure) }; } }, [params.director_json]);
  const doc = parsed.doc;
  const enabled = params.h3_ir_enabled === true;
  const locked = disabled || optimizing;
  const save = (next: DirectorDocument) => onChange({ director_json: JSON.stringify(next) });
  const updateReference = (key: string, patch: Partial<DirectorReference>) => {
    const input = inputs.find(item => item.key === key);
    if (!input) return;
    const previous = doc.references.find(item => item.key === key) || defaultReference(input);
    save({ ...doc, references: [...doc.references.filter(item => item.key !== key), { ...previous, ...patch }] });
  };
  const characters = inputs.filter(input => (doc.references.find(item => item.key === input.key) || defaultReference(input)).role === "character");
  const patchShot = (index: number, patch: Partial<DirectorDocument["shots"][number]>) => save({ ...doc, shots: doc.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot) });
  const paramsSignature = JSON.stringify(params);
  useEffect(() => {
    let active = true;
    setPreview(null); setError(""); setLoading(true);
    const timer = window.setTimeout(() => {
      void compileH3(nodeId).then(result => { if (active) setPreview(result); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (active) setLoading(false); });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [nodeId, paramsSignature, inputSignature, compileH3]);

  return <div className="director-panel">
    {!previewOnly ? <label className="director-enable"><span><FilmSlate /> H3-IR 本地导演</span><input type="checkbox" checked={enabled} disabled={locked} onChange={event => onChange({ h3_ir_enabled: event.target.checked })} /></label> : null}
    <p className="parameter-explainer">原文保留。角色与表演是提示词引导；图片时间锚点会接入真实生成流程。{!enabled ? "当前关闭，生成仍使用原提示词。" : "设置自动保存。"}</p>
    {parsed.error ? <div role="alert" className="parameter-warning">{parsed.error}<button type="button" disabled={locked} onClick={() => save(defaultDirector())}>恢复空白导演配置</button></div> : null}
    {!previewOnly ? <div className="director-tabs" role="tablist" aria-label="导演台分类">
      {[['references','素材与角色'],['shots','镜头与表演'],['preview','指令预览']].map(([id,label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onKeyDown={event => {
        if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role=tab]')];
        const index = tabs.indexOf(event.currentTarget);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
        tabs[next].click(); tabs[next].focus();
      }} onClick={() => setTab(id)}>{label}</button>)}
    </div> : null}
    <fieldset disabled={locked || !enabled || Boolean(parsed.error)} className="director-body">
      {tab === "references" ? <>
        {!inputs.length ? <p className="parameter-explainer">接入图片、视频或音频后，在这里设置用途。文生视频可直接进入“镜头与表演”。</p> : null}
        {inputs.map((input, i) => {
          const ref = doc.references.find(item => item.key === input.key) || defaultReference(input);
          return <details key={`${input.port}:${input.key}`} className="director-card" open={inputs.length === 1 || undefined}>
            <summary><span className="director-index">{i + 1}</span><span>{ref.name}<small>{input.label} · {roles[ref.role as keyof typeof roles]}</small></span></summary>
            <div className="director-card-content">
              <TextField label="素材称呼" value={ref.name} onChange={name => updateReference(input.key, { name: name.slice(0,80) })} placeholder="如：女主角、男主角、咖啡店" />
              <label className="director-field"><span>参考用途</span><select value={ref.role} onChange={event => updateReference(input.key, { role: event.target.value })}>{Object.entries(roles).filter(([key]) => input.kind === "audio" ? ["voice","sound"].includes(key) : !["voice","sound"].includes(key)).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <TextField label="内容描述" value={ref.description} onChange={description => updateReference(input.key, { description })} placeholder="明确素材里要参考的人物或物体，不自动猜测身份" />
              <TextField label="必须保留" value={ref.preserve} onChange={preserve => updateReference(input.key, { preserve })} placeholder="如：脸型、黑发、眼镜；服装保持不变" />
              <TextField label="允许改变" value={ref.change} onChange={change => updateReference(input.key, { change })} placeholder="如：只改变动作和表情" />
              {input.kind !== "audio" ? <label className="director-field"><span>保留规则 · 语义引导</span><select value={ref.retention} onChange={event => updateReference(input.key, { retention: event.target.value })}><option value="fully_preserved">保留所定义的特征</option><option value="partially_preserved">部分保留</option><option value="attribute_transfer">迁移属性</option><option value="weak_reference">弱参考</option></select></label> : <label className="director-field"><span>绑定说话人（须在对白中使用）</span><select value={ref.speaker_key || ""} onChange={event => updateReference(input.key, { speaker_key: event.target.value })}><option value="">不绑定 / 环境声音</option>{characters.map(item => <option key={item.key} value={item.key}>{doc.references.find(ref => ref.key === item.key)?.name || item.asset.name}</option>)}</select></label>}
              {input.kind === "image" && params.mode === "reference" ? <div className="director-anchor"><label><input type="checkbox" checked={ref.anchor != null} onChange={event => updateReference(input.key, { anchor: event.target.checked ? 0 : null })} />在指定时间锁定为关键帧</label>{ref.anchor != null ? <label className="director-field"><span>锚点时间（秒）</span><input type="number" min={0} max={Number(params.duration_seconds || 5)} step={1 / 24} value={ref.anchor} onChange={event => updateReference(input.key, { anchor: event.target.value === "" ? 0 : Number(event.target.value) })} /><small>图片会按画幅居中裁剪；这会约束整幅画面，不只是人物身份。</small></label> : null}</div> : null}
              {input.kind === "video" ? <p className="parameter-explainer">此模式仅参考视频画面；需要声音请单独接入音频。</p> : null}
            </div>
          </details>;
        })}
      </> : null}
      {tab === "shots" ? <>
        <p className="parameter-explainer">镜头1从0秒开始，后续时间表示切镜。表情和动作先后写在表演说明里；不能保证逐帧精确执行。</p>
        <div className="director-timeline" aria-label="镜头时间概览">{doc.shots.map((shot,i) => <span key={shot.id}>镜头{i + 1}<small>{shot.start}s</small></span>)}</div>
        {doc.shots.map((shot,i) => <details className="director-card" key={shot.id} open={doc.shots.length === 1 || undefined}>
          <summary><span className="director-index">{i + 1}</span><span>镜头 {i + 1}<small>{shot.start}s · {shot.action || "遵循原提示词"}</small></span></summary>
          <div className="director-card-content">
            <label className="director-field"><span>开始时间（秒）</span><input type="number" min={0} max={Number(params.duration_seconds || 5)} step={0.1} value={shot.start} disabled={i === 0} onChange={event => patchShot(i, { start: Number(event.target.value) })} /></label>
            <TextField label="画面与动作" value={shot.action} onChange={action => patchShot(i, { action })} multiline placeholder="如：两人在窗边交谈，人物与服装遵循参考图" />
            <TextField label="表情、视线与节奏" value={shot.performance} onChange={performance => patchShot(i, { performance })} multiline placeholder="如：女主先警惕地看着对方，听完后缓缓放松眉头，最后露出克制的微笑" />
            <TextField label="本镜头摄影要求" value={shot.camera} onChange={camera => patchShot(i, { camera })} placeholder="如：固定中近景，缓慢推进，无切镜" />
            <div className="director-dialogues"><span>对白 · 原文锁定</span>{shot.dialogue.map((line,j) => <div className="director-line" key={j}>
              <select aria-label={`镜头${i + 1}对白${j + 1}说话人`} value={line.speaker_key} onChange={event => patchShot(i, { dialogue: shot.dialogue.map((value,k) => k === j ? { ...value, speaker_key: event.target.value } : value) })}><option value="">选择人物</option>{characters.map(item => <option key={item.key} value={item.key}>{doc.references.find(ref => ref.key === item.key)?.name || item.asset.name}</option>)}</select>
              <select aria-label={`镜头${i + 1}对白${j + 1}语言`} value={line.language} onChange={event => patchShot(i, { dialogue: shot.dialogue.map((value,k) => k === j ? { ...value, language: event.target.value } : value) })}><option value="Chinese">中文</option><option value="English">English</option><option value="Japanese">日语</option><option value="Korean">韩语</option></select>
              <textarea aria-label={`镜头${i + 1}对白${j + 1}台词`} maxLength={1000} value={line.text} placeholder="台词只写一次，LLM不会改写" onChange={event => patchShot(i, { dialogue: shot.dialogue.map((value,k) => k === j ? { ...value, text: event.target.value } : value) })} />
              <button type="button" aria-label={`删除镜头${i + 1}对白${j + 1}`} onClick={() => patchShot(i, { dialogue: shot.dialogue.filter((_,k) => k !== j) })}><Trash /></button>
            </div>)}<button type="button" className="parameter-text-action" disabled={!characters.length || shot.dialogue.length >= 12} onClick={() => patchShot(i, { dialogue: [...shot.dialogue, { speaker_key: characters[0]?.key || "", language: "Chinese", text: "" }] })}><Plus /> 添加对白</button>{!characters.length ? <small>接入人物参考后可分配说话人；文生视频的对白也可直接写入原提示词。</small> : null}</div>
            {i > 0 ? <button type="button" className="parameter-text-action" onClick={() => save({ ...doc, shots: doc.shots.filter((_,j) => j !== i) })}><Trash /> 删除此镜头</button> : null}
          </div>
        </details>)}
        <button type="button" className="parameter-text-action" disabled={doc.shots.length >= 6} onClick={() => save({ ...doc, shots: [...doc.shots, { id: crypto.randomUUID(), start: Math.round(((doc.shots.at(-1)?.start || 0) + Number(params.duration_seconds || 5)) * 5) / 10, action: "", performance: "", camera: "", dialogue: [] }] })}><Plus /> 添加镜头</button>
        <TextField label="环境声音" value={doc.soundscape} onChange={soundscape => save({ ...doc, soundscape })} placeholder="如：风声、衣服摩擦声，环境声保持轻柔" />
        <TextField label="背景音乐" value={doc.music} onChange={music => save({ ...doc, music })} placeholder="留空默认不添加背景音乐" />
      </> : null}
    </fieldset>
    {tab === "preview" ? <div className="director-preview"><p className="parameter-explainer">这里来自后端同一个编译器，不是界面模拟文本。{preview?.h3_ir ? `${preview.h3_ir.frames}帧 · ${preview.h3_ir.seconds.toFixed(3)}秒 · ${preview.h3_ir.enhanced ? "本地LLM已增强" : "规则编译"}` : ""}</p><textarea readOnly aria-label="H3实际编译指令" value={preview?.effective_prompt || ""} placeholder={loading ? "正在校验…" : "指令校验通过后显示"} /><button type="button" className="parameter-text-action" disabled={!preview} onClick={() => { void navigator.clipboard.writeText(preview!.effective_prompt).then(() => notify("已复制实际指令。", "success")).catch(() => notify("复制失败，可选中文本手动复制。", "danger")); }}>复制指令</button></div> : null}
    {error ? <p className="parameter-warning" role="alert">{error}</p> : null}
    {preview?.h3_ir?.warnings.map(warning => <p className="parameter-explainer" key={warning}>{warning}</p>)}
    {!previewOnly ? <button type="button" className="director-optimize" disabled={locked || !enabled || loading || Boolean(error) || !String(params.prompt || "").trim()} onClick={async () => {
      setOptimizing(true);
      try { await optimizePrompt(nodeId); } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure), "danger"); } finally { setOptimizing(false); }
    }}>{optimizing ? <SpinnerGap className="spin" /> : <Sparkle />}{optimizing ? "本地LLM整理中…" : "本地LLM增强指令"}</button> : null}
  </div>;
}
