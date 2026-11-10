# 历史说明（非当前安装入口）

此文档保留演进背景；旧命令、四目录布局和本机验收示例可能已经失效。请以仓库根 README 为准。

# 剪渡（jiandu）

AI 视频 → Final Cut Pro 的 Skill-first 工作台。剪渡 Skill + CLI 承载全部业务；Electron 只是可选薄壳。工作流面向软件操作录屏、开发过程、功能前后对比、截图、测试证据和成品展示，不依赖口播、配音、全程字幕或固定分段模板。

## Agent-first 视频工作流

```text
素材进入待处理
→ App 自动识别（含 HotIngest 伴随信息）
→ 用户可填写「本次额外要求」
→ 开始剪辑（AI Agent → FCPXML → Final Cut Pro）
→ Agent 读取固定 Skill 与本次任务清单
→ App 监控完成后自动回流到结果工作区
→ 预览 / 让 AI 再调整 / 在 Final Cut Pro 中打开
```

CLI 和 Electron IPC 调用同一组 `src/services`，不会复制项目创建、素材登记、FCPXML、预览或验证逻辑。CLI 不接入外部模型；主题、标题、素材判断和镜头顺序由当前 Codex 会话完成。

## Stage 4D 可视化交接

Electron 默认打开“待处理素材”，只扫描 `~/Desktop/视频待处理` 的直属子目录。卡片显示图片、视频、音频、支持文件、总数、视频总时长、大小、修改时间、读取/格式警告、最近任务和正式结果。已有结果优先按正式项目 `sourceDirectory`、原始快照 digest 和规范化真实路径匹配，不按目录名猜测。

薄壳上直接填写「本次额外要求」并开始剪辑；HyperFrames 模式：

- `auto`：默认；先形成真实素材初剪，再判断动画是否明显优于普通剪辑、轻字幕或转场；
- `disabled`：本期禁止 HyperFrames；
- `force-attempt`：必须认真设计尝试，但质量门不通过时放弃。

“开始剪辑”创建 `<Electron userData>/handoffs/<UUID>.json`，使用 `codex://threads/new?prompt=<encoded>&path=<encoded>` 打开 Codex 并将应用置前。工作目录固定为本仓库，素材目录、任务 ID、任务文件和模式在完整提示词中传入；输入框预填但不会自动发送。唯一人工动作是用户按一次发送。

任务快照用临时文件原子替换，旁边保留追加式 NDJSON 事件；损坏任务单点隔离显示，尾部不完整事件被忽略。真实 Skill/CLI 节点写入扫描、元数据、抽帧、分析、编排、HyperFrames、构建、预览、FCPXML、验证和心跳。App 通过文件监听发现终态，自动置前并打开该任务完成页；应用中途关闭时，下次启动仍能恢复未查看终态。

完成页是进入 FCP 前的短验收门，直接展示标题、镜头、时长、Marker、FCP Title、HyperFrames、正式/预览规格并播放粗剪。完整通过时主按钮“在 Final Cut Pro 中打开”可用；警告明确列出且不自动打开；失败时不显示“粗剪已完成”，无有效 FCPXML 时禁用 FCP。设置“验证全部通过后，自动打开 Final Cut Pro”默认关闭并持久化，只对无警告的完整成功执行。

任务 schema、状态生命周期、路径安全和 CLI 回流命令见 [`docs/handoff-schema.md`](docs/handoff-schema.md)。普通 CLI 未传 `--handoff-task` 时保持原行为，不创建交接状态。

## Electron 项目结果中心

运行：

```bash
npm start
```

应用的“项目结果中心”只读扫描 `~/Desktop/视频素材库` 的直属项目目录。创建正式项目后，不需要再次输入路径；点击列表项目即可查看：

- 项目状态、主题、主题依据、建议标题和标题候选；
- 采用、候选、淘汰素材及理由、有效区间和精选素材复制状态；
- 最终镜头顺序、总时长、完整 Marker 字段，以及 HyperFrames 独立镜头；
- 正式 FCP 时间线规格与粗剪预览规格；
- 源素材 SHA-256、FCPXML、预览和 HyperFrames 验证；
- FCPXML、粗剪、分析 JSON、状态 JSON 和项目目录的位置。

详情页可直接播放粗剪；启用 HyperFrames 时也可独立播放动画。“轻字幕建议”会显示文案、秒数、FCP 时间码、镜头、素材、用途、建议时长与位置，以及 Marker/Title 的 FCPXML 状态。点击 Marker 可 seek 粗剪、同步高亮镜头并临时叠加字幕；叠加层只用于审阅，不写项目、不改粗剪、不重新编码。

