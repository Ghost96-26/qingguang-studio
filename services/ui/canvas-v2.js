const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  key: sessionStorage.getItem("h3-workbench-key") || "",
  projectId: localStorage.getItem("h3-project-id") || "default",
  projects: [], capabilities: null, jobs: [], assets: [],
  nodes: [], edges: [], groups: [],
  viewport: { x: 36, y: 28, zoom: 1 },
  selectedIds: [], selectedGroupId: null,
  objectUrls: new Map(), saveTimer: null, pollTimer: null,
  history: [], connecting: null,
};

const kindMeta = {
  video: { title: "H3 视频生成", icon: "i-video", output: "video" },
  image_t2i: { title: "文生图", icon: "i-image", output: "image" },
  image_i2i: { title: "图生图", icon: "i-image", output: "image" },
  image_edit: { title: "图片编辑", icon: "i-edit", output: "image" },
  tts: { title: "角色对白", icon: "i-voice", output: "audio" },
  dialogue: { title: "多角色对白编排", icon: "i-link", output: "audio" },
  music: { title: "Music 3 配乐", icon: "i-music", output: "audio" },
  agent: { title: "制作 Agent", icon: "i-agent", output: "text" },
  note: { title: "制作便笺", icon: "i-note", output: "text" },
  asset: { title: "资产", icon: "i-asset", output: "any" },
};

const videoModes = {
  t2v: { label: "文生视频", short: "T2V" },
  i2v: { label: "首帧生成", short: "I2V" },
  fl2v: { label: "首尾帧", short: "FL2V" },
  reference: { label: "多模态参考", short: "REF" },
  audio_drive: { label: "对白驱动", short: "AUDIO" },
};

const statusText = {
  queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消",
  pending: "待审批", approved: "已通过", rejected: "已驳回", not_required: "", starting: "启动中",
  generating: "生成中", generating_image: "生成图片", synthesizing_voice: "合成对白", assembling_dialogue: "编排对白", generating_music: "生成音乐", generating_agent_response: "Agent 推理",
};
const jobTypeText = { "h3.t2v": "H3 视频", "image.t2i": "文生图", "image.i2i": "图生图", "image.edit": "图片编辑", "tts.clone": "角色对白", "audio.sequence": "对白编排", "music.generate": "Music 3", "agent.chat": "制作 Agent", "system.noop": "队列测试" };

const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"></use></svg>`;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const clone = (value) => JSON.parse(JSON.stringify(value));

function toast(message, timeout = 3600) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove("show"), timeout);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.key) headers.set("X-Workbench-Key", state.key);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try { const payload = await response.json(); detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail); } catch { /* non-json */ }
    if (response.status === 401) showLogin("访问密钥无效，请重新输入。");
    throw new Error(detail);
  }
  return (response.headers.get("content-type") || "").includes("application/json") ? response.json() : response;
}

function showLogin(message) {
  $("#login").hidden = false; $("#app").hidden = true;
  $("#login-status").textContent = message || "请输入工作台访问密钥。";
}

async function authenticate(key) {
  state.key = key;
  await api("/v1/capabilities");
  sessionStorage.setItem("h3-workbench-key", key);
  $("#login").hidden = true; $("#app").hidden = false;
  await boot();
}

async function attemptLocalAuth() {
  if (state.key) { try { await authenticate(state.key); return; } catch { sessionStorage.removeItem("h3-workbench-key"); } }
  if (!["127.0.0.1", "localhost", "::1"].includes(location.hostname)) { showLogin("团队电脑请输入管理员提供的访问密钥。"); return; }
  try { const response = await fetch("/v1/local-auth"); const payload = await response.json(); await authenticate(payload.api_key); }
  catch (error) { showLogin(`自动登录失败：${error.message}`); }
}

async function boot() {
  clearInterval(state.pollTimer);
  [state.capabilities, state.projects] = await Promise.all([api("/v1/capabilities"), api("/v1/projects")]);
  if (!state.projects.some((project) => project.id === state.projectId)) state.projectId = state.projects[0]?.id || "default";
  renderCapabilities(); renderProjects();
  await loadProject();
  state.pollTimer = setInterval(refreshJobs, 2200);
}

function renderCapabilities() {
  const providers = state.capabilities?.providers || {};
  const labels = { h3: "H3", image: "图像", tts: "TTS 2.5", music: "Music 3", agent: "LLM" };
  $("#provider-status").innerHTML = Object.entries(labels).map(([key, label]) => `<span class="provider-chip ${providers[key]?.ready ? "ready" : ""}">${label}</span>`).join("");
}

function renderProjects() {
  $("#project-select").innerHTML = state.projects.map((project) => `<option value="${esc(project.id)}" ${project.id === state.projectId ? "selected" : ""}>${esc(project.name)}</option>`).join("");
}

async function loadProject() {
  clearTimeout(state.saveTimer);
  localStorage.setItem("h3-project-id", state.projectId);
  const [canvas, jobs, assets] = await Promise.all([
    api(`/v1/projects/${encodeURIComponent(state.projectId)}/canvas`),
    api(`/v1/jobs?project_id=${encodeURIComponent(state.projectId)}&limit=120`),
    api(`/v1/assets?project_id=${encodeURIComponent(state.projectId)}&limit=300`),
  ]);
  state.jobs = jobs; state.assets = assets;
  state.nodes = Array.isArray(canvas.state?.nodes) ? canvas.state.nodes : [];
  state.edges = Array.isArray(canvas.state?.edges) ? canvas.state.edges : [];
  state.groups = Array.isArray(canvas.state?.groups) ? canvas.state.groups : [];
  state.viewport = { x: 36, y: 28, zoom: 1, ...(canvas.state?.viewport || {}) };
  state.selectedIds = []; state.selectedGroupId = null; state.history = [];
  if (!state.nodes.length) createStarterCanvas();
  attachGeneratedAssets(); applyViewport(); renderAll(); scheduleSave();
}

function createStarterCanvas() {
  state.nodes = [
    { id: crypto.randomUUID(), kind: "note", x: 40, y: 80, title: "擎光绘影 · 快速上手", text: "从资产库拖入素材节点，再从节点右侧输出端口拖线到生成节点的输入端口。\n\nShift 多选；Ctrl+G 组合；F2 重命名；Delete 删除；Ctrl+Z 撤销。", expanded: false },
    { id: crypto.randomUUID(), kind: "video", x: 520, y: 70, title: "H3 镜头", params: defaultParams("video"), expanded: true },
    { id: crypto.randomUUID(), kind: "tts", x: 1040, y: 70, title: "角色对白", params: defaultParams("tts"), expanded: false },
    { id: crypto.randomUUID(), kind: "music", x: 520, y: 760, title: "场景配乐", params: defaultParams("music"), expanded: false },
    { id: crypto.randomUUID(), kind: "agent", x: 1040, y: 760, title: "制作 Agent", params: defaultParams("agent"), expanded: false },
  ];
}

function defaultParams(kind) {
  if (kind === "video") return { mode: "t2v", profile: "preview8", width: 608, height: 352, duration_seconds: 5, seed: 7, ref_image_size: "match" };
  if (kind === "image_t2i") return { model_id: "krea2-turbo-bf16", prompt_model: "qwen3.6-27b-q4", width: 1024, height: 1024, seed: 7, style: "auto", style_lora: "none", lora_strength: 1 };
  if (kind === "image_i2i") return { model_id: "krea2-turbo-bf16", prompt_model: "qwen3.6-27b-q4", width: 1024, height: 1024, seed: 7, strength: .45, style: "preserve" };
  if (kind === "image_edit") return { model_id: "krea2-identity-edit-v1.2", prompt_model: "qwen3.6-27b-q4", width: 1024, height: 1024, seed: 7, preservation: 4, edit_mode: "instruction" };
  if (kind === "tts") return { language: "ZH", seed: 7, duration_factor: 1 };
  if (kind === "dialogue") return { gap_seconds: .35 };
  if (kind === "music") return { lyrics: "[Instrumental]", duration_seconds: 10, seed: 7 };
  if (kind === "agent") return { prompt_model: "qwen3.6-27b-q4", max_tokens: 512, reasoning: false };
  return {};
}

