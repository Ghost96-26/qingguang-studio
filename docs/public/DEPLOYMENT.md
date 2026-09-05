# Windows 详细部署指南

适用版本：2026-09-05 源代码快照。本指南区分已验证的本机版本与待部署者验证的恢复步骤；本次只整理与检查源代码发布包，没有重下数百 GB 模型或重装当前环境。

## 1. 选择部署范围

- 前端/接口开发：先恢复网关与 V3，模型未安装时显示未就绪，不运行生成任务。
- 视频创作：在基础上安装 ComfyUI 和 H3 主模型、编码器、VAE；按需加 Turbo。
- 全功能：再恢复图像、TTS、Music、Foley、LLM，每个模型族单独验收后开放。

项目 provider 使用 Windows 专用能力（包括 `winreg`），目前不宣称 Linux/macOS 可直接运行。不要直接用多个 Uvicorn worker 扩容：GPU 独占队列是本机实现，多进程/多机器分布式锁未交付。

## 2. 硬件、空间与端口

已验证显卡为 RTX 5090。驱动历史记录为 610.47，Python 3.12.13、PyTorch 2.11.0+cu130、CUDA runtime 13.0；这是历史组合，不要求盲目降级现有驱动。确认驱动支持该 CUDA wheel，再运行 CUDA 自检。

完整模型库旧清单约 363.77 GiB，早于最新 Foley 增量；它既不是当前重新统计值，也不是最低下载量。全量部署可先规划至少 500 GiB 模型盘可用空间，环境/缓存/素材另计；按需路线以各下载脚本清单为准。启动脚本记录的工作站规格为 32 GB 显存、64 GB RAM；系统内存最低值尚未形成实测矩阵，应为大模型卸载预留充足内存和分页文件，部署前记录实际 RAM 与峰值占用。

需要 Git、Python/uv、Node.js/npm、FFmpeg 与 ffprobe，以及 NVIDIA 驱动。前端类型剥离测试建议使用 Node 22.18+ 的 22 系列或兼容版本，先记录 `node --version`；不要认为安装 Node 就包含 GPU 环境。

| 端口 | 服务 | 默认边界 |
|---|---|---|
| 8090 | 鉴权网关及工作台 | 127.0.0.1 |
| 8188 | ComfyUI | 仅内部使用 |
| 11434 | Ollama，可选 | 本机 |

## 3. 创建脱敏配置

将仓库克隆到自己选择的目录。下面命令在仓库根目录运行，模型目录示例请自行替换：

```powershell
python scripts/initialize_public_config.py --model-root C:\QingguangModels --ffmpeg C:\Tools\ffmpeg\bin\ffmpeg.exe
powershell -NoProfile -File scripts/Initialize-GatewaySecrets.ps1
```

初始化脚本从 `config/templates` 生成 `runtime.json`、`gateway.json`、`extra_model_paths.yaml` 和 `model-root.txt`，自动使用实际仓库路径，遇到已有配置会拒绝覆盖。第二条命令在本机随机生成新访问密钥，不打印密钥值。生产旧配置与用户数据库不能从别人的发布包复制。

重点核对：`python_executable`、`python_site_packages`、各 provider 的 Python/源码/模型路径、FFmpeg 路径。`ffprobe.exe` 应与 FFmpeg 同目录或可在 PATH 找到。示例中的源码目录不是已经安装的运行环境。

目录约定：

```text
<PROJECT_ROOT>/
  services/             自有前后端与适配器
  scripts/ tools/       下载、初始化、启停、诊断
  config/               本机配置，禁止提交
  config/templates/     可公开模板
  runtime/              自行恢复的第三方源码与隔离环境
  data/                 数据库、用户及项目分区
  artifacts/ logs/      运行输出，禁止提交
<MODEL_ROOT>/
  video/minimax-h3/
  image/krea2/  image/ideogram4/
  audio/tts/IndexTTS-2.5/  audio/music/MiniMax-Music3/
  audio/foley/HunyuanVideo-Foley-XXL/  audio/foley/encoders/
  llm/Qwen3.6-27B-GGUF/  llm/ollama/  cache/
```

## 4. 恢复 Python、网关和前端

以下会下载环境依赖，但不会下载模型；原有环境不要就地覆盖。

```powershell
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PWD 'runtime\python'
uv python install 3.12.13
uv venv runtime/orchestrator/.venv --python 3.12.13 --seed
uv pip install --python runtime/orchestrator/.venv/Scripts/python.exe -r deploy/reference/gateway-requirements.txt
uv pip check --python runtime/orchestrator/.venv/Scripts/python.exe
Push-Location services/ui-v3
npm ci
npm run check
npm run build
npm run test:graph
npm run test:sites
Pop-Location
```