Marker 是建议和定位信息，FCP Title 才是画面中真正显示的可编辑文字。两者会同时保留：不导出 SRT，不把文字烧录到粗剪中；导入 Final Cut Pro 后可继续调整 Title 的文字、时长、位置和样式。HyperFrames 项目始终以 `effectiveAnalysis.timeline` 的最终时间为准。

粗剪是评审产物，默认可为 640×360；“正式 FCP 项目”卡显示实际生产时间线，例如 1920×1080、30p，两者不会混用。项目刷新、打开、切换和“重新验证（只读）”不会改写项目 JSON、素材、FCPXML 或预览。

“Finder 中显示 FCPXML”和“使用 Final Cut Pro 打开”是两个独立操作。后者优先执行 `open -b com.apple.FinalCutApp <FCPXML>`，失败时回退 `/Applications/Final Cut Pro Creator Studio.app` 的实际应用路径；所有调用使用参数数组，不拼接 shell 命令。

App 主导航只保留待处理、项目和设置。旧项目数据仍可读取，但不再提供旧版页面、旧版按钮或本地大模型产品入口。本地 ffmpeg / ffprobe 媒体处理能力保留。

当前不提供历史版本系统，也不在原项目内重新生成 HyperFrames。结果中心只聚合已有结构化产物并提供只读操作。

## 准备一期素材

默认待处理根目录是：

```text
~/Desktop/视频待处理/
```

每个子文件夹原则上对应一期。图片和视频可以保留 macOS 或相机默认名称，例如 `屏幕录制 2026-07-16 14.22.31.mov`、`截屏 2026-07-16 14.39.51.png`、`IMG_6382.jpeg`，不需要手动重命名。

可以添加一句可选说明：

```text
本期重点.txt
```

它只是低权重补充信息，不是口播稿或正式标题。主题优先依据实际画面，文件夹名称只作最低权重参考。

扫描、抽帧和构建前后都会记录并核对原始文件路径、大小、修改时间和 SHA-256。CLI 不移动、改名、覆盖、删除或修改待处理目录中的原文件。

## 在 Codex 中使用

Skill 源文件位于 `skills/jiandu`。安装或更新到当前 Codex：

```bash
node scripts/install-video-skill.js
node scripts/install-video-skill.js --check
```

新会话中可以直接说：

```text
使用视频 Skill，处理 ~/Desktop/视频待处理/本期素材
```

也可以说“把这个素材文件夹整理成正式项目”“分析这些录屏并生成 FCPXML”或“用剪渡处理本期素材”。

Skill 会查看图片预览、视频故事板和必要的单帧，生成主题、标题候选、素材采用/淘汰判断、可信度、有效区间、无口播镜头顺序和少量 marker，然后调用正式 CLI 完成项目。

## CLI

查看命令：

```bash
npm run video-skill -- help
```

准备媒体：

```bash
node bin/video-skill.js prepare \
  --source "~/Desktop/视频待处理/本期素材" \
  --json
```

如果稀疏故事板不足以判断某段，可以按区间加密抽帧：

```bash
node bin/video-skill.js inspect-range \
  --manifest "/path/to/manifest.json" \
  --asset-id "media_xxx" \
  --start 12 \
  --end 20 \
  --interval 0.5 \
  --json
```

校验 Codex 分析协议：

```bash
node bin/video-skill.js validate-analysis \
  --manifest "/path/to/manifest.json" \
  --analysis "/path/to/analysis.json" \
  --json
```

创建正式项目：

```bash
node bin/video-skill.js build \
  --manifest "/path/to/manifest.json" \
  --analysis "/path/to/analysis.json" \
  --project-root "~/Desktop/视频素材库" \
  --project-name "本期项目" \
  --json
```

由 App 发起的可视化任务把同一个 `--handoff-task "/absolute/task.json"` 传给 `prepare`、`validate-analysis`、`build` 和 `verify`。Codex-only 决策用 `handoff-update` 写入；观看复核后执行：

```bash
node bin/video-skill.js handoff-complete \
  --handoff-task "/absolute/task.json" \
  --project "~/Desktop/视频素材库/本期项目" \
  --json
node bin/video-skill.js handoff-return \
  --handoff-task "/absolute/task.json" \
  --json
```

默认只生成 FCPXML，不自动打开。只有明确需要时才附加 `--open-fcpxml`。

