const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  key: sessionStorage.getItem("h3-workbench-key") || "",
  projectId: localStorage.getItem("h3-project-id") || "default",
  projects: [],
  capabilities: null,
  jobs: [],
  assets: [],
  nodes: [],
  viewport: { x: 40, y: 30, zoom: 1 },
  selectedNodeId: null,
  objectUrls: new Map(),
  saveTimer: null,
  pollTimer: null,
};

const kindMeta = {
  video: { title: "H3 视频生成", icon: "i-video", copy: "创建可审批的快速预览，审批后统一进入终稿队列。" },
  tts: { title: "角色对白", icon: "i-voice", copy: "使用本地参考音频锁定角色音色。" },
  music: { title: "Music 3 配乐", icon: "i-music", copy: "生成本地配乐或歌曲草稿。" },
  agent: { title: "制作 Agent", icon: "i-agent", copy: "用本地 Qwen 辅助拆镜、改写提示词和整理制作计划。" },
  note: { title: "制作便笺", icon: "i-note", copy: "记录脚本、镜头意图和审批意见。" },
  asset: { title: "资产", icon: "i-asset", copy: "项目素材或生成结果。" },
};

const statusText = {
  queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消",
  pending: "待审批", approved: "已通过", rejected: "已驳回", not_required: "",
};

const jobTypeText = {
  "h3.t2v": "H3 视频", "tts.clone": "角色对白", "music.generate": "Music 3", "agent.chat": "制作 Agent", "system.noop": "队列测试",
};

function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function toast(message, timeout = 3600) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.clearTimeout(element._timer);
  element._timer = window.setTimeout(() => element.classList.remove("show"), timeout);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.key) headers.set("X-Workbench-Key", state.key);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
    } catch { /* response was not JSON */ }
    if (response.status === 401) showLogin("访问密钥无效，请重新输入。");
    throw new Error(detail);
  }
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response;
}

function showLogin(message = "请输入工作台访问密钥。") {
  $("#login").hidden = false;
  $("#app").hidden = true;
  $("#login-status").textContent = message;
}

async function authenticate(key) {
  state.key = key;
  await api("/v1/capabilities");
  sessionStorage.setItem("h3-workbench-key", key);
  $("#login").hidden = true;
  $("#app").hidden = false;
  await boot();
}

async function attemptLocalAuth() {
  if (state.key) {
    try { await authenticate(state.key); return; } catch { sessionStorage.removeItem("h3-workbench-key"); }
  }
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(location.hostname);
  if (!localHost) { showLogin("团队电脑请输入管理员提供的访问密钥。"); return; }
  try {
    const response = await fetch("/v1/local-auth");
    if (!response.ok) throw new Error("本机自动登录不可用");
    const payload = await response.json();
    await authenticate(payload.api_key);
  } catch (error) {
    showLogin(`自动登录失败：${error.message}`);
  }
}

async function boot() {
  window.clearInterval(state.pollTimer);
  [state.capabilities, state.projects] = await Promise.all([api("/v1/capabilities"), api("/v1/projects")]);
  if (!state.projects.some((project) => project.id === state.projectId)) state.projectId = state.projects[0]?.id || "default";
  renderCapabilities();
  renderProjects();
  await loadProject();
  state.pollTimer = window.setInterval(refreshJobs, 2200);
}

function renderCapabilities() {
  const providers = state.capabilities?.providers || {};
  const labels = { h3: "H3", tts: "TTS 2.5", music: "Music 3", agent: "Qwen" };
  $("#provider-status").innerHTML = Object.entries(labels).map(([key, label]) => `<span class="provider-chip ${providers[key]?.ready ? "ready" : ""}">${label}</span>`).join("");
}

function renderProjects() {
  $("#project-select").innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === state.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
}

async function loadProject() {
  localStorage.setItem("h3-project-id", state.projectId);
  const [canvas, jobs, assets] = await Promise.all([
    api(`/v1/projects/${encodeURIComponent(state.projectId)}/canvas`),
    api(`/v1/jobs?project_id=${encodeURIComponent(state.projectId)}&limit=100`),
    api(`/v1/assets?project_id=${encodeURIComponent(state.projectId)}&limit=200`),
  ]);
  state.jobs = jobs;
  state.assets = assets;
  state.nodes = Array.isArray(canvas.state?.nodes) ? canvas.state.nodes : [];
  state.viewport = { x: 40, y: 30, zoom: 1, ...(canvas.state?.viewport || {}) };
  state.selectedNodeId = state.nodes[0]?.id || null;
  if (!state.nodes.length) {
    createStarterCanvas();
    state.selectedNodeId = state.nodes[0]?.id || null;
  }
  attachGeneratedAssets();
  applyViewport();
  renderAll();
  scheduleSave();
}