function pushHistory() {
  state.history.push(JSON.stringify({ nodes: state.nodes, edges: state.edges, groups: state.groups }));
  if (state.history.length > 40) state.history.shift();
}

function undo() {
  const previous = state.history.pop();
  if (!previous) { toast("没有可以撤销的操作。"); return; }
  const snapshot = JSON.parse(previous);
  state.nodes = snapshot.nodes; state.edges = snapshot.edges; state.groups = snapshot.groups;
  state.selectedIds = []; state.selectedGroupId = null;
  renderAll(); scheduleSave(); toast("已撤销上一步操作。");
}

function renderAll() { renderWorld(); renderJobs(); renderAssets(); renderSelectionToolbar(); }
function getJob(node) { return node?.jobId ? state.jobs.find((job) => job.id === node.jobId) : null; }

function attachGeneratedAssets() {
  let changed = false;
  for (const node of state.nodes) if (!node.assetId && node.jobId) {
    const asset = state.assets.find((item) => item.origin_job_id === node.jobId);
    if (asset) { node.assetId = asset.id; changed = true; }
  }
  if (changed) scheduleSave();
}

function outputType(node) {
  if (node.kind !== "asset") return kindMeta[node.kind]?.output || "any";
  const asset = state.assets.find((item) => item.id === node.assetId);
  const media = asset?.media_type || "";
  if (media.startsWith("image/")) return "image";
  if (media.startsWith("video/")) return "video";
  if (media.startsWith("audio/")) return "audio";
  if (asset?.kind === "text") return "text";
  return asset?.kind || "any";
}

function inputPorts(node) {
  if (node.kind === "video") {
    const mode = node.params?.mode || "t2v";
    if (mode === "i2v") return [{ key: "first_frame", label: "首帧图片", accepts: "image" }];
    if (mode === "fl2v") return [{ key: "first_frame", label: "首帧图片", accepts: "image" }, { key: "last_frame", label: "尾帧图片", accepts: "image" }];
    if (mode === "reference") return [
      { key: "reference_image_1", label: "参考图 1", accepts: "image" }, { key: "reference_image_2", label: "参考图 2", accepts: "image" }, { key: "reference_image_3", label: "参考图 3", accepts: "image" },
      { key: "reference_video_1", label: "参考视频", accepts: "video" }, { key: "reference_audio_1", label: "参考音频", accepts: "audio" },
    ];
    if (mode === "audio_drive") return [{ key: "guide_audio", label: "对白/声音轨", accepts: "audio" }, { key: "first_frame", label: "可选首帧", accepts: "image", optional: true }];
  }
  if (node.kind === "image_i2i") return [{ key: "source_image", label: "源图片", accepts: "image" }, { key: "style_image", label: "可选风格参考", accepts: "image", optional: true }];
  if (node.kind === "image_edit") return [{ key: "source_image", label: "待编辑图片", accepts: "image" }, { key: "reference_image", label: "人物/物体参考", accepts: "image", optional: true }, { key: "mask_image", label: "可选蒙版", accepts: "image", optional: true }];
  if (node.kind === "tts") return [{ key: "reference_audio", label: "角色参考音色", accepts: "audio" }];
  if (node.kind === "dialogue") return Array.from({length:6},(_,index)=>({key:`voice_${index+1}`,label:`第 ${index+1} 段对白`,accepts:"audio",optional:index>1}));
  if (node.kind === "agent") return [{ key: "context", label: "上下文素材", accepts: "any", optional: true }];
  return [];
}

function edgeFor(to, port) { return state.edges.find((edge) => edge.to === to && edge.port === port); }
function sourceNode(edge) { return edge ? state.nodes.find((node) => node.id === edge.from) : null; }

function catalogModels(modality) {
  const providers = state.capabilities?.providers || {};
  if (modality === "image") return providers.image?.models || [];
  if (modality === "prompt") return providers.agent?.models || [];
  return [];
}

function modelOptions(modality, selected, capability = "") {
  const models = catalogModels(modality).filter((model) => !capability || model.capabilities?.includes(capability));
  if (!models.length) return `<option value="">尚未发现本地模型</option>`;
  return models.map((model) => {
    const stateLabel = model.ready ? "可用" : model.weights_ready ? "待验收" : model.availability === "pending_location" ? "待定位" : "待下载";
    return `<option value="${esc(model.id)}" ${selected === model.id ? "selected" : ""}>${esc(model.label)} · ${stateLabel}</option>`;
  }).join("");
}

function promptTools(p) {
  return `<div class="prompt-tools"><select name="prompt_model" aria-label="提示词优化模型">${modelOptions("prompt", p.prompt_model || "qwen3.6-27b-q4")}</select><button type="button" class="optimize-prompt">${icon("i-sparkle")}一键优化</button></div>`;
}

function portsHtml(node) {
  const ports = inputPorts(node);
  if (!ports.length) return "";
  return `<div class="input-stack">${ports.map((port) => {
    const edge = edgeFor(node.id, port.key); const source = sourceNode(edge);
    return `<div class="input-port-row ${edge ? "connected" : ""}">
      <button class="port-handle input-port" data-input-node="${node.id}" data-port="${port.key}" data-accepts="${port.accepts}" aria-label="连接${esc(port.label)}"></button>
      <span>${esc(port.label)}${port.optional ? "（可选）" : ""}${source ? `<small class="connected-source">${esc(source.title)}</small>` : ""}</span>
      ${edge ? `<button class="disconnect-input" data-disconnect="${edge.id}" aria-label="断开${esc(port.label)}">${icon("i-close")}</button>` : `<span class="port-type">${port.accepts.toUpperCase()}</span>`}
    </div>`;
  }).join("")}</div><p class="input-help">从素材或生成节点右侧端口拖线到输入端口。</p>`;
}

function nodeMedia(node, job, asset) {
  if (asset) {
    const media = asset.media_type || "";
    if (media.startsWith("video/") || asset.kind === "video") return `<video class="node-media" data-asset-id="${asset.id}" controls preload="none" aria-label="${esc(asset.name)}"></video>`;
    if (media.startsWith("image/")) return `<img class="node-media" data-asset-id="${asset.id}" loading="lazy" alt="${esc(asset.name)}">`;
    if (media.startsWith("audio/") || asset.kind === "audio") return `<audio class="node-audio" data-asset-id="${asset.id}" controls preload="none"></audio>`;
    return `<p class="node-prompt">${esc(asset.name)}</p>`;
  }
  if (job?.type === "agent.chat" && job.result?.text) return `<p class="node-prompt">${esc(job.result.text)}</p>`;
  if (node.kind === "note") return `<p class="node-prompt">${esc(node.text || "输入制作说明。")}</p>`;
  const prompt = node.params?.prompt || node.params?.text || "尚未填写生成内容。";
  const progress = job && ["queued", "running"].includes(job.status) ? `<div class="node-progress"><span style="width:${Math.max(4, Math.round(job.progress * 100))}%"></span></div>` : "";
  return `<p class="node-prompt ${prompt.startsWith("尚未") ? "node-empty" : ""}">${esc(prompt)}</p>${progress}`;
}

function deriveActions(node, asset) {
  if (!asset) return "";
  const type = outputType(node);
  const actions = type === "image" ? [
    { kind: "image_i2i", port: "source_image", label: "图生图", icon: "i-image" },
    { kind: "image_edit", port: "source_image", label: "图片编辑", icon: "i-edit" },
    { kind: "video", port: "first_frame", mode: "i2v", label: "生成视频", icon: "i-video" },
  ] : type === "video" ? [
    { kind: "video", port: "reference_video_1", mode: "reference", label: "参考生成", icon: "i-video" },
  ] : type === "audio" ? [
    { kind: "video", port: "guide_audio", mode: "audio_drive", label: "驱动视频", icon: "i-video" },
    { kind: "dialogue", port: "voice_1", label: "加入对白编排", icon: "i-link" },
  ] : [];
  if (!actions.length) return "";
  return `<div class="derive-strip" aria-label="继续创作"><span>继续创作</span><div>${actions.map((action) => `<button type="button" data-derive-from="${node.id}" data-derive-kind="${action.kind}" data-derive-port="${action.port}" data-derive-mode="${action.mode || ""}">${icon(action.icon)}${action.label}</button>`).join("")}</div></div>`;
}