重新验证已有正式项目：

```bash
node bin/jiandu.js verify --project "/path/to/project" --json
```

### 可选 HyperFrames 适配

HyperFrames 不属于默认生产依赖。未启用时，现有分析、FFmpeg 粗剪和 FCPXML
流程完全不变。需要生成独立标题卡，或根据本期真实素材证明的流程生成
process-flow 独立 MP4 时，先安装锁定版本到当前开发环境或 PATH：

```bash
npm install --no-save --ignore-scripts hyperframes@0.7.63
npm run hyperframes:doctor
```

确认 Node.js、FFmpeg、FFprobe 和 Chrome 四项可用后，显式启用：

```bash
node bin/video-skill.js build \
  --manifest "/path/to/manifest.json" \
  --analysis "/path/to/analysis.json" \
  --project-root "~/Desktop/视频素材库" \
  --project-name "本期项目" \
  --hyperframes \
  --hyperframes-duration 2 \
  --hyperframes-quality standard \
  --json
```

适配层也支持 `--hyperframes-executable` 和 `--hyperframes-browser` 显式路径。
它会关闭遥测，先运行 HyperFrames `check`，再渲染 MP4，并用 ffprobe 校验
时长、生产分辨率和帧率。`doctor.ok` 可能因为 Docker、TTS、BGM 等非必需项
缺失而为 false；剪渡只用本地渲染必需的四项判断可用性。

process-flow 是已实现能力，不只是标题卡描述。使用
`--hyperframes-flow <流程.json>` 提供 3–6 个短节点、真实原因和
`insertAfterShotId`；生成动画会在该镜头之后作为独立素材插入。HyperFrames
仍默认关闭，只有用户明确启用时才运行，项目结果中心不提供重新渲染按钮。

Stage 4D 的 `auto` 不等同于默认生成。Codex 必须先检查真实素材时间线的主题、衔接、工具切换和结果解释，再比较普通剪辑、单条轻字幕和普通转场。只有存在具体表达缺口且动画明显更有效时才启用。渲染后必须实际观看，检查运动、缓动、排版、黑帧、抖动、拉伸、前后镜头衔接和风格一致性；不合格时返工，仍不提升成片则放弃。

当前没有把 HyperFrames 固定为 Electron 生产依赖：`0.7.63` 的传递依赖
`adm-zip<0.6.0` 命中
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)，
npm 暂无自动修复。适配仅处理剪渡生成的可信 composition，不接收外部 ZIP。
完整审计与 A/B 验收见 `docs/hyperframes-audit.md`。

所有命令使用参数数组调用媒体工具，错误输出是结构化 JSON，并使用非零退出码区分输入/协议错误、构建错误和完整性错误。

## 正式项目产物

实际项目仍复用现有四目录结构：

```text
项目名/
├─ 00-项目总控/
├─ 01-精选素材/
├─ 02-配音字幕/
└─ 03-导出/
```

Codex 工作流增加的正式文件：

```text
00-项目总控/
├─ project.json
├─ assets.json
├─ Codex视频素材清单.json
├─ Codex视频分析.json
├─ Codex视频状态.json
├─ Codex视频项目摘要.md
└─ HyperFrames/title-card/        # 显式启用标题卡时
   或 HyperFrames/process-flow/  # 显式启用流程解释时
   ├─ index.html
   └─ render-input.json
01-精选素材/
└─ HyperFrames-片头-<标题>.mp4
   或 HyperFrames-流程解释-<标题>-<指纹>.mp4
03-导出/
├─ FCPXML/<标题>.fcpxml
└─ 粗剪预览/<标题>-roughcut-preview.mp4
```

`01-精选素材` 保存被时间线采用的独立素材副本，并通过现有 `assets.json` 机制登记。FCPXML 直接引用这些独立素材，因此导入 Final Cut Pro 后可以单独移动、删除、缩短、拉长、调速、裁切和调整音量。粗剪 MP4 只用于检查顺序、节奏、黑屏和错误镜头，不能替代 FCPXML。

启用 HyperFrames 时，标题卡或 process-flow MP4 同样位于 `01-精选素材`，拥有独立哈希、
独立 stable ID 和独立 FCPXML asset/clip；它不会被烘焙进原始录屏，也不会
让 FCPXML 改为引用整条粗剪预览。标题卡插在开头；process-flow 按
`insertAfterShotId` 插入，只有其后的 marker 会移动。