function createStarterCanvas() {
  state.nodes = [
    { id: crypto.randomUUID(), kind: "note", x: 40, y: 70, title: "从这里开始", text: "1. 创建预览节点并提交生成\n2. 在节点设置中人工审批\n3. 点击顶部按钮统一排队跑终稿\n\n所有大型模型共享同一张显卡，会自动串行运行。" },
    { id: crypto.randomUUID(), kind: "video", x: 400, y: 60, title: "镜头预览", params: { prompt: "", profile: "preview8", width: 608, height: 352, duration_seconds: 5, seed: 7 } },
    { id: crypto.randomUUID(), kind: "tts", x: 760, y: 60, title: "角色对白", params: { text: "", language: "ZH", seed: 7 } },
    { id: crypto.randomUUID(), kind: "music", x: 400, y: 300, title: "场景配乐", params: { prompt: "", lyrics: "[Instrumental]", duration_seconds: 5, seed: 7 } },
    { id: crypto.randomUUID(), kind: "agent", x: 760, y: 300, title: "制作 Agent", params: { prompt: "", max_tokens: 512, reasoning: false } },
  ];
}

function renderAll() {
  renderNodes();
  renderInspector();
  renderJobs();
  renderAssets();
}

function getJob(node) {
  return node?.jobId ? state.jobs.find((job) => job.id === node.jobId) : null;
}

function attachGeneratedAssets() {
  let changed = false;
  for (const node of state.nodes) {
    if (!node.assetId && node.jobId) {
      const asset = state.assets.find((item) => item.origin_job_id === node.jobId);
      if (asset) { node.assetId = asset.id; changed = true; }
    }
  }
  if (changed) scheduleSave();
}

function jobsSignature(jobs) {
  return jobs.map((job) => `${job.id}:${job.status}:${job.stage}:${Math.round((job.progress || 0) * 100)}:${job.approval_status}:${job.final_job_id || ""}`).join("|");
}

function nodeBody(node, job, asset) {
  if (asset) {
    if (asset.kind === "video") return `<video class="node-media" data-asset-id="${asset.id}" controls preload="metadata" aria-label="${escapeHtml(asset.name)}"></video>`;
    if (asset.kind === "image" || (asset.media_type || "").startsWith("image/")) return `<img class="node-media" data-asset-id="${asset.id}" loading="lazy" alt="${escapeHtml(asset.name)}">`;
    if (asset.kind === "audio" || (asset.media_type || "").startsWith("audio/")) return `<div>${icon(node.kind === "music" ? "i-music" : "i-voice")}<strong>${escapeHtml(asset.name)}</strong><audio class="node-audio" data-asset-id="${asset.id}" controls preload="metadata"></audio></div>`;
    return `<p class="node-prompt">${escapeHtml(asset.name)}</p>`;
  }
  if (job?.type === "agent.chat" && job.result?.text) return `<p class="node-prompt">${escapeHtml(job.result.text)}</p>`;
  if (node.kind === "note") return `<p class="node-prompt">${escapeHtml(node.text || "双击右侧设置开始记录。")}</p>`;
  const prompt = node.params?.prompt || node.params?.text || "尚未填写内容。选中卡片后在右侧设置。";
  const progress = job && ["queued", "running"].includes(job.status) ? `<div class="node-progress"><span style="width:${Math.max(4, Math.round(job.progress * 100))}%"></span></div>` : "";
  const error = job?.status === "failed" ? `<p class="danger-text">生成失败，请在右侧查看并重试。</p>` : "";
  return `<p class="node-prompt ${prompt.startsWith("尚未") ? "node-empty" : ""}">${escapeHtml(prompt)}</p>${progress}${error}`;
}

