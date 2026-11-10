# 剪渡 / Jiandu

[English](README.en.md) · [安装与配置](docs/INSTALL.md) · [验收](docs/ACCEPTANCE.md) · [目录与依赖](docs/PROJECT.md)

剪渡是一套面向 macOS 的本地视频分析与 Final Cut Pro FCPXML 编排工具，包含 Electron 界面、确定性 CLI 和 Codex Skill。Agent 负责理解素材、选择镜头与字幕；CLI 负责媒体探测、协议校验、项目构建与核验。最新实现来自 2026-09-18 的本地完整源码，包版本为 `3.1.0-stage1`；名称中的 stage1 是已有包版本，不代表所有能力仅处于第一阶段。

默认保留源素材，正式输出为可编辑 FCPXML；预览 MP4 按需生成。状态、缓存、修订和任务记录位于 `~/Library/Application Support/剪渡`。FCPXML 可能引用源素材或该状态目录的派生媒体，交付后不能随意删除这些引用文件。

## 安装

需要 Node.js 22+、npm、FFmpeg/FFprobe、macOS。使用桌面界面需要 Electron；导入时间线需要 Final Cut Pro。使用 Agent 工作流需要已配置的 Codex。仓库不包含任何账户凭据、个人素材或商业软件。

```bash
git clone https://github.com/laohu-88/jiandu.git
cd jiandu
npm ci
npm run check
npm test
node bin/jiandu.js help
npm start
```

FFmpeg/FFprobe 应位于 PATH 或 `/opt/homebrew/bin`、`/usr/local/bin`。若尚未安装，可使用现有包管理器安装 `ffmpeg`。不要把个人 Token 写进仓库。

## Skill 与使用

```bash
export JIANDU_HOME="$PWD"
node scripts/install-video-skill.js
node scripts/install-video-skill.js --check
```

在新的 Codex 会话中使用 `$jiandu`，提供一期素材目录及 `JIANDU_HOME` 的绝对路径。Skill 在 `skills/jiandu/`，完整分析协议在其 `references/analysis-protocol.md`。

```bash
node bin/jiandu.js prepare --source "/absolute/path/to/media" --json
node bin/jiandu.js validate-analysis --manifest "/absolute/path/to/manifest.json" --analysis "/absolute/path/to/analysis.json" --json
node bin/jiandu.js build --manifest "/absolute/path/to/manifest.json" --analysis "/absolute/path/to/analysis.json" --project-root "/absolute/path/to/projects" --project-name "Demo" --json
node bin/jiandu.js verify --project "/absolute/path/to/projects/Demo" --json
```

`prepare` 输出清单位置；分析 JSON 须由 Agent 查看真实素材后按 schema 生成，不是凭文件名猜测。默认输入目录为 `~/Desktop/视频待处理`，项目库为 `~/Desktop/视频素材库`。配置示例见 `examples/`；示例路径须替换为自己的绝对路径。

## macOS 打包

```bash
npm run package:mac
npm run verify:package
```

生成 Apple Silicon 本机 ad-hoc 签名 App，默认位于 `dist/mac-arm64/剪渡.app`；不是已公证的公开安装包。安装到 Applications 需显式运行 `npm run install:mac:local`。可选 HyperFrames 不属于基础依赖，详见 `docs/PROJECT.md`。

## 验证与边界

`npm run check` 检查 JavaScript，`npm test` 覆盖 CLI、FCPXML、媒体、字幕、任务与路径规则。安装/测试实际结果记录在 `docs/ACCEPTANCE.md`。自动验证不能代替 Final Cut Pro 人工导入、视觉剪辑质量和音画同步检查。

MIT 许可适用于本仓库原创源码；Electron、FFmpeg、HyperFrames 等依赖及用户素材保留各自许可。公开历史经过个人路径及提交身份脱敏，提交 SHA 已改变，见 `docs/PRIVACY.md`。旧版工具源码位于 `legacy/`（如有），仅供追溯，不作为当前运行依赖。
