# 部署 Agent 执行约定

先阅读 `docs/public/PROJECT-STATUS.md`、`docs/public/DEPLOYMENT.md`、`docs/public/PUBLISHING.md`，再检查 `config/templates` 与 `deploy/reference`。所有模型名和版本以本项目快照为基线，不能擅自换模型/精度后声称复现成功。

1. 首先清点 OS、GPU/驱动、RAM、磁盘空间、Python/Node/uv/FFmpeg、现有服务与用户数据，选择最小所需模型范围。
2. 使用 `scripts/initialize_public_config.py` 初始化自己的机器路径；不要覆盖已有配置、密钥、数据库或模型目录。
3. 环境安装、模型下载、运行验收是三个独立阶段；下载器完成不等于服务就绪。所有外部命令检查退出码，固定依赖不存在时明确报告，不静默替换成 latest。
4. 依赖版本快照只是已安装包记录，不含完整平台/源码修改锁定；IndexTTS、llama.cpp/Ollama 的准确来源版本需补录。Foley 必须补齐文档描述的离线加载适配，Music 使用约定 Diffusers commit。
5. 模型仅从上游按需下载，使用 CLI 的续传/已有缓存机制；首次下载记录 revision、文件大小和可取得的校验和。遇到 gated 仓库由部署者本机完成授权，不保存 Token 到源码。
6. 不伪造 `.workbench-ready.json`；仅在依赖、CUDA、离线加载与真实输出验收通过后生成本地标记并记录步骤。
7. 单卡只保留一个调度 worker。规划不自动触发媒体生成；新增真实推理应在用户任务授权范围内执行，避免验收时触发未请求的长片或大批量下载。
8. 先无 GPU 测试，再逐模型冒烟，再完整分镜成片；分别报告结果。未验证视觉理解、2048、自动精剪、精确声音时间轴与公网生产能力时不能宣称完成。
9. 公网部署独立验证代理信任与本机自动登录，不以“监听回环”替代鉴权验收。
10. 提交只包含源代码、模板、版本文本、参考文档和已核准的少量公开展示媒体；运行 `python scripts/check_public_repository.py --staged`。展示媒体仅限脚本中的路径及 SHA256 允许名单；禁止模型/环境/用户素材库/日志/数据/密钥进入 Git、LFS、Release 或 Actions artifact。

交付应包括：实际版本/路径清单（仅私人保存）、依赖检查、各模型就绪结果、真实输出验收、剩余问题、启动与回滚步骤。可公开报告必须再次脱敏，不把账户、项目 ID、下载票据或机器路径带回仓库。