function renderNodes() {
  const world = $("#world");
  world.innerHTML = state.nodes.map((node) => {
    const meta = kindMeta[node.kind] || kindMeta.note;
    const job = getJob(node);
    const asset = node.assetId ? state.assets.find((item) => item.id === node.assetId) : null;
    const visualStatus = job?.status || (node.kind === "asset" ? "succeeded" : "draft");
    const review = job?.approval_status && job.approval_status !== "not_required" ? ` · ${statusText[job.approval_status]}` : "";
    const footer = job ? `${jobTypeText[job.type] || job.type}${review}` : (asset ? `${asset.kind.toUpperCase()} · ${formatBytes(asset.size_bytes)}` : "草稿节点");
    return `<article class="node ${node.id === state.selectedNodeId ? "selected" : ""}" data-node-id="${node.id}" style="transform:translate(${Number(node.x) || 0}px,${Number(node.y) || 0}px)">
      <header class="node-header">${icon(meta.icon)}<span class="node-title">${escapeHtml(node.title || meta.title)}</span><span class="status-badge ${visualStatus}">${statusText[visualStatus] || "草稿"}</span></header>
      <div class="node-body">${nodeBody(node, job, asset)}</div>
      <footer class="node-footer"><span>${escapeHtml(footer)}</span><span>${job ? `${Math.round(job.progress * 100)}%` : ""}</span></footer>
    </article>`;
  }).join("");
  bindNodeEvents();
  hydrateMedia(world);
}

function bindNodeEvents() {
  $$(".node").forEach((element) => {
    element.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectNode(element.dataset.nodeId);
    });
    $(".node-header", element).addEventListener("pointerdown", (event) => startNodeDrag(event, element.dataset.nodeId, element));
  });
}

function startNodeDrag(event, nodeId, element) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const start = { screenX: event.clientX, screenY: event.clientY, x: node.x, y: node.y };
  const move = (moveEvent) => {
    node.x = start.x + (moveEvent.clientX - start.screenX) / state.viewport.zoom;
    node.y = start.y + (moveEvent.clientY - start.screenY) / state.viewport.zoom;
    element.style.transform = `translate(${node.x}px,${node.y}px)`;
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    scheduleSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  $$(".node").forEach((element) => element.classList.toggle("selected", element.dataset.nodeId === nodeId));
  renderInspector();
}

function renderInspector() {
  const node = state.nodes.find((item) => item.id === state.selectedNodeId);
  const container = $("#inspector-content");
  if (!node) {
    container.innerHTML = `<div class="empty-state">选择画布节点，在这里设置生成参数。</div>`;
    return;
  }
  const meta = kindMeta[node.kind] || kindMeta.note;
  const job = getJob(node);
  const statusCallout = job ? jobCallout(job) : "";
  container.innerHTML = `<p class="eyebrow">NODE SETTINGS</p><h2>${escapeHtml(node.title || meta.title)}</h2><p class="inspector-copy">${escapeHtml(meta.copy)}</p>${statusCallout}${inspectorForm(node, job)}`;
  bindInspector(node, job);
}

function jobCallout(job) {
  if (job.status === "failed") return `<div class="callout warning"><strong>任务失败</strong><p class="danger-text">${escapeHtml(shortError(job.error))}</p></div>`;
  if (job.status === "succeeded") {
    const review = job.approval_status !== "not_required" ? `，${statusText[job.approval_status]}` : "";
    return `<div class="callout success"><strong>本地生成已完成${review}</strong><br><span>结果已自动登记到项目资产库。</span></div>`;
  }
  return `<div class="callout"><strong>${statusText[job.status] || job.status}</strong><br><span>${escapeHtml(job.stage || "等待调度")} · ${Math.round(job.progress * 100)}%</span></div>`;
}

