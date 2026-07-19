# HyperFrames × 视频剪辑编排器 v3 审计

审计日期：2026-07-19

## 结论

HyperFrames 可以作为 v3 的可选 HTML→MP4 生成器，但不应替代现有媒体分析、
FFmpeg 粗剪或 FCPXML 生成器。当前接入支持结构化分析驱动的标题卡，也支持
由本期真实素材证明、在指定镜头后插入的 process-flow 流程解释动画。两者都被
当作普通、独立、可删除的 v3 素材。

默认流程保持不变。只有 `build --hyperframes` 会探测和调用外部 CLI。

## 可用性证据

- 官方仓库：<https://github.com/heygen-com/hyperframes>
- npm 发布包：`hyperframes@0.7.63`
- 许可证：Apache-2.0
- 官方要求：Node.js 22+、FFmpeg、Chrome/Chromium
- 本机验证：Node.js 22.23.1、FFmpeg/ffprobe 8.1.1、系统 Chrome
- 真实命令：`doctor --json`、`check --json`、`render`
- 真实产物：H.264 MP4，ffprobe 可读，640×360、30fps、1 秒

HyperFrames 的 `doctor.ok` 会同时受 Docker、whisper-cpp、TTS、BGM 等可选项
影响，因此不能直接作为本地 HTML→MP4 的门禁。适配层只要求 Node.js、FFmpeg、
FFprobe 和 Chrome 四项通过，并把其余失败保留为提示。

## 接入边界

```text
Codex视频分析.json + 可选流程 JSON
  ├─ titles.recommended ──→ 标题
  ├─ theme.summary ───────→ 副标题
  └─ insertAfterShotId ───→ 真实叙事插入点
            │
            ▼
HyperFrames composition + check
            │
            ▼
01-精选素材/HyperFrames-片头-<标题>.mp4
或 HyperFrames-流程解释-<标题>-<指纹>.mp4
  ├─ ffprobe 规格校验
  ├─ SHA-256
  ├─ assets.json stable ID
  └─ FCPXML 独立 asset + 独立 clip
```

composition 源文件和输入/输出记录保存在
`00-项目总控/HyperFrames/title-card/` 或
`00-项目总控/HyperFrames/process-flow/`，便于复查。标题卡镜头放到有效
时间线开头；process-flow 在 `insertAfterShotId` 后插入，只有后续 marker
移动。粗剪预览仍只是审片文件，FCPXML 不引用它。

## 项目结果中心

Electron 默认页会只读聚合 `Codex视频状态.json` 中的 HyperFrames 版本、类型、
动画文件、时长、分辨率、帧率、SHA-256、stable ID、插入位置和 check 状态。
存在 `effectiveAnalysis` 时，列表和详情使用最终时间线，避免把基础 12 镜头
误显示为 HyperFrames 项目的最终 12 镜头；真实 process-flow 项目显示 13 镜头、
29.3 秒。

界面可以播放独立 HyperFrames MP4 并在 Finder 中定位它，但不提供重新渲染或
重新生成按钮。HyperFrames 仍然默认关闭、显式启用且正式保留；未启用时显示
“本期未启用 HyperFrames”，不会被当成故障或废弃能力。

## 真实 A/B 验收

`test/hyperframes-integration.test.js` 构建同一分析的两个正式 v3 项目：

| 项目 | FCPXML 资源 | FCPXML 镜头 | 粗剪时长 |
|---|---:|---:|---:|
| A：原流程 | 1 | 1 | 1 秒 |
| B：启用 HyperFrames | 2 | 2 | 2 秒 |

测试还验证：

- B 的新增 MP4 有独立哈希、stable ID 和媒体元数据；
- B 的 FCPXML 包含 HyperFrames MP4，不包含 `roughcut-preview.mp4`；
- A/B 在 0.2 秒的解码帧 MD5 不同，证明不是只改状态文件；
- B 的 marker 从 0.4 秒平移到 1.4 秒；
- `verify` 可在构建后独立重跑并通过；
- 原始素材路径、大小、mtime 和 SHA-256 全部未变化。

运行：

```bash
node --test test/hyperframes-integration.test.js
```

缺少 HyperFrames 或媒体工具时，该测试明确 skip；本机验收时没有 skip。

## 安全与维护风险

`npm audit --omit=dev` 显示 `hyperframes@0.7.63` 通过
`onnxruntime-node` 依赖 `adm-zip<0.6.0`，命中高危内存耗尽公告
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)，
当前 `fixAvailable: false`。

因此：

- HyperFrames 不写入 v3 的生产/可选依赖清单，不随 Electron 应用打包；
- 使用者按需在可信本地环境安装锁定版本，CLI 可来自 PATH 或显式路径；
- 适配层关闭 HyperFrames 遥测；
- 只生成并读取 v3 自己的 HTML，不导入不可信 ZIP 或外部 composition；
- 升级 HyperFrames 后必须重新运行 doctor、完整测试和 A/B 集成验收。

安装与探测：

```bash
npm install --no-save --ignore-scripts hyperframes@0.7.63
npm run hyperframes:doctor
```
