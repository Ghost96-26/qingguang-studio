# GitHub 轻量脱敏发布

## 发布内容

公开包通过允许名单从开发目录单独导出。保留自有源代码、前端锁文件、启动/下载/诊断工具、脱敏模板、包版本文本和本文档；排除模型、环境二进制、第三方源码整包、node_modules、构建产物、日志、数据库、备份、用户及任务原始记录。2026-09-06 按项目展示要求增加六个精选展示文件：品牌 SVG、三张界面截图、一张视频封面和一段压缩 MP4；以路径和 SHA256 双重允许名单检查，其他媒体继续排除。

实际本机 `gateway.json`、`runtime.json` 与许可证接受记录不发布，只提供占位符模板；新机器本地生成路径和随机密钥。导出器不连接网络、不操作 Git、不重装环境。

## 生成可审阅目录

在私人开发目录运行，输出目录必须尚不存在：

```powershell
python scripts/export_public_repository.py --destination release/qingguang-studio-public
python scripts/check_public_repository.py --root release/qingguang-studio-public
```

Python 使用 3.12+。导出器先生成全部候选文本、替换机器路径、对本机密钥文件中的长字符串做精确比对，再检查敏感模式和体积；失败不写出发布目录。成功后生成 `PUBLIC-EXPORT-REPORT.json`，记录每个源文件的大小与 SHA256。

该扫描不能保证发现所有业务隐私，发布前仍应审阅候选文件；尤其自有源代码的授权范围不能由敏感词扫描判定。这里只处理代码快照，不携带开发历史。导出脚本供私人工作目录使用；公开包已经脱敏，不需要重新导出自己。

## 上传步骤

只有独立发布目录可以初始化为新仓库。不要在整个模型工作目录执行 `git add .`。假设已获得自己的目标仓库 URL，在发布目录执行：

```powershell
git init -b main
git add .
python scripts/check_public_repository.py --staged
git diff --cached --stat
git commit -m "Initial sanitized source release"
# 将下方占位符替换为自己的仓库 URL，不要原样运行。
git remote add origin <YOUR_REPOSITORY_URL>
git push -u origin main
```

`--staged` 检查的是完整 Git index 内容，不仅是工作区文件。必须先检查成功再 commit/push。若目标仓库已有历史，先在独立克隆中审阅合并方案，不能强推覆盖；本扫描不覆盖远端旧历史。用户凭据或大文件若已提交，新增 `.gitignore` 不会移除旧历史，必须另做历史清理及泄露凭据轮换。

## 控制流量

- 项目自定阈值：单文件不超过 2 MiB，包含展示媒体在内的发布快照不超过 20 MiB；超出时导出/检查失败。精选媒体合计约 1.3 MB，不涉及模型或环境包。
- 模型只从各自上游下载到本地，默认不使用 Git LFS，也不把环境或模型放 Release。依赖锁文件只是文本，可正常提交。
- 前端使用 `npm ci` 恢复；环境用版本文本重建；禁止提交 node_modules、uv 缓存或 Python site-packages。
- 首次可浅克隆仓库；后续只推送改动。当前少量展示媒体由用户明确要求加入；后续长视频优先另行托管，不默认扩大仓库媒体量。
- 模型下载按模态启用，保留已有缓存支持续传；不要同时把国内/海外路线跑成重复完整下载。

GitHub 官方说明大文件会影响仓库性能，并对常规 Git 文件大小设限；本项目采取更严格的源包阈值，避免接近平台上限。[GitHub 大文件说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

这能控制项目上传与克隆体积，不能消除部署时数十至数百 GB 的模型下载流量。压缩包和 Git pack 的实际网络字节数可能不同，以最终传输统计为准。

## 许可与当前验证范围

项目源代码尚未选定统一 LICENSE；不要自动添加 MIT/Apache 等授权。第三方包和模型各自许可独立，下载流程保留上游许可查看入口，不复制本机的接受记录。

本次发布准备验证：UTF-8 源包筛选、路径脱敏、已知密钥比对、禁止类型/体积检查、模板初始化与重复运行保护、脚本语法检查。没有重下模型、重新部署 GPU 环境或向 GitHub 推送；目标仓库由用户提供后再对接。