function inspectorForm(node, job) {
  const p = node.params || {};
  const disabled = job && ["queued", "running"].includes(job.status) ? "disabled" : "";
  const submitLabel = job?.status === "failed" || job?.status === "succeeded" ? "按当前设置重新生成" : "提交到本地队列";
  if (node.kind === "video") {
    const reviewActions = job?.status === "succeeded" && job.params?.profile !== "quality" ? `<div class="form-actions"><button id="approve-job" type="button" class="secondary">${icon("i-review")}${job.approval_status === "approved" ? "取消通过" : "审批通过此预览"}</button></div>` : "";
    return `<form id="node-form">
      <div class="field"><label for="video-mode">生成方式</label><select id="video-mode"><option>文生视频（已接入）</option><option disabled>参考图片生成（节点适配中）</option><option disabled>首尾帧生成（节点适配中）</option><option disabled>参考视频生成（节点适配中）</option><option disabled>音频对白驱动（节点适配中）</option></select></div>
      <div class="field"><label for="prompt">镜头提示词 *</label><textarea id="prompt" required ${disabled}>${escapeHtml(p.prompt || "")}</textarea></div>
      <div class="field-row"><div class="field"><label for="width">宽度</label><select id="width" ${disabled}><option value="608" ${p.width == 608 ? "selected" : ""}>608</option><option value="768" ${p.width == 768 ? "selected" : ""}>768</option><option value="1344" ${p.width == 1344 ? "selected" : ""}>1344</option></select></div><div class="field"><label for="height">高度</label><select id="height" ${disabled}><option value="352" ${p.height == 352 ? "selected" : ""}>352</option><option value="432" ${p.height == 432 ? "selected" : ""}>432</option><option value="768" ${p.height == 768 ? "selected" : ""}>768</option></select></div></div>
      <div class="field-row"><div class="field"><label for="duration">时长（秒）</label><input id="duration" type="number" min="1" max="15" step="1" value="${Number(p.duration_seconds || 5)}" ${disabled}></div><div class="field"><label for="seed">Seed</label><input id="seed" type="number" value="${Number.isFinite(Number(p.seed)) ? Number(p.seed) : 7}" ${disabled}></div></div>
      <div class="field"><label for="profile">预览档位</label><select id="profile" ${disabled}><option value="preview8" ${p.profile !== "preview4" ? "selected" : ""}>8 步稳定预览（推荐）</option><option value="preview4" ${p.profile === "preview4" ? "selected" : ""}>4 步极速预览</option></select><small>默认终稿保留同一提示词、尺寸、时长、Seed、LoRA 与采样步数，确保尽可能复现；清晰度提升由后续独立放大节点完成。</small></div>
      <div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div>
    </form>${reviewActions}`;
  }
  if (node.kind === "tts") {
    const audioAssets = state.assets.filter((asset) => (asset.media_type || "").startsWith("audio/") || asset.kind === "audio" || asset.kind === "reference");
    const options = audioAssets.map((asset) => `<option value="${escapeHtml(asset.source_path)}" ${p.reference_audio === asset.source_path ? "selected" : ""}>${escapeHtml(asset.name)}</option>`).join("");
    return `<form id="node-form"><div class="field"><label for="reference-audio">参考音色 *</label><select id="reference-audio" required ${disabled}><option value="">选择资产库中的参考音频</option>${options}</select><small>先用顶部“导入素材”上传角色干声，建议 5–15 秒。</small></div><div class="field"><label for="tts-text">对白文本 *</label><textarea id="tts-text" required ${disabled}>${escapeHtml(p.text || "")}</textarea></div><div class="field-row"><div class="field"><label for="language">语言</label><select id="language" ${disabled}>${["ZH","EN","JA","ES","AR"].map((v) => `<option ${p.language === v ? "selected" : ""}>${v}</option>`).join("")}</select></div><div class="field"><label for="seed">Seed</label><input id="seed" type="number" value="${Number.isFinite(Number(p.seed)) ? Number(p.seed) : 7}" ${disabled}></div></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form>`;
  }
  if (node.kind === "music") {
    return `<form id="node-form"><div class="field"><label for="prompt">音乐描述 *</label><textarea id="prompt" required ${disabled}>${escapeHtml(p.prompt || "")}</textarea></div><div class="field"><label for="lyrics">歌词或结构 *</label><textarea id="lyrics" required ${disabled}>${escapeHtml(p.lyrics || "[Instrumental]")}</textarea></div><div class="field-row"><div class="field"><label for="duration">时长（秒）</label><input id="duration" type="number" min="5" max="240" value="${Number(p.duration_seconds || 5)}" ${disabled}></div><div class="field"><label for="seed">Seed</label><input id="seed" type="number" value="${Number.isFinite(Number(p.seed)) ? Number(p.seed) : 7}" ${disabled}></div></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form>`;
  }
  if (node.kind === "agent") {
    return `<form id="node-form"><div class="field"><label for="prompt">交给制作 Agent 的任务 *</label><textarea id="prompt" required ${disabled}>${escapeHtml(p.prompt || "")}</textarea><small>例如：把这段故事拆成 6 个可生成的镜头提示词。</small></div><div class="field-row"><div class="field"><label for="max-tokens">最长输出</label><input id="max-tokens" type="number" min="32" max="4096" value="${Number(p.max_tokens || 512)}" ${disabled}></div><div class="field"><label for="reasoning">推理模式</label><select id="reasoning" ${disabled}><option value="false" ${!p.reasoning ? "selected" : ""}>快速</option><option value="true" ${p.reasoning ? "selected" : ""}>深度</option></select></div></div><div class="form-actions"><button class="primary" type="submit" ${disabled}>${icon("i-play")}${submitLabel}</button></div></form>`;
  }
  if (node.kind === "note") return `<form id="node-form"><div class="field"><label for="note-text">便笺内容</label><textarea id="note-text" rows="10">${escapeHtml(node.text || "")}</textarea></div><div class="form-actions"><button class="primary" type="submit">保存便笺</button></div></form>`;
  const asset = state.assets.find((item) => item.id === node.assetId);
  return asset ? `<dl><dt>文件名</dt><dd>${escapeHtml(asset.name)}</dd><dt>类型</dt><dd>${escapeHtml(asset.media_type || asset.kind)}</dd><dt>大小</dt><dd>${formatBytes(asset.size_bytes)}</dd></dl>` : `<div class="empty-state">资产记录不可用。</div>`;
}