发布精修项目可以只读复用一个已验证的 HyperFrames 项目，不重新渲染动画：

```bash
node bin/video-skill.js build \
  --manifest "/path/to/manifest.json" \
  --analysis "/path/to/release-analysis.json" \
  --project-root "~/Desktop/视频素材库" \
  --project-name "发布精修版" \
  --reuse-hyperframes-project "/path/to/已验收-HyperFrames-项目"
```

该方式创建新的完整项目并复制、登记已验收的独立 MP4 与 composition，不覆盖原项目。

## 分析边界

- 场景抽帧和定时抽帧用于建立可查看的证据，不保证识别每一帧操作。
- 低可信度区间会保守裁剪或标记 `reviewRequired`，应在 FCP 中复核。
- 空视频、损坏视频和无法解码素材会保留在清单中并给出降级说明，不会伪造内容。
- 超长视频会限制代表帧数量；对关键区间使用 `inspect-range`。
- marker 是少量定位信息，不是全程字幕。需要中文字幕的入选外文素材必须写入 `lightCaptionPlan`，`build` 自动导出为 FCP 原生可编辑 Title；不要把整篇 HTML 塞成一条字幕，也不要烧录进视频。
- 原生 Title 使用本机 Final Cut Pro 12.3 导出的“基本字幕”结构；无标题项目继续保持 FCPXML 1.10，带标题项目使用 FCPXML 1.14。
- 生成并通过 `xmllint` 校验不等于已经在 Final Cut Pro 中人工导入验证。

## macOS 本机安装版

日常使用不再需要进入仓库或运行 `npm start`：

1. 打开 `/Applications/剪渡.app`；
2. 在“待处理素材”选择一期素材并交给 Codex；
3. Codex 新任务会预填完整提示词，用户按一次发送；
4. 生产完成后通过 `video-cut-planner://` 自动回到已安装 App；（URL scheme 为稳定标识，历史版本兼容，保持不变）
5. 完成短验收后再进入 Final Cut Pro。

正式 App 与开发模式明确共用固定数据目录：

```text
~/Library/Application Support/剪渡
```

历史 handoff、自动打开 FCP 设置和最近项目都保存在此目录。内部资源从
`app.getAppPath()` 与 `process.resourcesPath` 解析；状态、任务和日志不会写入
App Bundle 或 `app.asar`。Codex 深链接的工作目录仍固定为真实源码仓库：

```text
~/Projects/jiandu
```

本机构建、验证、安装与启动：

```bash
npm run package:mac
npm run verify:package
npm run install:mac:local
npm run launch:installed
```

`package:mac` 只生成 arm64 `dir` 目标，开启 ASAR，并使用 electron-builder
完成 ad-hoc 签名。`install:mac:local` 先验证新构建；如已有旧 App，会把经验证
的时间戳备份保存在固定 userData 的 `install-backups/`，再安全替换，失败时恢复。
它不会静默使用 `sudo`，也不会删除 userData、源码仓库或旧备份。

此构建仅供当前 Apple Silicon Mac 本机日常使用：它采用 ad-hoc 签名，未做
Developer ID 签名与 Apple notarization，不是 Gatekeeper 公证的公开分发包；
不生成 DMG、PKG 或自动更新。

## 开发与验证

```bash
npm install
npm test
npm run hyperframes:doctor
npm start
npm run package:mac
npm run verify:package
```

源码开发仍可使用 `npm start` 或 `npm run dev`。项目使用 npm、CommonJS 和
Electron。`ffmpeg` 与 `ffprobe` 继续通过现有环境探测服务从配置、Finder
继承的 PATH、`/opt/homebrew/bin`、`/usr/local/bin` 和系统目录解析，不启动
login shell，也不安装第二套媒体工具。打包产物默认位于
`dist/mac-arm64/剪渡.app`。

常见故障：

- `MEDIA_TOOL_NOT_FOUND`：确认现有 ffmpeg/ffprobe 可执行路径在 PATH 或 Homebrew 常用目录。
- `INVALID_VIDEO_ANALYSIS`：按错误详情修正分析 JSON，不要直接修改项目内部文件。
- `SOURCE_CHANGED_*`：素材在准备后发生变化，重新运行 `prepare`；不要让 CLI 修复原目录。
- `PROJECT_ALREADY_EXISTS`：换一个新项目名，避免覆盖既有正式项目。
- `PROJECT_VERIFICATION_FAILED`：查看 `Codex视频状态.json` 中的素材、FCPXML、预览或原始快照错误。
