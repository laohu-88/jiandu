# 视频剪辑编排器 v3

Electron 桌面 App，第 2 阶段版本：`v3.0.0-stage2`。

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

本阶段不包含分段素材选择、素材包同步、粗剪、字幕、FCPXML、发布包或本地 Web 服务。