function bindInspector(node, job) {
  const form = $("#node-form");
  if (form) form.addEventListener("submit", (event) => submitNode(event, node));
  const approve = $("#approve-job");
  if (approve) approve.addEventListener("click", async () => {
    const target = job.approval_status === "approved" ? "pending" : "approved";
    try {
      await api(`/v1/jobs/${job.id}/approval`, { method: "POST", body: JSON.stringify({ status: target }) });
      toast(target === "approved" ? "预览已审批，可统一进入终稿队列。" : "已撤销审批通过。");
      await refreshJobs(true);
      renderInspector();
    } catch (error) { toast(`审批失败：${error.message}`); }
  });
}

async function submitNode(event, node) {
  event.preventDefault();
  if (node.kind === "note") {
    node.text = $("#note-text").value.trim();
    scheduleSave(); renderNodes(); toast("便笺已保存。"); return;
  }
  let type;
  let params;
  if (node.kind === "video") {
    type = "h3.t2v";
    params = { prompt: $("#prompt").value.trim(), width: Number($("#width").value), height: Number($("#height").value), duration_seconds: Number($("#duration").value), seed: Number($("#seed").value), profile: $("#profile").value };
  } else if (node.kind === "tts") {
    type = "tts.clone";
    params = { reference_audio: $("#reference-audio").value, text: $("#tts-text").value.trim(), language: $("#language").value, seed: Number($("#seed").value), duration_factor: 1 };
  } else if (node.kind === "music") {
    type = "music.generate";
    params = { prompt: $("#prompt").value.trim(), lyrics: $("#lyrics").value.trim(), duration_seconds: Number($("#duration").value), seed: Number($("#seed").value) };
  } else if (node.kind === "agent") {
    type = "agent.chat";
    params = { prompt: $("#prompt").value.trim(), max_tokens: Number($("#max-tokens").value), context: 8192, temperature: .2, reasoning: $("#reasoning").value === "true" };
  }
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  try {
    const job = await api("/v1/jobs", { method: "POST", body: JSON.stringify({ type, params, priority: type === "h3.t2v" ? 100 : 120, project_id: state.projectId }) });
    node.params = params;
    node.jobId = job.id;
    node.assetId = null;
    state.jobs.unshift(job);
    scheduleSave(); renderAll();
    toast("任务已进入本地 GPU 队列。");
  } catch (error) {
    button.disabled = false;
    toast(`提交失败：${error.message}`, 6000);
  }
}

