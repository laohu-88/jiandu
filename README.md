# 视频剪辑编排器 v3

Electron 视频项目管理与剪辑编排工具。当前新增的 Codex 视频工作流面向软件操作录屏、开发过程、功能前后对比、截图、测试证据和成品展示，不依赖口播、配音、全程字幕或固定分段模板。

## Codex 视频工作流

```text
一期待处理素材文件夹
→ v3 CLI 探测媒体、抽帧并生成故事板
→ Codex 查看实际画面并生成结构化分析
→ v3 共享核心创建正式项目并登记素材
→ 可选：HyperFrames 根据现有分析生成独立标题卡 MP4
→ 独立素材组成的可编辑 FCPXML
→ 粗剪预览 MP4
→ Final Cut Pro 精修
```

CLI 和 Electron IPC 调用同一组 `src/services`，不会复制项目创建、素材登记、FCPXML、预览或验证逻辑。CLI 不接入外部模型；主题、标题、素材判断和镜头顺序由当前 Codex 会话完成。

## 准备一期素材

默认待处理根目录是：

```text
/Users/example/Desktop/视频待处理/
```

每个子文件夹原则上对应一期。图片和视频可以保留 macOS 或相机默认名称，例如 `屏幕录制 2026-07-16 14.22.31.mov`、`截屏 2026-07-16 14.39.51.png`、`IMG_6382.jpeg`，不需要手动重命名。

可以添加一句可选说明：

```text
本期重点.txt
```

它只是低权重补充信息，不是口播稿或正式标题。主题优先依据实际画面，文件夹名称只作最低权重参考。

扫描、抽帧和构建前后都会记录并核对原始文件路径、大小、修改时间和 SHA-256。CLI 不移动、改名、覆盖、删除或修改待处理目录中的原文件。

## 在 Codex 中使用

Skill 源文件位于 `skills/video-cut-planner`。安装或更新到当前 Codex：

```bash
node scripts/install-video-skill.js
node scripts/install-video-skill.js --check
```

新会话中可以直接说：

```text
使用视频 Skill，处理 /Users/example/Desktop/视频待处理/本期素材
```

也可以说“把这个素材文件夹整理成 v3 项目”“分析这些录屏并生成 FCP 粗剪”或“用视频剪辑编排器处理本期素材”。

Skill 会查看图片预览、视频故事板和必要的单帧，生成主题、标题候选、素材采用/淘汰判断、可信度、有效区间、无口播镜头顺序和少量 marker，然后调用正式 CLI 完成项目。

## CLI

查看命令：

```bash
npm run video-skill -- help
```

准备媒体：

```bash
node bin/video-skill.js prepare \
  --source "/Users/example/Desktop/视频待处理/本期素材" \
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
  --project-root "/Users/example/Desktop/视频素材库" \
  --project-name "本期项目" \
  --json
```

默认只生成 FCPXML，不自动打开。只有明确需要时才附加 `--open-fcpxml`。

重新验证已有正式项目：

```bash
node bin/video-skill.js verify --project "/path/to/v3-project" --json
```

### 可选 HyperFrames 适配

HyperFrames 不属于默认生产依赖。未启用时，现有分析、FFmpeg 粗剪和 FCPXML
流程完全不变。需要根据 `titles.recommended` 和 `theme.summary` 生成独立标题卡
MP4 时，先安装锁定版本到当前开发环境或 PATH：

```bash
npm install --no-save --ignore-scripts hyperframes@0.7.63
npm run hyperframes:doctor
```

确认 Node.js、FFmpeg、FFprobe 和 Chrome 四项可用后，显式启用：

```bash
node bin/video-skill.js build \
  --manifest "/path/to/manifest.json" \
  --analysis "/path/to/analysis.json" \
  --project-root "/Users/example/Desktop/视频素材库" \
  --project-name "本期项目" \
  --hyperframes \
  --hyperframes-duration 2 \
  --hyperframes-quality standard \
  --json
```

适配层也支持 `--hyperframes-executable` 和 `--hyperframes-browser` 显式路径。
它会关闭遥测，先运行 HyperFrames `check`，再渲染 MP4，并用 ffprobe 校验
时长、生产分辨率和帧率。`doctor.ok` 可能因为 Docker、TTS、BGM 等非必需项
缺失而为 false；v3 只用本地渲染必需的四项判断可用性。

当前没有把 HyperFrames 固定为 Electron 生产依赖：`0.7.63` 的传递依赖
`adm-zip<0.6.0` 命中
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)，
npm 暂无自动修复。适配仅处理 v3 生成的可信 composition，不接收外部 ZIP。
完整审计与 A/B 验收见 `docs/hyperframes-audit.md`。

所有命令使用参数数组调用媒体工具，错误输出是结构化 JSON，并使用非零退出码区分输入/协议错误、构建错误和完整性错误。

## 正式 v3 项目产物

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
└─ HyperFrames/title-card/        # 仅显式启用时
   ├─ index.html
   └─ render-input.json
01-精选素材/
└─ HyperFrames-片头-<标题>.mp4    # 独立登记、独立校验
03-导出/
├─ FCPXML/<标题>.fcpxml
└─ 粗剪预览/<标题>-roughcut-preview.mp4
```

`01-精选素材` 保存被时间线采用的独立素材副本，并通过现有 `assets.json` 机制登记。FCPXML 直接引用这些独立素材，因此导入 Final Cut Pro 后可以单独移动、删除、缩短、拉长、调速、裁切和调整音量。粗剪 MP4 只用于检查顺序、节奏、黑屏和错误镜头，不能替代 FCPXML。

启用 HyperFrames 时，标题卡 MP4 同样位于 `01-精选素材`，拥有独立哈希、
独立 v3 stable ID 和独立 FCPXML asset/clip；它不会被烘焙进原始录屏，也不会
让 FCPXML 改为引用整条粗剪预览。原 marker 会按标题卡时长整体后移。

## 分析边界

- 场景抽帧和定时抽帧用于建立可查看的证据，不保证识别每一帧操作。
- 低可信度区间会保守裁剪或标记 `reviewRequired`，应在 FCP 中复核。
- 空视频、损坏视频和无法解码素材会保留在清单中并给出降级说明，不会伪造内容。
- 超长视频会限制代表帧数量；对关键区间使用 `inspect-range`。
- marker 是少量轻字幕建议，不是全程字幕标题层。
- 生成并通过 `xmllint` 校验不等于已经在 Final Cut Pro 中人工导入验证。

## 开发与验证

```bash
npm install
npm test
npm run hyperframes:doctor
npm start
npm run build:mac
```

项目使用 npm、CommonJS 和 Electron。`ffmpeg` 与 `ffprobe` 继续通过现有环境探测服务从 PATH 或 Homebrew 常用路径解析，不安装第二套媒体工具。打包产物默认位于 `dist/mac-arm64/视频剪辑编排器 v3.app`。

常见故障：

- `MEDIA_TOOL_NOT_FOUND`：确认现有 ffmpeg/ffprobe 可执行路径在 PATH 或 Homebrew 常用目录。
- `INVALID_VIDEO_ANALYSIS`：按错误详情修正分析 JSON，不要直接修改项目内部文件。
- `SOURCE_CHANGED_*`：素材在准备后发生变化，重新运行 `prepare`；不要让 CLI 修复原目录。
- `PROJECT_ALREADY_EXISTS`：换一个新项目名，避免覆盖既有正式项目。
- `PROJECT_VERIFICATION_FAILED`：查看 `Codex视频状态.json` 中的素材、FCPXML、预览或原始快照错误。
