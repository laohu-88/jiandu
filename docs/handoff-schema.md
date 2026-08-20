# 剪渡任务交接

剪渡只使用 Codex 作为可执行 provider。任务快照、attempt、心跳、分析验证、revision、结果路径和回流状态都保存在 Application Support 的 handoffs 目录。

任务状态包括 `draft`、`ready`、`launching_codex`、`awaiting_user_send`、分析/构建/验证阶段，以及 `completed`、`completed_with_warnings`、`failed`、`cancelled`。

历史数据会以只读兼容方式读取；未知或已移除的 provider 状态不会重新执行。