async function refreshJobs(forceAssets = false) {
  try {
    const jobs = await api(`/v1/jobs?project_id=${encodeURIComponent(state.projectId)}&limit=100`);
    const changed = jobsSignature(jobs) !== jobsSignature(state.jobs);
    const selectedNode = state.nodes.find((node) => node.id === state.selectedNodeId);
    const oldSelectedJob = selectedNode ? getJob(selectedNode) : null;
    const oldSelectedSignature = oldSelectedJob ? jobsSignature([oldSelectedJob]) : "";
    const oldTerminal = new Set(state.jobs.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.status)).map((job) => job.id));
    const newTerminal = jobs.some((job) => ["succeeded", "failed"].includes(job.status) && !oldTerminal.has(job.id));
    state.jobs = jobs;
    if (newTerminal || forceAssets) {
      state.assets = await api(`/v1/assets?project_id=${encodeURIComponent(state.projectId)}&limit=200`);
      attachGeneratedAssets();
      renderAssets();
    }
    if (changed || forceAssets) {
      renderNodes();
      renderJobs();
      const newSelectedJob = selectedNode ? getJob(selectedNode) : null;
      if ((newSelectedJob ? jobsSignature([newSelectedJob]) : "") !== oldSelectedSignature) renderInspector();
    }
  } catch (error) {
    console.warn("Job refresh failed", error);
  }
}

function renderJobs() {
  const active = state.jobs.filter((job) => ["queued", "running"].includes(job.status));
  $("#queue-summary").textContent = active.length ? `${active.filter((job) => job.status === "running").length} 运行 · ${active.filter((job) => job.status === "queued").length} 等待` : "空闲";
  const visible = [...active, ...state.jobs.filter((job) => !active.includes(job))].slice(0, 12);
  $("#job-list").innerHTML = visible.length ? visible.map((job) => `<button class="job-card" data-job-id="${job.id}" title="定位到对应节点"><strong>${escapeHtml(jobTypeText[job.type] || job.type)}</strong><span class="status-badge ${job.status}">${statusText[job.status] || job.status}</span><span>${escapeHtml(statusText[job.stage] || job.stage || "")}</span><span>${Math.round(job.progress * 100)}%</span><div class="progress-line"><i style="width:${Math.round(job.progress * 100)}%"></i></div></button>`).join("") : `<div class="empty-state">暂无任务。创建节点后提交生成。</div>`;
  $$(".job-card").forEach((card) => card.addEventListener("click", () => {
    const node = state.nodes.find((item) => item.jobId === card.dataset.jobId);
    if (node) { selectNode(node.id); centerNode(node); }
  }));
}

function renderAssets() {
  const list = $("#asset-list");
  list.innerHTML = state.assets.length ? state.assets.map((asset) => `<button class="asset-card" data-asset-id="${asset.id}"><span class="asset-thumb" data-thumb-id="${asset.id}">${icon(asset.kind === "video" ? "i-video" : asset.kind === "audio" ? "i-voice" : "i-asset")}</span><span class="asset-meta"><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.kind)} · ${formatBytes(asset.size_bytes)}</span></span></button>`).join("") : `<div class="empty-state">还没有项目资产。导入图片、视频或音频，生成结果也会自动出现在这里。</div>`;
  $$(".asset-card", list).forEach((card) => card.addEventListener("click", () => addAssetNode(card.dataset.assetId)));
  hydrateAssetThumbs(list);
}

async function hydrateMedia(root) {
  for (const element of $$('[data-asset-id]', root)) {
    const asset = state.assets.find((item) => item.id === element.dataset.assetId);
    if (!asset) continue;
    try { element.src = await assetUrl(asset.id); } catch { element.replaceWith(document.createTextNode("资产预览加载失败")); }
  }
}

async function hydrateAssetThumbs(root) {
  for (const thumb of $$('[data-thumb-id]', root)) {
    const asset = state.assets.find((item) => item.id === thumb.dataset.thumbId);
    const previewKind = (asset?.media_type || "").startsWith("image/") ? "image" : (asset?.media_type || "").startsWith("video/") ? "video" : asset?.kind;
    if (!asset || !["image", "video"].includes(previewKind)) continue;
    try {
      const url = await assetUrl(asset.id);
      thumb.innerHTML = previewKind === "video" ? `<video src="${url}" muted preload="metadata"></video>` : `<img src="${url}" loading="lazy" alt="${escapeHtml(asset.name)}">`;
    } catch { /* keep icon fallback */ }
  }
}

