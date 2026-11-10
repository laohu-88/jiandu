# Installation / 安装与配置

1. Install Node.js 22 or newer and npm. Install FFmpeg/FFprobe using your normal package manager; verify `node --version`, `npm --version`, `ffmpeg -version`, `ffprobe -version`.
2. Clone the public repository and run `npm ci` in its root. This uses the exact dependency lock; Electron installation downloads its platform binary.
3. Run `npm run check`, `npm test`, and `node bin/jiandu.js help`.
4. Set `JIANDU_HOME` to the absolute repository root and run `node scripts/install-video-skill.js`. Restart the Codex conversation to discover the Skill. `--target /absolute/skills` allows an isolated installation; `--check` verifies an installed copy.
5. Run `npm start` for the Electron interface or use the CLI commands in README.

默认目录以当前用户 home 解析，不依赖开发者电脑路径。配置示例 `examples/cli-config.example.json` 是命令参数说明模板，不会自动作为配置文件加载；把各字段传给对应 CLI 参数。平台配置实际读取 `config/platforms/douyin.json`。不要向仓库写入个人素材、生成项目、状态目录、Token、账号密码或私有 URL。

打包：`npm run package:mac` → `npm run verify:package`。仅本机 arm64 ad-hoc 签名，未公证。安装与启动分别为 `npm run install:mac:local`、`npm run launch:installed`。不要为运行源码关闭系统安全设置。

Troubleshooting: `MEDIA_TOOL_NOT_FOUND` means FFmpeg/FFprobe is not resolvable; `INVALID_VIDEO_ANALYSIS` requires correcting the analysis against the schema; `SOURCE_CHANGED_*` requires preparing the changed media again; `PROJECT_ALREADY_EXISTS` requires a new project name. Do not claim a failed verification succeeded.