每条外部命令失败后先停下排查，不能忽略退出码继续部署。标准 `npm run build` 包含 Sites 兼容打包，所以源包保留无凭据的 `.openai/hosting.json`、worker 与打包脚本；它不会自动发布站点。

旧启动器兼容 Windows 应用控制：使用 `runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe` 加隔离环境的 `site-packages`。确认 uv 实际创建路径；若命名不同，应让 Agent 同步调整 `Start-WorkbenchGateway.ps1` 和运行配置，不能只更改其中一处。TTS/Music/Foley 使用各自虚拟环境解释器；若被应用控制拦截，单独处理启动路径。

前端产物应为 `services/ui-v3/dist/client/index.html`，之后由网关提供 `/v3`。网关可以在模型缺失状态运行以检查登录与界面；此时不要点击媒体生成。

## 5. 恢复 ComfyUI/H3 环境

从 [ComfyUI 上游](https://github.com/Comfy-Org/ComfyUI) 获取源码，按 `deploy/reference/runtime-lock.json` 的 commit 恢复到 `runtime/ComfyUI`。使用明确版本的压缩源码归档或浅 fetch，避免克隆全部历史。

```powershell
git init runtime/ComfyUI
git -C runtime/ComfyUI remote add origin https://github.com/Comfy-Org/ComfyUI.git
git -C runtime/ComfyUI fetch --depth 1 origin 5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67
git -C runtime/ComfyUI checkout --detach FETCH_HEAD
powershell -NoProfile -File scripts/Install-H3Runtime.ps1
uv pip install --python runtime/.venv/Scripts/python.exe -r config/runtime-packages.txt --extra-index-url https://download.pytorch.org/whl/cu130
uv pip check --python runtime/.venv/Scripts/python.exe
```

`Install-H3Runtime.ps1` 要求源码预先存在，不会下载 ComfyUI；其中 `uv python install 3.12` 是系列选择，正式复现应以先前安装的 3.12.13 和实际解释器版本为准，必要时明确改为 3.12.13。不要直接升级到最新 ComfyUI 后仍声称是原基线。

`comfy-kitchen` 基线 0.2.31。H3 原生 INT8 路线是项目主路线，不能误换成 GGUF/NF4/FP8 视频权重。下载后检查 `/object_info/MiniMaxH3ImageToVideo`，仅有模型文件还不够。H3Lite 固定版本仅为参考来源，并非把整个 vendor 目录重新上传。

## 6. 模型配置与分批下载

下面的脚本是已有下载流程的脱敏副本；必须显式传路径。不要依赖双击脚本中的示例盘符，也不要一次默认下载所有可选模型。

```powershell
# H3 + TTS 核心；先跳过音乐和 Agent，稍后按需恢复。
.\01_MiniMax_H3_CN_Download.ps1 -WorkspaceRoot $PWD.Path -ModelRoot C:\QingguangModels -SkipMusic -SkipAgent
# H3 Turbo 和 TTS 配套编码器/声码器。
.\02_MiniMax_H3_HF_VPN_Download.ps1 -WorkspaceRoot $PWD.Path -ModelRoot C:\QingguangModels
# 图像 BF16/FP8，及 Identity 编辑节点扩展。
.\scripts\Download-ImageModels-CN-BF16.ps1 -WorkspaceRoot $PWD.Path -ModelRoot C:\QingguangModels
.\scripts\Download-ImageModels-HF-VPN.ps1 -WorkspaceRoot $PWD.Path -ModelRoot C:\QingguangModels
# Foley 主包：选择 CN 或 HF 其中一条，不需要重复下载两份。
.\scripts\Download-HunyuanVideoFoley-XXL-HF-VPN.ps1 -WorkspaceRoot $PWD.Path -SharedModelRoot C:\QingguangModels
```

下载脚本可能询问模型许可；阅读对应上游当前条款后由部署者确认，不把原机器的 `.accepted.json` 复制给新机器。需要授权的仓库使用本机 CLI 登录或环境变量，禁止将 Token 写入脚本或带签名下载网址。

| 模型族 | 选择与用途 | 必备文件/依赖 |
|---|---|---|
| H3 | 原生 INT8 扩散 + 32B INT8 文本编码；默认新节点 1344×768、30 步 | fl2va/ref2va、文本编码器、视频/音频 VAE；Turbo 必须配套对应 4/8 步 LoRA |
| Krea 2 | Turbo BF16 常用，Raw BF16 复杂编辑，Identity v1.2 保持主体 | BF16 主模型、Qwen3VL 4B 编码器、图像 VAE、Identity LoRA；编辑节点包 1.2.5 |
| Ideogram 4 | FP8 字体/版式路线 | 条件与无条件双模型、Qwen3VL 8B FP8 编码器、Flux2 VAE |
| IndexTTS 2.5 | 参考音色与对白 | gpt/s2mel/codec、w2v-bert、BigVGAN、MaskGCT semantic codec、CampPlus；不是只有三个 pth |
| Music 3 | 音乐与配乐 | 全部 modular pipeline 组件，包括 `modular_model_index.json`、`flowmatching_vae.pth` |
| Foley XXL | BF16 视频同步音效，最多 15 秒 | XXL 主模型、Synchformer、48k VAE、config；另需 SigLIP2 与 CLAP 完整编码器目录 |
| Qwen 3.6 27B | Q4_K_M GGUF，默认中文 Agent | GGUF、llama.cpp 可执行文件和 DLL；mmproj 下载不等于规划器读取了像素 |
| Gemma 4 | Ollama 26B 平衡/31B 质量，可选 | 对应模型 tag 与 Ollama 模型目录；确认 `ollama list` 中存在 |

精确图片/提示词要求见 `config/model-registry.json`；H3/TTS/Music/Foley 的要求还写在 `providers.py` 和下载脚本中，registry 并未覆盖所有模态。

既有脚本未对所有上游模型固定 revision，也并非每个文件都有 SHA256；文件大小检查不能替代完整性校验。Foley 三个大权重有固定大小与 SHA256 检查。复现时记录新下载的 revision/hash，不能把浮动仓库当作位级锁定。

## 7. 专用环境恢复参考（Agent 必须逐项落实）

`deploy/reference/*-requirements.txt` 是本机已安装包的名称/版本快照，不包含环境二进制。包含较多依赖的快照用于比对，不建议跨平台不加检查地整表安装。统一安装 PyTorch CUDA 组合后，按对应源码要求补依赖并执行 `uv pip check`。

### IndexTTS

从 [IndexTTS 上游](https://github.com/index-tts/index-tts) 恢复含 `indextts/infer_v2_5.py` 的源码至 `runtime/index-tts`。独立环境为 `runtime/index-tts-py312/.venv`，参照 `config/indextts-py312-requirements.txt` 和环境版本快照。所有 Hugging Face 配套模型按下载脚本放到 TTS 的 `hf_cache`。适配器已有 SoundFile 输出兼容处理，避免遗漏。

当前资料没有可靠固定的 IndexTTS 源码 commit，部署 Agent 必须记录实际取得的 revision 并单独验收，不能宣称完整复现已经锁定。确认离线 import、参考音色短句真实推理与 WAV 可播放，再写该 provider 的 `.workbench-ready.json`。

### Music 3

源码参考为 `huggingface/diffusers` 的 `dafe3733fcfdbf3c48915fe77be3aef65b5d6a2d`，恢复到独立源码目录并在 `runtime/music3/.venv` 安装。必须具备 `ModularPipeline` 和 MiniMax Music 3 组件；不要仅安装一个不包含这些类的旧版 PyPI Diffusers。独立校验离线加载、短音乐 WAV 输出后才写就绪标记。

### HunyuanVideo-Foley

从 [Foley 上游](https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley) 恢复 commit `df7b005b5023df2a9b73e1d66dd51d452799884e` 到 `runtime/hunyuanvideo-foley/source`。独立环境为同目录上一级的 `.venv`；项目使用 XXL、BF16 与显存卸载。

Foley 主包脚本**不安装运行依赖，也不下载下面两个编码器**。另行从模型上游下载完整配置/分词器/权重：

```powershell
uv tool run --from huggingface-hub hf download google/siglip2-base-patch16-512 --local-dir C:\QingguangModels\audio\foley\encoders\siglip2-base-patch16-512
uv tool run --from huggingface-hub hf download laion/larger_clap_general --local-dir C:\QingguangModels\audio\foley\encoders\larger_clap_general
```

本机 Foley 源码有离线适配，纯上游源码不等价：`hunyuanvideo_foley/utils/model_utils.py` 中懒加载与常规加载两条路径，均需读取 `HUNYUAN_FOLEY_SIGLIP_ROOT`、`HUNYUAN_FOLEY_CLAP_ROOT`，在离线时检查目录并向 `AutoModel/AutoTokenizer/ClapTextModelWithProjection.from_pretrained` 传 `local_files_only=True`；SigLIP 处理器也必须用本地配置。缺少本地目录应报错，不能静默回退联网。Agent 按该契约对固定上游应用最小修改、保存补丁与验证记录；本公开包不携带修改后的整套第三方环境。

对照 `services/adapters/run_hunyuanvideo_foley.py` 的请求字段和输出协议，验证 CUDA、离线编码器加载和真实 10 秒以内视频转 WAV，然后写 `.workbench-ready.json`。不要为让界面变绿预先伪造就绪标记。最新已有实机记录使用 10 步、引导 4.5、约 10 秒视频，输出 48kHz 单声道 WAV；菜单高质量档需在目标机器另测。

### Qwen/Gemma

Qwen 可按核心 CN 下载脚本的 `lmstudio-community/Qwen3.6-27B-GGUF` 与具体 Q4_K_M 文件选择恢复；llama.cpp 的 Windows CUDA 运行文件放到 `runtime/llama.cpp`，不能遗漏 DLL。其二进制版本未在统一锁文件中固定，应新增实际版本记录。

Gemma 使用本机 Ollama，`OLLAMA_MODELS` 指向 `<MODEL_ROOT>/llm/ollama` 后恢复对应 tag，核对网关 `ollama_base_url`。Agent 只需一个通过测试的默认模型；不要为了展示菜单而默认下载全部 LLM。

## 8. 启动与验收

```powershell
.\03_H3_Runtime_Doctor.cmd
.\04_Start_H3_Runtime.cmd
.\07_Start_Workbench_Gateway.cmd
.\10_Workbench_Doctor.cmd
.\09_Open_H3_Workbench.cmd
```

首次本机进入后设置管理员密码，再按项目邀请成员。检查 `http://127.0.0.1:8090/health`、`http://127.0.0.1:8188/system_stats` 和网关能力清单。健康接口成功只说明服务运行，不代表全部模型可用。

验收分三层：

1. 无 GPU 回归：前端检查/构建/规则，后端独立临时数据库测试，禁止指向生产数据库。
2. 逐模型冒烟：空队列下明确选择一个小任务，检查输出可播放、任务状态、真实参数和资产归档；H3 可用 `06_Run_H3_Smoke_Test.cmd`，会实际占用 GPU。
3. 全链路：素材→分镜草稿→确认范围→逐镜生成→可选配乐→审片成片；检查失败暂停、重启恢复、取消与权限。需要真实观看画面和听音频，不能只看 HTTP 200。

不要把源码发布包检查通过写成新机全部模型推理通过。当前发布包的真实验证结果另见发布说明。

## 9. 日常运行、备份和排错

推理阶段保持离线变量，不在任务中临时下载缺失组件；下载时使用单独终端清除离线变量。H3、图像、LLM、音频不能各自绕过网关同时跑大模型。

备份前等待队列空闲并停止网关，复制数据库与其依赖资产，或使用 SQLite 在线备份机制；运行中仅复制主 sqlite 文件可能遗漏 WAL。备份应在私人位置，不能提交 GitHub。回滚代码后先校验数据库版本，不直接用旧库覆盖新任务数据。

| 现象 | 排查顺序 |
|---|---|
| 网关不启动 | Python 实际路径、隔离 site-packages、配置 JSON、FFmpeg、stderr 日志 |
| 模型未就绪 | 文件路径/大小、节点存在性、编码器、专用环境和真实验收标记 |
| CUDA/OOM/模型切换失败 | 队列与其他 GPU 进程、锁定 wheel、显存卸载、按模型族切换；先恢复已验证尺寸 |
| 离线时要求联网 | 缺少 tokenizer/config/encoder 或源码未接离线路径；回下载阶段补齐 |
| 图片编辑不可用 | Identity LoRA、1.2.5 节点包和 ComfyUI 节点注册 |
| 403/无法下载 | 当前账号项目角色、CSRF/会话、短期票据过期；不要绕过项目权限 |
| 音视频合成失败 | FFmpeg/ffprobe、输入真实时长/编码和文件权限 |

## 10. 公网部署边界

目前本地验收不代表公网就绪。保留回环监听，通过经单独验证的 HTTPS 反向代理或 Tunnel 暴露网关；不可暴露 ComfyUI 或直接映射 GPU 服务端口。部署 Agent 必须验证代理头信任、本机自动登录边界、注册/登录限流、上传体积、媒体不公共缓存、票据下载、多网络和多人负载。域名和托管设置按部署者自己的账户配置，不复制原机器凭据。

静态前端托管只提供界面，不能在 GitHub Pages 或静态 worker 上运行本机 Python/GPU 推理。正式远程方案及运营验收需要独立完成。