async function assetUrl(assetId) {
  if (state.objectUrls.has(assetId)) return state.objectUrls.get(assetId);
  const playback = await api(`/v1/assets/${assetId}/playback`);
  state.objectUrls.set(assetId, playback.url);
  return playback.url;
}

function addNode(kind) {
  const rect = $("#canvas").getBoundingClientRect();
  const x = (rect.width / 2 - state.viewport.x) / state.viewport.zoom - 160 + (Math.random() * 60 - 30);
  const y = (rect.height / 2 - state.viewport.y) / state.viewport.zoom - 80 + (Math.random() * 60 - 30);
  const node = { id: crypto.randomUUID(), kind, x, y, title: kindMeta[kind].title, params: {} };
  if (kind === "video") node.params = { profile: "preview8", width: 608, height: 352, duration_seconds: 5, seed: 7 };
  if (kind === "tts") node.params = { language: "ZH", seed: 7 };
  if (kind === "music") node.params = { lyrics: "[Instrumental]", duration_seconds: 5, seed: 7 };
  if (kind === "agent") node.params = { max_tokens: 512, reasoning: false };
  state.nodes.push(node);
  state.selectedNodeId = node.id;
  renderNodes(); renderInspector(); scheduleSave();
}

function addAssetNode(assetId) {
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset) return;
  addNode("asset");
  const node = state.nodes.find((item) => item.id === state.selectedNodeId);
  node.assetId = assetId;
  node.title = asset.name;
  $("#asset-panel").hidden = true;
  renderNodes(); renderInspector(); scheduleSave();
}

function scheduleSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(async () => {
    try {
      await api(`/v1/projects/${encodeURIComponent(state.projectId)}/canvas`, { method: "PUT", body: JSON.stringify({ state: { nodes: state.nodes, viewport: state.viewport } }) });
    } catch (error) { toast(`画布自动保存失败：${error.message}`, 6000); }
  }, 650);
}

function applyViewport() {
  state.viewport.zoom = Math.min(2.2, Math.max(.25, Number(state.viewport.zoom) || 1));
  $("#world").style.transform = `translate(${state.viewport.x}px,${state.viewport.y}px) scale(${state.viewport.zoom})`;
  $("#zoom-value").textContent = `${Math.round(state.viewport.zoom * 100)}%`;
}

function zoomTo(nextZoom, screenX, screenY) {
  const canvas = $("#canvas");
  const rect = canvas.getBoundingClientRect();
  const px = (screenX ?? rect.left + rect.width / 2) - rect.left;
  const py = (screenY ?? rect.top + rect.height / 2) - rect.top;
  const worldX = (px - state.viewport.x) / state.viewport.zoom;
  const worldY = (py - state.viewport.y) / state.viewport.zoom;
  state.viewport.zoom = Math.min(2.2, Math.max(.25, nextZoom));
  state.viewport.x = px - worldX * state.viewport.zoom;
  state.viewport.y = py - worldY * state.viewport.zoom;
  applyViewport(); scheduleSave();
}

function centerNode(node) {
  const rect = $("#canvas").getBoundingClientRect();
  state.viewport.x = rect.width / 2 - (node.x + 160) * state.viewport.zoom;
  state.viewport.y = rect.height / 2 - (node.y + 90) * state.viewport.zoom;
  applyViewport(); scheduleSave();
}

function fitView() {
  if (!state.nodes.length) return;
  const minX = Math.min(...state.nodes.map((node) => node.x));
  const minY = Math.min(...state.nodes.map((node) => node.y));
  const maxX = Math.max(...state.nodes.map((node) => node.x + 320));
  const maxY = Math.max(...state.nodes.map((node) => node.y + 220));
  const rect = $("#canvas").getBoundingClientRect();
  const zoom = Math.min(1.15, Math.max(.3, Math.min((rect.width - 80) / (maxX - minX), (rect.height - 80) / (maxY - minY))));
  state.viewport.zoom = zoom;
  state.viewport.x = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  state.viewport.y = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyViewport(); scheduleSave();
}