function nodeEditor(node, job) {
  if (!node.expanded || node.kind === "asset") return "";
  const p = node.params || {}; const busy = job && ["queued", "running"].includes(job.status); const disabled = busy ? "disabled" : "";
  const submitLabel = job ? "按当前设置重新生成" : "提交到本地队列";
  if (node.kind === "video") {
    const mode = p.mode || "t2v";
    return `<div class="inline-editor"><p class="eyebrow">H3 WORKFLOW</p>
      <div class="mode-tabs">${Object.entries(videoModes).map(([key, item]) => `<button type="button" class="mode-tab ${mode === key ? "active" : ""}" data-video-mode="${key}">${esc(item.label)}</button>`).join("")}</div>
      <form class="node-form" data-form-node="${node.id}">
        <div class="field"><label>镜头提示词 *</label><textarea name="prompt" required ${disabled}>${esc(p.prompt || "")}</textarea>${promptTools(p)}</div>
        <div class="field-row"><div class="field"><label>宽度</label><select name="width" ${disabled}>${[608,768,1344].map((v) => `<option ${Number(p.width) === v ? "selected" : ""}>${v}</option>`).join("")}</select></div><div class="field"><label>高度</label><select name="height" ${disabled}>${[352,432,768].map((v) => `<option ${Number(p.height) === v ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
        <div class="field-row"><div class="field"><label>时长（秒）</label><input name="duration" type="number" min="1" max="15" value="${Number(p.duration_seconds || 5)}" ${disabled}></div><div class="field"><label>Seed</label><input name="seed" type="number" value="${Number.isFinite(Number(p.seed)) ? Number(p.seed) : 7}" ${disabled}></div></div>
        <details class="advanced-disclosure"><summary>质量与参考设置</summary><div class="field-row"><div class="field"><label>预览档位</label><select name="profile" ${disabled}><option value="preview8" ${p.profile !== "preview4" ? "selected" : ""}>8 步稳定</option><option value="preview4" ${p.profile === "preview4" ? "selected" : ""}>4 步极速</option></select></div><div class="field"><label>参考图精度</label><select name="ref_image_size" ${disabled}><option value="match" ${p.ref_image_size !== "max" ? "selected" : ""}>匹配画布</option><option value="max" ${p.ref_image_size === "max" ? "selected" : ""}>身份优先</option></select></div></div></details>
        <div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button>${reviewButton(job)}</div>
      </form></div>`;
  }
  if (["image_t2i", "image_i2i", "image_edit"].includes(node.kind)) {
    const imageProvider = state.capabilities?.providers?.image;
    const runtimeReady = Boolean(imageProvider?.ready);
    const imageDisabled = busy || !runtimeReady ? "disabled" : "";
    const capability = node.kind === "image_edit" ? "identity_edit" : node.kind === "image_i2i" ? "image_to_image" : "text_to_image";
    const title = node.kind === "image_edit" ? "IMAGE EDIT" : node.kind === "image_i2i" ? "IMAGE TO IMAGE" : "TEXT TO IMAGE";
    const sourceNote = node.kind === "image_edit" ? "将待编辑图片连接到左侧输入，可再连接人物参考或身份保持蒙版。" : node.kind === "image_i2i" ? "将画布中的图片素材连接到源图片输入，可追加风格或人物参考。" : "Krea 2 负责审美图像，Ideogram 4 负责文字、包装和版式。";
    const extra = node.kind === "image_i2i"
      ? `<div class="field"><label>重绘强度</label><input name="strength" type="number" min="0.05" max="1" step="0.05" value="${Number(p.strength ?? .45)}" ${imageDisabled}></div>`
      : node.kind === "image_edit"
        ? `<div class="field-row"><div class="field"><label>编辑方式</label><select name="edit_mode" ${imageDisabled}><option value="instruction" ${p.edit_mode !== "inpaint" ? "selected" : ""}>自然语言编辑</option><option value="inpaint" ${p.edit_mode === "inpaint" ? "selected" : ""}>蒙版局部编辑</option></select></div><div class="field"><label>身份保持</label><input name="preservation" type="number" min="0" max="8" step=".5" value="${Number(p.preservation ?? 4)}" ${imageDisabled}></div></div>`
        : `<div class="field"><label>领域/风格预设</label><select name="style" ${imageDisabled}><option value="auto">智能匹配</option><option value="portrait" ${p.style === "portrait" ? "selected" : ""}>人像摄影</option><option value="food" ${p.style === "food" ? "selected" : ""}>美食摄影</option><option value="landscape" ${p.style === "landscape" ? "selected" : ""}>风景与建筑</option><option value="product" ${p.style === "product" ? "selected" : ""}>产品与包装</option><option value="poster" ${p.style === "poster" ? "selected" : ""}>海报与文字</option></select></div><details class="advanced-disclosure"><summary>Krea 2 风格 LoRA</summary><div class="field-row"><div class="field"><label>风格扩展</label><select name="style_lora" ${imageDisabled}>${[["none","不使用"],["darkbrush","水墨笔触"],["dotmatrix","点阵版画"],["kidsdrawing","童趣手绘"],["neondrip","霓虹抽象"],["rainywindow","雨窗氛围"],["retroanime","复古动漫"],["softwatercolor","柔和水彩"],["sunsetblur","夕阳动感模糊"],["vintagetarot","复古塔罗"]].map(([value,label])=>`<option value="${value}" ${p.style_lora === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label>LoRA 强度</label><input name="lora_strength" type="number" min="0" max="2" step=".05" value="${Number(p.lora_strength ?? 1)}" ${imageDisabled}></div></div></details>`;
    return `<div class="inline-editor"><p class="eyebrow">${title}</p><p class="editor-note">${sourceNote}</p>
      <div class="model-readiness">${runtimeReady ? "本地图像模型已通过真实生成验收；2048 规格仍为实验级。" : imageProvider?.weights_ready ? "模型文件已发现，正在进行运行验收。" : "模型尚未下载；可先配置节点，下载完成后启用生成。"}</div>
      <form class="node-form" data-form-node="${node.id}">
        <div class="field"><label>图像模型</label><select name="model_id" ${busy ? "disabled" : ""}>${modelOptions("image", p.model_id, capability)}</select></div>
        <div class="field"><label>${node.kind === "image_edit" ? "编辑指令" : "画面提示词"} *</label><textarea name="prompt" required ${busy ? "disabled" : ""}>${esc(p.prompt || "")}</textarea>${promptTools(p)}</div>
        ${extra}
        <div class="field-row"><div class="field"><label>宽度</label><select name="width" ${imageDisabled}>${[1024,1536,2048].map((v) => `<option value="${v}" ${Number(p.width) === v ? "selected" : ""}>${v}${v === 2048 ? " · 实验" : ""}</option>`).join("")}</select></div><div class="field"><label>高度</label><select name="height" ${imageDisabled}>${[1024,1536,2048].map((v) => `<option value="${v}" ${Number(p.height) === v ? "selected" : ""}>${v}${v === 2048 ? " · 实验" : ""}</option>`).join("")}</select></div></div>
        <div class="field"><label>Seed</label><input name="seed" type="number" value="${Number.isFinite(Number(p.seed)) ? Number(p.seed) : 7}" ${imageDisabled}></div>
        <div class="form-actions"><button class="primary" type="submit" ${imageDisabled}>${icon("i-play")}${runtimeReady ? submitLabel : "模型验收后启用生成"}</button></div>
      </form></div>`;
  }
  if (node.kind === "tts") return `<div class="inline-editor"><p class="eyebrow">VOICE CLONE</p><form class="node-form" data-form-node="${node.id}"><div class="field"><label>对白文本 *</label><textarea name="text" required ${disabled}>${esc(p.text || "")}</textarea></div><div class="field-row"><div class="field"><label>语言</label><select name="language" ${disabled}>${["ZH","EN","JA","ES","AR"].map((v) => `<option ${p.language === v ? "selected" : ""}>${v}</option>`).join("")}</select></div><div class="field"><label>Seed</label><input name="seed" type="number" value="${Number(p.seed || 7)}" ${disabled}></div></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form></div>`;
  if (node.kind === "dialogue") return `<div class="inline-editor"><p class="eyebrow">DIALOGUE SEQUENCE</p><form class="node-form" data-form-node="${node.id}"><p class="editor-note">按连接顺序合并 2–6 段不同角色对白，再将输出连接到 H3 的“对白驱动”输入。</p><div class="field"><label>段落间隔（秒）</label><input name="gap_seconds" type="number" min="0" max="5" step="0.05" value="${Number(p.gap_seconds ?? .35)}" ${disabled}></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form></div>`;
  if (node.kind === "music") return `<div class="inline-editor"><p class="eyebrow">MUSIC 3</p><form class="node-form" data-form-node="${node.id}"><div class="field"><label>音乐描述 *</label><textarea name="prompt" required ${disabled}>${esc(p.prompt || "")}</textarea>${promptTools(p)}</div><div class="field"><label>歌词或结构 *</label><textarea name="lyrics" required ${disabled}>${esc(p.lyrics || "[Instrumental]")}</textarea></div><div class="field-row"><div class="field"><label>时长（秒）</label><input name="duration" type="number" min="5" max="240" value="${Number(p.duration_seconds || 10)}" ${disabled}></div><div class="field"><label>Seed</label><input name="seed" type="number" value="${Number(p.seed || 7)}" ${disabled}></div></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form></div>`;
  if (node.kind === "agent") return `<div class="inline-editor"><p class="eyebrow">LOCAL AGENT</p><form class="node-form" data-form-node="${node.id}"><div class="field"><label>本地 LLM</label><select name="prompt_model" ${disabled}>${modelOptions("prompt", p.prompt_model || "qwen3.6-27b-q4")}</select></div><div class="field"><label>交给制作 Agent 的任务 *</label><textarea name="prompt" required ${disabled}>${esc(p.prompt || "")}</textarea></div><div class="field-row"><div class="field"><label>最长输出</label><input name="max_tokens" type="number" min="32" max="4096" value="${Number(p.max_tokens || 512)}" ${disabled}></div><div class="field"><label>推理模式</label><select name="reasoning" ${disabled}><option value="false" ${!p.reasoning ? "selected" : ""}>快速</option><option value="true" ${p.reasoning ? "selected" : ""}>深度</option></select></div></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form></div>`;
  if (node.kind === "note") return `<div class="inline-editor"><form class="node-form" data-form-node="${node.id}"><div class="field"><label>便笺内容</label><textarea name="text" rows="8">${esc(node.text || "")}</textarea></div><div class="form-actions"><button class="primary" type="submit">保存便笺</button></div></form></div>`;
  return "";
}

function reviewButton(job) {
  if (!job || job.status !== "succeeded" || job.params?.profile === "quality" || job.preview_job_id) return "";
  return `<button type="button" class="secondary review-job" data-job-id="${job.id}">${icon("i-review")}${job.approval_status === "approved" ? "撤销审批" : "审批通过"}</button>`;
}

function renderWorld() {
  const world = $("#world");
  const groupHtml = state.groups.map((group) => `<section class="canvas-group ${group.id === state.selectedGroupId ? "selected" : ""}" data-group-id="${group.id}"><button class="group-header" data-group-drag="${group.id}">${icon("i-group")}<span>${esc(group.title)}</span></button></section>`).join("");
  const nodeHtml = state.nodes.map((node) => {
    const job = getJob(node); const asset = node.assetId ? state.assets.find((item) => item.id === node.assetId) : null;
    const selected = state.selectedIds.includes(node.id); const visualStatus = job?.status || (node.kind === "asset" ? "succeeded" : "draft");
    const meta = kindMeta[node.kind] || kindMeta.note; const modeLabel = node.kind === "video" ? videoModes[node.params?.mode || "t2v"].short : outputType(node).toUpperCase();
    return `<article class="node ${selected ? (state.selectedIds.length > 1 ? "multi-selected" : "selected") : ""} ${node.expanded ? "expanded" : ""}" data-node-id="${node.id}" style="transform:translate(${Number(node.x)||0}px,${Number(node.y)||0}px)">
      <header class="node-header"><span>${icon(meta.icon)}</span><button class="node-title-button" data-select-node="${node.id}"><span>${esc(node.title || meta.title)}</span></button><span class="status-badge ${visualStatus}">${statusText[visualStatus] || "草稿"}</span><div class="node-header-actions"><button class="node-action" data-expand-node="${node.id}" aria-label="${node.expanded ? "收起" : "展开"}节点">${icon("i-chevron")}</button><button class="node-action" data-rename-node="${node.id}" aria-label="重命名">${icon("i-rename")}</button><button class="node-action danger" data-delete-node="${node.id}" aria-label="删除节点">${icon("i-trash")}</button></div></header>
      <div class="node-body">${portsHtml(node)}${nodeMedia(node, job, asset)}${deriveActions(node, asset)}${nodeEditor(node, job)}</div>
      <footer class="node-footer"><span>${esc(modeLabel)}${job?.approval_status === "approved" ? " · 已审批" : ""}</span><span>${job ? `${Math.round(job.progress*100)}%` : ""}</span></footer>
      <button class="port-handle output-port" data-output-node="${node.id}" data-output-type="${outputType(node)}" aria-label="从${esc(node.title)}连接输出"></button>
    </article>`;
  }).join("");
  world.innerHTML = `${groupHtml}<svg id="connections" class="connections" aria-hidden="true"><defs><linearGradient id="edge-gradient"><stop offset="0" stop-color="#ef4fa6"/><stop offset=".55" stop-color="#a855f7"/><stop offset="1" stop-color="#2997ff"/></linearGradient></defs><g id="edge-layer"></g><path id="edge-draft" class="edge-draft" d="" hidden/></svg>${nodeHtml}`;
  bindWorldEvents(); hydrateMedia(world);
  requestAnimationFrame(() => { updateGroupBounds(); renderConnections(); });
}

function bindWorldEvents() {
  $$("[data-select-node]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); selectNode(button.dataset.selectNode, event.shiftKey); }));
  $$(".node-header").forEach((header) => header.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") || event.target.closest(".status-badge")) return;
    startNodeDrag(event, header.closest(".node").dataset.nodeId);
  }));
  $$("[data-expand-node]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); const node=findNode(button.dataset.expandNode); node.expanded=!node.expanded; selectNode(node.id,event.shiftKey,false); renderWorld(); scheduleSave(); }));
  $$("[data-rename-node]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); selectNode(button.dataset.renameNode,false,false); renameSelection(); }));
  $$("[data-delete-node]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); state.selectedIds=[button.dataset.deleteNode]; deleteSelection(); }));
  $$(".node-form").forEach((form) => form.addEventListener("submit", (event) => submitNode(event, findNode(form.dataset.formNode))));
  $$(".optimize-prompt").forEach((button) => button.addEventListener("click", () => optimizeNodePrompt(button)));
  $$("[data-video-mode]").forEach((button) => button.addEventListener("click", () => changeVideoMode(button.closest(".node").dataset.nodeId, button.dataset.videoMode)));
  $$(".review-job").forEach((button) => button.addEventListener("click", () => reviewJob(button.dataset.jobId)));
  $$("[data-disconnect]").forEach((button) => button.addEventListener("click", () => disconnectEdge(button.dataset.disconnect)));
  $$("[data-derive-from]").forEach((button) => button.addEventListener("click", () => deriveNode(button.dataset.deriveFrom, button.dataset.deriveKind, button.dataset.derivePort, button.dataset.deriveMode)));
  $$(".output-port").forEach((port) => port.addEventListener("pointerdown", (event) => startConnection(event, port.dataset.outputNode, port.dataset.outputType)));
  $$("[data-group-drag]").forEach((header) => {
    header.addEventListener("click", (event) => { event.stopPropagation(); state.selectedGroupId=header.dataset.groupDrag; state.selectedIds=[]; renderSelectionToolbar(); renderWorld(); });
    header.addEventListener("pointerdown", (event) => startGroupDrag(event, header.dataset.groupDrag));
  });
}

function findNode(id) { return state.nodes.find((node) => node.id === id); }

function deriveNode(sourceId, kind, port, mode = "") {
  const source = findNode(sourceId); if (!source || !kindMeta[kind]) return;
  pushHistory();
  const siblings = state.edges.filter((edge) => edge.from === sourceId).length;
  const params = defaultParams(kind);
  if (kind === "video" && mode) params.mode = mode;
  const node = {
    id: crypto.randomUUID(), kind,
    x: source.x + (source.expanded ? 540 : 500),
    y: source.y + siblings * 96,
    title: kindMeta[kind].title, params, expanded: true,
  };
  state.nodes.push(node);
  state.edges.push({ id: crypto.randomUUID(), from: sourceId, to: node.id, port, output: outputType(source) });
  state.selectedIds = [node.id]; state.selectedGroupId = null;
  renderAll(); centerNode(node); scheduleSave();
  toast(`已创建“${node.title}”并连接输入。`);
}

function selectNode(id, additive = false, expand = true) {
  const node = findNode(id); if (!node) return;
  if (additive) state.selectedIds = state.selectedIds.includes(id) ? state.selectedIds.filter((value) => value !== id) : [...state.selectedIds, id];
  else state.selectedIds = [id];
  state.selectedGroupId = null;
  if (expand && state.selectedIds.length === 1) node.expanded = true;
  renderWorld(); renderSelectionToolbar(); scheduleSave();
}

function startNodeDrag(event, nodeId) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  if (!state.selectedIds.includes(nodeId)) { state.selectedIds = event.shiftKey ? [...state.selectedIds, nodeId] : [nodeId]; state.selectedGroupId = null; }
  pushHistory();
  const selected = state.nodes.filter((node) => state.selectedIds.includes(node.id));
  const origins = new Map(selected.map((node) => [node.id, { x: node.x, y: node.y }])); const sx=event.clientX, sy=event.clientY;
  const move = (e) => { for (const node of selected) { const o=origins.get(node.id); node.x=o.x+(e.clientX-sx)/state.viewport.zoom; node.y=o.y+(e.clientY-sy)/state.viewport.zoom; const el=$(`[data-node-id="${node.id}"]`); if(el)el.style.transform=`translate(${node.x}px,${node.y}px)`; } updateGroupBounds(); renderConnections(); };
  const end = () => { removeEventListener("pointermove",move); removeEventListener("pointerup",end); renderSelectionToolbar(); scheduleSave(); };
  addEventListener("pointermove",move); addEventListener("pointerup",end,{once:true});
}

function startGroupDrag(event, groupId) {
  if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
  const group=state.groups.find((item)=>item.id===groupId); if(!group)return; state.selectedGroupId=groupId;state.selectedIds=[];pushHistory();
  const nodes=state.nodes.filter((node)=>group.nodeIds.includes(node.id)); const origins=new Map(nodes.map((node)=>[node.id,{x:node.x,y:node.y}])); const sx=event.clientX,sy=event.clientY;
  const move=(e)=>{for(const node of nodes){const o=origins.get(node.id);node.x=o.x+(e.clientX-sx)/state.viewport.zoom;node.y=o.y+(e.clientY-sy)/state.viewport.zoom;const el=$(`[data-node-id="${node.id}"]`);if(el)el.style.transform=`translate(${node.x}px,${node.y}px)`;}updateGroupBounds();renderConnections();};
  const end=()=>{removeEventListener("pointermove",move);removeEventListener("pointerup",end);scheduleSave();renderSelectionToolbar();}; addEventListener("pointermove",move);addEventListener("pointerup",end,{once:true});
}

function updateGroupBounds() {
  for (const group of state.groups) {
    const elements=group.nodeIds.map((id)=>$(`[data-node-id="${id}"]`)).filter(Boolean); const groupEl=$(`[data-group-id="${group.id}"]`); if(!elements.length||!groupEl)continue;
    const xs=elements.map((el)=>findNode(el.dataset.nodeId).x), ys=elements.map((el)=>findNode(el.dataset.nodeId).y);
    const rights=elements.map((el)=>findNode(el.dataset.nodeId).x+el.offsetWidth), bottoms=elements.map((el)=>findNode(el.dataset.nodeId).y+el.offsetHeight);
    const x=Math.min(...xs)-28,y=Math.min(...ys)-28,w=Math.max(...rights)-Math.min(...xs)+56,h=Math.max(...bottoms)-Math.min(...ys)+56;
    Object.assign(groupEl.style,{transform:`translate(${x}px,${y}px)`,width:`${w}px`,height:`${h}px`});
  }
}

function renderConnections() {
  const layer=$("#edge-layer"), world=$("#world"); if(!layer||!world)return; const wr=world.getBoundingClientRect(),z=state.viewport.zoom;
  layer.innerHTML=state.edges.map((edge)=>{const out=$(`[data-output-node="${edge.from}"]`),input=$(`[data-input-node="${edge.to}"][data-port="${edge.port}"]`);if(!out||!input)return"";const a=out.getBoundingClientRect(),b=input.getBoundingClientRect();const x1=(a.left+a.width/2-wr.left)/z,y1=(a.top+a.height/2-wr.top)/z,x2=(b.left+b.width/2-wr.left)/z,y2=(b.top+b.height/2-wr.top)/z;const bend=Math.max(70,Math.abs(x2-x1)*.46);const d=`M${x1},${y1} C${x1+bend},${y1} ${x2-bend},${y2} ${x2},${y2}`;return `<path class="edge-path" d="${d}"/><text class="edge-label" x="${(x1+x2)/2}" y="${(y1+y2)/2-6}" text-anchor="middle">${esc(portLabel(edge.to,edge.port))}</text>`;}).join("");
}

function portLabel(nodeId, key) { return inputPorts(findNode(nodeId)).find((port)=>port.key===key)?.label || key; }
function typeMatches(output, accepts) { return accepts === "any" || output === accepts || output === "any"; }

function startConnection(event, from, output) {
  if(event.button!==0)return;event.preventDefault();event.stopPropagation(); state.connecting={from,output}; const draft=$("#edge-draft"); draft.hidden=false;
  const draw=(e)=>{const out=$(`[data-output-node="${from}"]`),world=$("#world");if(!out||!world)return;const wr=world.getBoundingClientRect(),a=out.getBoundingClientRect(),z=state.viewport.zoom;const x1=(a.left+a.width/2-wr.left)/z,y1=(a.top+a.height/2-wr.top)/z,x2=(e.clientX-wr.left)/z,y2=(e.clientY-wr.top)/z,b=Math.max(70,Math.abs(x2-x1)*.45);draft.setAttribute("d",`M${x1},${y1} C${x1+b},${y1} ${x2-b},${y2} ${x2},${y2}`);};
  const end=(e)=>{removeEventListener("pointermove",draw);removeEventListener("pointerup",end);draft.hidden=true;const target=e.target.closest?.(".input-port");if(target){const accepts=target.dataset.accepts;if(!typeMatches(output,accepts)){toast(`类型不匹配：${output} 不能连接到 ${accepts} 输入。`);return;}pushHistory();state.edges=state.edges.filter((edge)=>!(edge.to===target.dataset.inputNode&&edge.port===target.dataset.port));state.edges.push({id:crypto.randomUUID(),from,to:target.dataset.inputNode,port:target.dataset.port,output});renderWorld();scheduleSave();toast("输入关系已连接。");}state.connecting=null;};
  addEventListener("pointermove",draw);addEventListener("pointerup",end,{once:true});
}

function disconnectEdge(id) { pushHistory();state.edges=state.edges.filter((edge)=>edge.id!==id);renderWorld();scheduleSave();toast("已断开输入连接。"); }

function createGroup() {
  if(state.selectedIds.length<2){toast("请先按 Shift 选择至少两个节点。");return;}pushHistory();const id=crypto.randomUUID();state.groups.push({id,title:`镜头组 ${state.groups.length+1}`,nodeIds:[...state.selectedIds]});state.selectedGroupId=id;state.selectedIds=[];renderAll();scheduleSave();toast("节点已组合。Ctrl+Shift+G 可解组。");
}

function ungroupSelection() {
  let ids=[];if(state.selectedGroupId)ids=[state.selectedGroupId];else ids=state.groups.filter((g)=>g.nodeIds.some((id)=>state.selectedIds.includes(id))).map((g)=>g.id);if(!ids.length){toast("当前选择不在组合中。");return;}pushHistory();state.groups=state.groups.filter((g)=>!ids.includes(g.id));state.selectedGroupId=null;renderAll();scheduleSave();toast("已解组，节点和连线保持不变。");
}

function renameSelection() {
  if(state.selectedGroupId){const group=state.groups.find((g)=>g.id===state.selectedGroupId);const value=prompt("组合名称",group.title);if(value?.trim()){pushHistory();group.title=value.trim();renderWorld();scheduleSave();}return;}
  if(state.selectedIds.length!==1){toast("请选择一个节点或一个组合后重命名。");return;}const node=findNode(state.selectedIds[0]);const value=prompt("节点名称",node.title);if(value?.trim()){pushHistory();node.title=value.trim();renderWorld();scheduleSave();}
}

function deleteSelection() {
  if(state.selectedGroupId&&!state.selectedIds.length){pushHistory();state.groups=state.groups.filter((g)=>g.id!==state.selectedGroupId);state.selectedGroupId=null;renderAll();scheduleSave();toast("组合框已删除，节点仍保留。Ctrl+Z 可撤销。");return;}
  if(!state.selectedIds.length){toast("请先选择要删除的节点。");return;}pushHistory();const ids=new Set(state.selectedIds);state.nodes=state.nodes.filter((node)=>!ids.has(node.id));state.edges=state.edges.filter((edge)=>!ids.has(edge.from)&&!ids.has(edge.to));state.groups=state.groups.map((g)=>({...g,nodeIds:g.nodeIds.filter((id)=>!ids.has(id))})).filter((g)=>g.nodeIds.length>1);state.selectedIds=[];renderAll();scheduleSave();toast("节点及相关连线已删除。Ctrl+Z 可撤销。");
}

function renderSelectionToolbar() {
  const toolbar=$("#selection-toolbar");const count=state.selectedIds.length;toolbar.hidden=!count&&!state.selectedGroupId;$("#group-selection").disabled=count<2;$("#ungroup-selection").disabled=!state.selectedGroupId&&!state.groups.some((g)=>g.nodeIds.some((id)=>state.selectedIds.includes(id)));$("#rename-selection").disabled=!(state.selectedGroupId||count===1);
}

function changeVideoMode(nodeId, mode) { const node=findNode(nodeId);if(!node)return;pushHistory();node.params={...defaultParams("video"),...node.params,mode,profile:mode==="reference"?"preview4":node.params?.profile||"preview8"};state.edges=state.edges.filter((edge)=>edge.to!==nodeId||inputPorts(node).some((port)=>port.key===edge.port));renderWorld();scheduleSave(); }

function connectedAssetPath(node, port) {
  const edge=edgeFor(node.id,port);const source=sourceNode(edge);if(!source)return null;const assetId=source.assetId||(source.jobId?state.assets.find((a)=>a.origin_job_id===source.jobId)?.id:null);return state.assets.find((asset)=>asset.id===assetId)?.source_path||null;
}

function promptWorkflowName(node) {
  return ({ video: "MiniMax H3 视频生成", image_t2i: "高质量文生图", image_i2i: "图生图", image_edit: "图片编辑", music: "本地音乐生成" })[node.kind] || "AIGC 内容生成";
}

function promptOptimizationInstruction(node, rawPrompt) {
  return `你是“擎光绘影”平台的提示词优化器。请在不改变用户主体、人物身份、数量、品牌词、对白内容和明确限制的前提下，为“${promptWorkflowName(node)}”优化提示词。补足主体、环境、构图、镜头、光线、材质、色彩、动作和质量信息；没有依据的专有名词不要添加。图片编辑只描述需要改变的内容，并明确应保持不变的部分。输出只能是可直接交给生成模型的最终提示词，不要解释、不要标题、不要 Markdown。\n\n用户原始提示词：\n${rawPrompt}`;
}

async function optimizeNodePrompt(button) {
  const form = button.closest("form"); const node = findNode(form?.dataset.formNode); const field = form?.elements.prompt;
  if (!node || !field || !field.value.trim()) { toast("请先填写需要优化的提示词。"); return; }
  const modelId = form.elements.prompt_model?.value || "qwen3.6-27b-q4";
  const model = catalogModels("prompt").find((item) => item.id === modelId);
  if (!model?.ready) { toast(`${model?.label || "所选模型"}尚未完成本地推理接入，请先选择可用模型。`, 5200); return; }
  button.disabled = true; const originalLabel = button.innerHTML; button.textContent = "优化中…";
  try {
    const job = await api("/v1/jobs", { method: "POST", body: JSON.stringify({ type: "agent.chat", params: { prompt: promptOptimizationInstruction(node, field.value.trim()), model_id: modelId, max_tokens: 900, context: 8192, temperature: .2, reasoning: false }, priority: 80, project_id: state.projectId }) });
    state.jobs.unshift(job); renderJobs();
    let result = job;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await api(`/v1/jobs/${job.id}`);
      if (["succeeded", "failed", "cancelled"].includes(result.status)) break;
    }
    if (result.status !== "succeeded" || !result.result?.text) throw new Error(result.error || "提示词优化未在规定时间内完成");
    pushHistory(); node.params = { ...(node.params || {}), prompt: result.result.text.trim(), prompt_model: modelId };
    renderWorld(); scheduleSave(); toast("提示词已由本地模型优化，可继续修改。", 4800);
  } catch (error) {
    button.disabled = false; button.innerHTML = originalLabel; toast(`提示词优化失败：${error.message}`, 6000);
  }
}

async function submitNode(event,node) {
  event.preventDefault();const form=event.currentTarget;if(node.kind==="note"){pushHistory();node.text=form.elements.text.value.trim();renderWorld();scheduleSave();toast("便笺已保存。");return;}
  let type,params;const value=(name)=>form.elements[name]?.value;
  if(node.kind==="video"){
    type="h3.t2v";const mode=node.params?.mode||"t2v";params={mode,prompt:value("prompt").trim(),prompt_model:value("prompt_model"),width:Number(value("width")),height:Number(value("height")),duration_seconds:Number(value("duration")),seed:Number(value("seed")),profile:value("profile"),ref_image_size:value("ref_image_size")};
    if(mode==="i2v"||mode==="fl2v"||mode==="audio_drive")params.first_frame=connectedAssetPath(node,"first_frame");
    if(mode==="fl2v")params.last_frame=connectedAssetPath(node,"last_frame");
    if(mode==="reference"){params.reference_images=[1,2,3].map((i)=>connectedAssetPath(node,`reference_image_${i}`)).filter(Boolean);params.reference_videos=[connectedAssetPath(node,"reference_video_1")].filter(Boolean);params.reference_audios=[connectedAssetPath(node,"reference_audio_1")].filter(Boolean);}
    if(mode==="audio_drive")params.guide_audio=connectedAssetPath(node,"guide_audio");
  } else if(node.kind==="image_t2i") { type="image.t2i";params={model_id:value("model_id"),prompt:value("prompt").trim(),prompt_model:value("prompt_model"),width:Number(value("width")),height:Number(value("height")),seed:Number(value("seed")),style:value("style"),style_lora:value("style_lora")||"none",lora_strength:Number(value("lora_strength")||1)}; }
  else if(node.kind==="image_i2i") { type="image.i2i";params={model_id:value("model_id"),prompt:value("prompt").trim(),prompt_model:value("prompt_model"),source_image:connectedAssetPath(node,"source_image"),style_image:connectedAssetPath(node,"style_image"),strength:Number(value("strength")),width:Number(value("width")),height:Number(value("height")),seed:Number(value("seed"))}; }
  else if(node.kind==="image_edit") { type="image.edit";params={model_id:value("model_id"),prompt:value("prompt").trim(),prompt_model:value("prompt_model"),source_image:connectedAssetPath(node,"source_image"),reference_image:connectedAssetPath(node,"reference_image"),mask_image:connectedAssetPath(node,"mask_image"),edit_mode:value("edit_mode"),preservation:Number(value("preservation")),width:Number(value("width")),height:Number(value("height")),seed:Number(value("seed"))}; }
  else if(node.kind==="tts") { type="tts.clone";params={reference_audio:connectedAssetPath(node,"reference_audio"),text:value("text").trim(),language:value("language"),seed:Number(value("seed")),duration_factor:1}; }
  else if(node.kind==="dialogue") { type="audio.sequence";params={inputs:Array.from({length:6},(_,index)=>connectedAssetPath(node,`voice_${index+1}`)).filter(Boolean),gap_seconds:Number(value("gap_seconds"))}; }
  else if(node.kind==="music") { type="music.generate";params={prompt:value("prompt").trim(),prompt_model:value("prompt_model"),lyrics:value("lyrics").trim(),duration_seconds:Number(value("duration")),seed:Number(value("seed"))}; }
  else if(node.kind==="agent") { type="agent.chat";params={prompt:value("prompt").trim(),model_id:value("prompt_model"),max_tokens:Number(value("max_tokens")),context:8192,temperature:.2,reasoning:value("reasoning")==="true"}; }
  if(type==="agent.chat") { const selected=catalogModels("prompt").find((item)=>item.id===params.model_id);if(!selected?.ready){toast("所选本地 LLM 尚未完成推理接入。");return;} }
  const button=$("button[type=submit]",form);button.disabled=true;
  try{const job=await api("/v1/jobs",{method:"POST",body:JSON.stringify({type,params,priority:type==="h3.t2v"?100:120,project_id:state.projectId})});pushHistory();node.params=params;node.jobId=job.id;node.assetId=null;state.jobs.unshift(job);renderAll();scheduleSave();toast("任务已进入本地 GPU 队列。");}
  catch(error){button.disabled=false;toast(`提交失败：${error.message}`,6000);}
}

async function reviewJob(id) { const job=state.jobs.find((item)=>item.id===id);if(!job)return;try{const target=job.approval_status==="approved"?"pending":"approved";await api(`/v1/jobs/${id}/approval`,{method:"POST",body:JSON.stringify({status:target})});toast(target==="approved"?"预览已审批，可统一进入复现终稿队列。":"已撤销审批。");await refreshJobs(true);}catch(error){toast(`审批失败：${error.message}`);} }

function jobsSignature(jobs){return jobs.map((j)=>`${j.id}:${j.status}:${j.stage}:${Math.round((j.progress||0)*100)}:${j.approval_status}:${j.final_job_id||""}`).join("|");}
async function refreshJobs(force=false){try{const jobs=await api(`/v1/jobs?project_id=${encodeURIComponent(state.projectId)}&limit=120`);const changed=jobsSignature(jobs)!==jobsSignature(state.jobs);const oldTerminal=new Set(state.jobs.filter((j)=>["succeeded","failed","cancelled"].includes(j.status)).map((j)=>j.id));const newlyDone=jobs.some((j)=>["succeeded","failed"].includes(j.status)&&!oldTerminal.has(j.id));state.jobs=jobs;if(newlyDone||force){state.assets=await api(`/v1/assets?project_id=${encodeURIComponent(state.projectId)}&limit=300`);attachGeneratedAssets();renderAssets();}if(changed||force){renderWorld();renderJobs();}}catch(error){console.warn("Job refresh failed",error);}}

function renderJobs(){const active=state.jobs.filter((j)=>["queued","running"].includes(j.status));$("#queue-summary").textContent=active.length?`${active.filter((j)=>j.status==="running").length} 运行 · ${active.filter((j)=>j.status==="queued").length} 等待`:"空闲";const visible=[...active,...state.jobs.filter((j)=>!active.includes(j))].slice(0,14);$("#job-list").innerHTML=visible.length?visible.map((j)=>`<button class="job-card" data-job-id="${j.id}"><strong>${esc(jobTypeText[j.type]||j.type)}</strong><span class="status-badge ${j.status}">${statusText[j.status]||j.status}</span><span>${esc(statusText[j.stage]||j.stage||"")}</span><span>${Math.round(j.progress*100)}%</span><div class="progress-line"><i style="width:${Math.round(j.progress*100)}%"></i></div></button>`).join(""):`<div class="empty-state">暂无任务。</div>`;$$('.job-card').forEach((card)=>card.addEventListener("click",()=>{const node=state.nodes.find((n)=>n.jobId===card.dataset.jobId);if(node){selectNode(node.id,false,false);centerNode(node);}}));}

function renderAssets(){const list=$("#asset-list");list.innerHTML=state.assets.length?state.assets.map((asset)=>`<button class="asset-card" data-asset-id="${asset.id}"><span class="asset-thumb" data-thumb-id="${asset.id}">${icon((asset.media_type||"").startsWith("video/")?"i-video":(asset.media_type||"").startsWith("audio/")?"i-voice":"i-asset")}</span><span class="asset-meta"><strong>${esc(asset.name)}</strong><span>${esc(outputType({kind:"asset",assetId:asset.id}))} · ${formatBytes(asset.size_bytes)}</span></span></button>`).join(""):`<div class="empty-state">导入素材后，它们会作为可连线资产节点出现在这里。</div>`;$$('.asset-card',list).forEach((card)=>card.addEventListener("click",()=>addAssetNode(card.dataset.assetId)));hydrateAssetThumbs(list);}

async function assetUrl(id){if(state.objectUrls.has(id))return state.objectUrls.get(id);const playback=await api(`/v1/assets/${id}/playback`);state.objectUrls.set(id,playback.url);return playback.url;}
async function hydrateMedia(root){for(const el of $$('[data-asset-id]',root)){try{el.src=await assetUrl(el.dataset.assetId);}catch{el.replaceWith(document.createTextNode("资产预览加载失败"));}}}
async function hydrateAssetThumbs(root){for(const thumb of $$('[data-thumb-id]',root)){const asset=state.assets.find((a)=>a.id===thumb.dataset.thumbId);if(!(asset?.media_type||"").startsWith("image/"))continue;try{const url=await assetUrl(asset.id);thumb.innerHTML=`<img src="${url}" loading="lazy" alt="${esc(asset.name)}">`;}catch{/* icon fallback */}}}

function addNode(kind){pushHistory();const rect=$("#canvas").getBoundingClientRect();const node={id:crypto.randomUUID(),kind,x:(rect.width/2-state.viewport.x)/state.viewport.zoom-210,y:(rect.height/2-state.viewport.y)/state.viewport.zoom-100,title:kindMeta[kind].title,params:defaultParams(kind),expanded:true};state.nodes.push(node);state.selectedIds=[node.id];state.selectedGroupId=null;renderAll();scheduleSave();}
function addAssetNodes(assetIds, point = null) {
  const assets=assetIds.map((id)=>state.assets.find((asset)=>asset.id===id)).filter(Boolean);if(!assets.length)return;
  pushHistory();const rect=$("#canvas").getBoundingClientRect();const origin=point||{x:(rect.width/2-state.viewport.x)/state.viewport.zoom-210,y:(rect.height/2-state.viewport.y)/state.viewport.zoom-90};
  const created=assets.map((asset,index)=>({id:crypto.randomUUID(),kind:"asset",assetId:asset.id,x:origin.x+index*34,y:origin.y+index*34,title:asset.name,params:{},expanded:false}));
  state.nodes.push(...created);state.selectedIds=created.map((node)=>node.id);state.selectedGroupId=null;renderAll();scheduleSave();
}
function addAssetNode(assetId){addAssetNodes([assetId]);$("#asset-panel").hidden=true;}

function scheduleSave(){
  clearTimeout(state.saveTimer);
  const projectId=state.projectId;
  state.saveTimer=setTimeout(async()=>{
    if(projectId!==state.projectId)return;
    try{await api(`/v1/projects/${encodeURIComponent(projectId)}/canvas`,{method:"PUT",body:JSON.stringify({state:{nodes:state.nodes,edges:state.edges,groups:state.groups,viewport:state.viewport}})});}
    catch(error){toast(`画布自动保存失败：${error.message}`,6000);}
  },650);
}
function applyViewport(){state.viewport.zoom=Math.min(2.2,Math.max(.25,Number(state.viewport.zoom)||1));$("#world").style.transform=`translate(${state.viewport.x}px,${state.viewport.y}px) scale(${state.viewport.zoom})`;$("#zoom-value").textContent=`${Math.round(state.viewport.zoom*100)}%`;}
function zoomTo(next,x,y){const rect=$("#canvas").getBoundingClientRect(),px=(x??rect.left+rect.width/2)-rect.left,py=(y??rect.top+rect.height/2)-rect.top,wx=(px-state.viewport.x)/state.viewport.zoom,wy=(py-state.viewport.y)/state.viewport.zoom;state.viewport.zoom=Math.min(2.2,Math.max(.25,next));state.viewport.x=px-wx*state.viewport.zoom;state.viewport.y=py-wy*state.viewport.zoom;applyViewport();scheduleSave();}
function centerNode(node){const rect=$("#canvas").getBoundingClientRect();state.viewport.x=rect.width/2-(node.x+210)*state.viewport.zoom;state.viewport.y=rect.height/2-(node.y+120)*state.viewport.zoom;applyViewport();scheduleSave();}
function fitView(){if(!state.nodes.length)return;const minX=Math.min(...state.nodes.map((n)=>n.x)),minY=Math.min(...state.nodes.map((n)=>n.y)),maxX=Math.max(...state.nodes.map((n)=>n.x+460)),maxY=Math.max(...state.nodes.map((n)=>n.y+(n.expanded?620:220))),rect=$("#canvas").getBoundingClientRect(),z=Math.min(1.1,Math.max(.25,Math.min((rect.width-100)/(maxX-minX),(rect.height-100)/(maxY-minY))));state.viewport.zoom=z;state.viewport.x=(rect.width-(maxX-minX)*z)/2-minX*z;state.viewport.y=(rect.height-(maxY-minY)*z)/2-minY*z;applyViewport();scheduleSave();}

async function uploadFiles(files, dropPoint = null){const uploaded=[];for(const file of files){const form=new FormData();form.append("project_id",state.projectId);form.append("kind","reference");form.append("file",file);toast(`正在导入：${file.name}`);uploaded.push(await api("/v1/assets/upload",{method:"POST",body:form}));}state.assets=await api(`/v1/assets?project_id=${encodeURIComponent(state.projectId)}&limit=300`);renderAssets();if(dropPoint){addAssetNodes(uploaded.map((asset)=>asset.id),dropPoint);toast(`已导入 ${files.length} 个素材并创建画布节点。`);}else{$("#asset-panel").hidden=false;toast(`已导入 ${files.length} 个素材。点击素材即可放入画布并连线。`);}}
async function batchFinals(){const approved=state.jobs.filter((j)=>j.type==="h3.t2v"&&j.approval_status==="approved"&&!j.final_job_id);if(!approved.length){toast("没有等待入终稿队列的已审批预览。");return;}const button=$("#batch-final");button.disabled=true;try{const result=await api("/v1/finals/batch",{method:"POST",body:JSON.stringify({preview_job_ids:approved.map((j)=>j.id),mode:"reproduce",steps:20,priority:200})});state.jobs.unshift(...result.created);renderJobs();toast(`已加入 ${result.created.length} 个复现终稿。`);}catch(error){toast(`终稿排队失败：${error.message}`,6000);}finally{button.disabled=false;}}

function formatBytes(bytes){const v=Number(bytes)||0;if(v<1024)return`${v} B`;if(v<1024**2)return`${(v/1024).toFixed(1)} KB`;if(v<1024**3)return`${(v/1024**2).toFixed(1)} MB`;return`${(v/1024**3).toFixed(1)} GB`;}

$("#login-form").addEventListener("submit",async(e)=>{e.preventDefault();const key=$("#access-key").value.trim();if(!key)return;try{await authenticate(key);}catch(error){showLogin(`登录失败：${error.message}`);}});
$("#project-select").addEventListener("change",async(e)=>{clearTimeout(state.saveTimer);state.projectId=e.target.value;await loadProject();});
$("#new-project").addEventListener("click",async()=>{const name=prompt("新项目名称");if(!name?.trim())return;const project=await api("/v1/projects",{method:"POST",body:JSON.stringify({name:name.trim()})});state.projects.unshift(project);state.projectId=project.id;renderProjects();await loadProject();});
$$('[data-add]').forEach((button)=>button.addEventListener("click",()=>addNode(button.dataset.add)));
$("#upload-button").addEventListener("click",()=>$("#file-input").click());
$("#file-input").addEventListener("change",async(e)=>{if(!e.target.files.length)return;try{await uploadFiles([...e.target.files]);}catch(error){toast(`导入失败：${error.message}`,6000);}e.target.value="";});
$("#toggle-assets").addEventListener("click",()=>{$("#asset-panel").hidden=!$("#asset-panel").hidden;});$("#close-assets").addEventListener("click",()=>{$("#asset-panel").hidden=true;});
$("#batch-final").addEventListener("click",batchFinals);$("#zoom-in").addEventListener("click",()=>zoomTo(state.viewport.zoom*1.15));$("#zoom-out").addEventListener("click",()=>zoomTo(state.viewport.zoom/1.15));$("#fit-view").addEventListener("click",fitView);
$("#rename-selection").addEventListener("click",renameSelection);$("#group-selection").addEventListener("click",createGroup);$("#ungroup-selection").addEventListener("click",ungroupSelection);$("#delete-selection").addEventListener("click",deleteSelection);
$("#canvas").addEventListener("wheel",(e)=>{e.preventDefault();zoomTo(state.viewport.zoom*(e.deltaY<0?1.1:.9),e.clientX,e.clientY);},{passive:false});
$("#canvas").addEventListener("dragover",(event)=>{if(!event.dataTransfer?.types?.includes("Files"))return;event.preventDefault();event.dataTransfer.dropEffect="copy";$("#canvas").classList.add("drop-ready");});
$("#canvas").addEventListener("dragleave",(event)=>{if(!event.currentTarget.contains(event.relatedTarget))$("#canvas").classList.remove("drop-ready");});
$("#canvas").addEventListener("drop",async(event)=>{event.preventDefault();$("#canvas").classList.remove("drop-ready");const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;const rect=$("#canvas").getBoundingClientRect();const point={x:(event.clientX-rect.left-state.viewport.x)/state.viewport.zoom-210,y:(event.clientY-rect.top-state.viewport.y)/state.viewport.zoom-90};try{await uploadFiles(files,point);}catch(error){toast(`导入失败：${error.message}`,6000);}});
$("#canvas").addEventListener("pointerdown",(event)=>{if(event.button!==0||event.target.closest(".node,.zoom-controls,.selection-toolbar,.canvas-group"))return;const canvas=$("#canvas");if(event.shiftKey){const box=document.createElement("div");box.className="selection-box";canvas.appendChild(box);const rect=canvas.getBoundingClientRect(),sx=event.clientX-rect.left,sy=event.clientY-rect.top;const move=(e)=>{const x=e.clientX-rect.left,y=e.clientY-rect.top;Object.assign(box.style,{left:`${Math.min(sx,x)}px`,top:`${Math.min(sy,y)}px`,width:`${Math.abs(x-sx)}px`,height:`${Math.abs(y-sy)}px`});};const end=()=>{removeEventListener("pointermove",move);removeEventListener("pointerup",end);const br=box.getBoundingClientRect();state.selectedIds=state.nodes.filter((n)=>{const el=$(`[data-node-id="${n.id}"]`);const r=el?.getBoundingClientRect();return r&&r.right>=br.left&&r.left<=br.right&&r.bottom>=br.top&&r.top<=br.bottom;}).map((n)=>n.id);box.remove();renderWorld();renderSelectionToolbar();};addEventListener("pointermove",move);addEventListener("pointerup",end,{once:true});return;}state.selectedIds=[];state.selectedGroupId=null;renderSelectionToolbar();canvas.classList.add("panning");const sx=event.clientX,sy=event.clientY,vx=state.viewport.x,vy=state.viewport.y;const move=(e)=>{state.viewport.x=vx+e.clientX-sx;state.viewport.y=vy+e.clientY-sy;applyViewport();};const end=()=>{canvas.classList.remove("panning");removeEventListener("pointermove",move);removeEventListener("pointerup",end);scheduleSave();};addEventListener("pointermove",move);addEventListener("pointerup",end,{once:true});});
addEventListener("keydown",(event)=>{if(event.target.matches("input,textarea,select"))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();undo();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="g"){event.preventDefault();event.shiftKey?ungroupSelection():createGroup();}else if(event.key==="Delete"||event.key==="Backspace"){event.preventDefault();deleteSelection();}else if(event.key==="F2"){event.preventDefault();renameSelection();}else if(event.key==="Escape"){state.selectedIds=[];state.selectedGroupId=null;renderWorld();renderSelectionToolbar();}});

attemptLocalAuth();
