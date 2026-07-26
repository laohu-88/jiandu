# Stage 4D / 6B 交接任务

## 存储与安全

任务由 Electron 主进程写入 `<userData>/handoffs/<UUID>.json`，事件写入同名 `.events.ndjson`。快照通过同目录临时文件原子替换；renderer 只能调用受限 IPC，不能指定任意任务文件、任意 URL、任意项目产物或任意 shell。主进程重新扫描默认待处理根和正式项目库后授权操作。

素材必须是 `/Users/example/Desktop/视频待处理` 的真实直属子目录。符号链接越界、内部目录冒充一期、任意 task 路径、项目库外路径和不安全产物路径均拒绝。任务不保存凭证，也不写入 Git 仓库、素材目录或正式项目。

## 剪辑引擎

`engine` 字段区分剪辑引擎，默认 `codex` 以保持旧任务兼容：

- `codex`：现有 Codex 深链接交接，Agent 完成分析到验证的完整闭环。
- `cursor_agent`：Stage 6B Cursor Agent。创建 `<UUID>.cursor-package/` 交接包（任务清单、提示词、路径、预期产物、状态指针、恢复说明），打开 Cursor 并复制提示词；默认分析完成后回流 App，由 App 继续 build / verify。

通用能力复用：任务状态机、heartbeat、prepare / validate-analysis / build / verify、结果中心与 FCP 交接。不复制剪辑算法，不另建分析数据格式。

## 快照字段

`schemaVersion`、`taskId`、`engine`、素材路径/realpath/快照、`appWorkspace`、创建/更新/启动/开始/完成时间、`status`、`stage`、阶段说明/开始时间、心跳、HyperFrames 模式/决策/理由/表达缺口/质量复核、完整 prompt、Codex deep link 或 Cursor 交接包路径、正式项目/产物/验证、警告/错误、回流状态、自动 FCP 设置和最近事件历史。

`status` 与 `stage` 使用同一个受控值。状态只能向前，终态不能被普通阶段覆盖：

```text
draft → ready → launching_codex | launching_cursor → awaiting_user_send
→ scanning_media → extracting_metadata → extracting_frames
→ analyzing_media → planning_story → analysis_complete
→ deciding_hyperframes
→ [designing_hyperframes → rendering_hyperframes → reviewing_hyperframes]
→ building_project → rendering_preview → generating_fcpxml → verifying
→ completed | completed_with_warnings | failed | cancelled
```

`analysis_complete` 表示分析结果已通过协议校验，App 可继续构建；Cursor Agent 默认在此回流。`cancelled` 只允许在未进入生产时使用。运行中超过两分钟无心跳只显示“可能已暂停、等待审批或状态未知”，不自动判失败。

## CLI 协作

- `prepare/validate-analysis/build/verify --handoff-task <task.json>` 在真实执行位置更新确定性阶段。
- `handoff-update` 由 Agent 在观看、语义分析、镜头编排、HyperFrames 判断/设计/复核时调用。
- `validate-analysis` 对 `engine=cursor_agent` 会进入 `analysis_complete` 并写入 manifest/analysis 路径。
- `build` 结束保持 `verifying`，给 Codex 实际播放粗剪和动画。
- `handoff-complete` 重新只读验证项目，读取结果中心结构化数据并写终态。
- `handoff-return` 写回流请求；支持终态与 `analysis_complete`。Electron 文件监听重新读取严格 JSON、校验 task ID 和正式项目路径后置前并打开完成页或续建页。

失败命令将写 `failed`、失败阶段、错误摘要和时间；已有中间项目保留，不修改原素材。警告终态不自动打开 FCP，失败或缺失/无效 FCPXML 禁止打开。重复读取完成结果不得再次覆盖；成功项目不得原地覆盖。