async function uploadFiles(files) {
  for (const file of files) {
    const form = new FormData();
    form.append("project_id", state.projectId);
    form.append("kind", "reference");
    form.append("file", file);
    toast(`正在导入：${file.name}`);
    await api("/v1/assets/upload", { method: "POST", body: form });
  }
  state.assets = await api(`/v1/assets?project_id=${encodeURIComponent(state.projectId)}&limit=200`);
  renderAssets();
  $("#asset-panel").hidden = false;
  toast(`已导入 ${files.length} 个素材。`);
}

async function batchFinals() {
  const approved = state.jobs.filter((job) => job.type === "h3.t2v" && job.approval_status === "approved" && !job.final_job_id);
  if (!approved.length) { toast("没有等待入终稿队列的已审批预览。"); return; }
  const button = $("#batch-final");
  button.disabled = true;
  try {
    const result = await api("/v1/finals/batch", { method: "POST", body: JSON.stringify({ preview_job_ids: approved.map((job) => job.id), mode: "reproduce", steps: 20, priority: 200 }) });
    for (const job of result.created) {
      const previewNode = state.nodes.find((node) => node.jobId === job.preview_job_id || node.jobId === job.params?.source_preview_job_id);
      const baseNode = previewNode || state.nodes.find((node) => node.jobId === job.params?.source_preview_job_id);
      const node = { id: crypto.randomUUID(), kind: "video", x: (baseNode?.x || 400) + 360, y: baseNode?.y || 100, title: "终稿候选", params: job.params, jobId: job.id };
      state.nodes.push(node);
    }
    state.jobs.unshift(...result.created);
    scheduleSave(); renderAll();
    toast(`已将 ${result.created.length} 个终稿候选加入串行队列。`);
  } catch (error) { toast(`终稿排队失败：${error.message}`, 6000); }
  finally { button.disabled = false; }
}

function shortError(error) {
  if (!error) return "未返回详细原因。";
  const lines = String(error).split(/\r?\n/).filter(Boolean);
  return lines.slice(-4).join("\n").slice(0, 900);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("#access-key").value.trim();
  if (!key) { $("#login-status").textContent = "请输入访问密钥。"; return; }
  $("#login-status").textContent = "正在验证…";
  try { await authenticate(key); } catch (error) { showLogin(`登录失败：${error.message}`); }
});

$("#project-select").addEventListener("change", async (event) => { state.projectId = event.target.value; await loadProject(); });
$("#new-project").addEventListener("click", async () => {
  const name = window.prompt("新项目名称");
  if (!name?.trim()) return;
  try {
    const project = await api("/v1/projects", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
    state.projects.unshift(project); state.projectId = project.id; renderProjects(); await loadProject(); toast("新项目已创建。");
  } catch (error) { toast(`创建失败：${error.message}`); }
});

$$('[data-add]').forEach((button) => button.addEventListener("click", () => addNode(button.dataset.add)));
$("#upload-button").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", async (event) => {
  if (!event.target.files.length) return;
  try { await uploadFiles([...event.target.files]); } catch (error) { toast(`导入失败：${error.message}`, 6000); }
  event.target.value = "";
});
$("#toggle-assets").addEventListener("click", () => { $("#asset-panel").hidden = !$("#asset-panel").hidden; });
$("#close-assets").addEventListener("click", () => { $("#asset-panel").hidden = true; });
$("#batch-final").addEventListener("click", batchFinals);
$("#zoom-in").addEventListener("click", () => zoomTo(state.viewport.zoom * 1.15));
$("#zoom-out").addEventListener("click", () => zoomTo(state.viewport.zoom / 1.15));
$("#fit-view").addEventListener("click", fitView);

$("#canvas").addEventListener("wheel", (event) => {
  event.preventDefault();
  zoomTo(state.viewport.zoom * (event.deltaY < 0 ? 1.1 : .9), event.clientX, event.clientY);
}, { passive: false });

$("#canvas").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".node") || event.target.closest(".zoom-controls")) return;
  const canvas = $("#canvas");
  canvas.classList.add("panning");
  const start = { x: event.clientX, y: event.clientY, vx: state.viewport.x, vy: state.viewport.y };
  const move = (moveEvent) => {
    state.viewport.x = start.vx + moveEvent.clientX - start.x;
    state.viewport.y = start.vy + moveEvent.clientY - start.y;
    applyViewport();
  };
  const end = () => {
    canvas.classList.remove("panning");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    scheduleSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
});

attemptLocalAuth();
