# 视频剪辑编排器 v3

Electron 桌面 App，第 6 阶段版本：`v3.0.0-stage6`。

## 启动

```bash
npm install
npm start
```

## 当前范围

- 创建、打开项目
- 检查并补齐项目目录
- 扫描 `01-精选素材`
- 自动分配 `A001` 格式编号
- 读取图片和视频基础信息
- 保存 `assets.json` 与 `project.json`
- 生成 `素材简报.md`
- 导入并解析视频方案
- 保存 `video-plan.md` 与 `segments.json`
- 扫描 `02-配音`，按数字前缀匹配分段
- 使用 ffprobe 读取配音时长
- 为每个分段编排素材、时长、显示方式和原声策略
- 自动对齐素材总时长与配音时长
- 同步完整原素材、配音和分段计划到 `03-分段素材包`
- 使用 ffmpeg 生成 1920×1080、30fps 的 H.264/AAC 分段粗剪
- 保存粗剪状态与失败日志
- 合并所有分段粗剪到 `05-总粗剪/full-roughcut.mp4`
- 生成 `00-项目总控/FCP交接清单.md`
- 对 FCP 导出的整片视频生成/整理字幕
- 将字幕统一收纳到 `07-字幕`
- 生成 `final-cn.srt`、`final-cn.txt` 与 `subtitle-report.md`

本阶段不包含分段字幕、烧录字幕、FCPXML、发布包或本地 Web 服务。
