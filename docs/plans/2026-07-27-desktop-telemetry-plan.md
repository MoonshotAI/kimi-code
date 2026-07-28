# Desktop 埋点方案

> 设计文档，自包含。
> core（agent-core-v2）的埋点管线是共通的，desktop 内嵌 server 模式已接线；本文档重点是 **core 看不到、只有 desktop 宿主（主进程 / renderer）能观测的埋点**。

## 现状

### desktop 现状

- 主进程 `telemetry.ts` 已把 CloudAppender 装到内嵌 server 的 `ITelemetryService`（`server.ts:103` 调用），并打了 `first_launch`、`exit`（带 `duration_ms`）。
- **仅内嵌 server 模式接线**；外部 server 模式（`KIMI_SERVER_URL`）主进程无任何遥测（`connect.ts:71-98`）。
- renderer **零埋点、无上报通道**（`apps/desktop/docs/native-todos.md:117` 明确）；用户操作类事件（cancel/yolo/undo 等）是 renderer 发 RPC 后由 server 侧 core 记录的。

### 缺口

1. 主进程层：内嵌 server 就绪后的 renderer 加载结果、崩溃、菜单/托盘/快捷键、updater 状态机——目前只写本地日志或完全无记录。
2. renderer 层：入口归因、更新漏斗 UI 半段、设置变更、desktop 专属功能采用率、onboarding/登录漏斗——完全空白，且需新建上报通道。

## 已有埋点清单

全部在 `kimi-code/packages/agent-core-v2/src/`，共 41 个事件（`events.ts:444-937` 注册表）。

| 类别 | 事件 | 触发点 |
|---|---|---|
| Turn 生命周期 | `turn_started` / `turn_interrupted` / `turn_ended` | `agent/loop/loopService.ts:392,430,443` |
| 工具调用 | `tool_call` | `toolExecutorService.ts:300` |
| 工具防循环 | `tool_call_dedup_detected` / `tool_call_repeat` | `toolDedupeService.ts:239,298` |
| LLM 请求 | `api_error` | `llmRequesterService.ts:267` |
| 权限 | `permission_policy_decision` / `permission_approval_result` | `permissionGateService.ts:57,86`、`toolApprovalService.ts:145,191` |
| Plan 模式 | `plan_enter_resolved` / `plan_submitted` / `plan_resolved` | `enter-plan-mode.ts:51`、`exit-plan-mode.ts:152,160,169` |
| 压缩/上下文 | `compaction_finished` / `compaction_failed` / `context_projection_repaired` | `fullCompactionService.ts:662,677`、`contextProjectorService.ts:143` |
| 技能/流程 | `skill_invoked` / `flow_invoked` | `skillService.ts:125,130` |
| 用户操作（RPC） | `input_steer` / `cancel` / `conversation_undo` / `yolo_toggle` / `afk_toggle` | `rpcService.ts:109-156` |
| 提问交互 | `question_answered` / `question_dismissed` | `ask-user.ts:257,266` |
| Goal | `goal_created` / `goal_budget_set` / `goal_continued` / `goal_cleared` / `goal_status_changed` | `goalService.ts:387,481,588,910,948` |
| 后台任务 | `background_task_created` / `background_task_completed` | `taskService.ts:996,1004` |
| Profile | `model_switch` / `thinking_toggle` | `profileService.ts:315,318,333` |
| 子代理/MCP | `subagent_created` / `mcp_connected` / `mcp_failed` | `mirrorAgentRun.ts:111`、`sessionMcpService.ts:113,121` |
| Cron | `cron_scheduled` / `cron_fired` / `cron_missed` / `cron_deleted` | `sessionCronServiceImpl` 等 |
| 工具降级 | `grep_tool_rg_fallback` / `glob_tool_rg_fallback` / `fs_grep_node_fallback` | `grep.ts`、`glob.ts`、`fsService.ts:455` |
| 媒体 | `image_compress` / `image_crop` / `video_upload` | kap-server `routes/prompts.ts:262`、`registerMediaTools.ts:76` |
| 会话 | `session_started` / `session_load_failed` | `sessionLifecycleService.ts:261,277` |
| 宿主（desktop 已打） | `first_launch` / `exit` | `apps/desktop/src/main/telemetry.ts:80,88` |

## 计划埋点：主进程

埋点方式（2026-07-27 决策）：desktop 事件契约**本地定义**在 `apps/desktop/src/main/telemetry-events.ts`（`DesktopEventPayloads` 类型表，独立成文件=可单独 review 的数据目录，与上游 `events.ts` 一一对应便于日后机械迁移），经**无类型**的 `ITelemetryService.track` 发出，**不登记 kimi-code 的 `events.ts` 注册表**——kimi-code 是公开仓而 desktop 未发布，注册宿主事件（托盘 / 原生菜单 / updater 等产品面）会提前曝光。`track2` 的注册表约束只是编译期的，运行期管线对事件名零校验，两条路径的 wire 格式完全一致；发布后如需 upstream 统一治理，把 impl 从 `track()` 切回 `track2()` 即可（此时再把事件登记进 `events.ts`）。P0 已实现：facade 在 `src/main/track.ts`（`trackDesktopEvent`，未接线 / 关闭后 no-op）。

| 事件名 | 触发点 | 关键属性 | 回答的问题 | 优先级 |
|---|---|---|---|---|
| `embedded_renderer_load_result` | `connect.ts` 的 embedded `win.loadURL` | `ok`、`error_class`、`duration_ms` | 内嵌 server 已就绪后的 renderer 加载成功率与耗时；不代表完整启动成功率 | P0 ✅ |
| `app_crashed` | `log.ts:148-169` 崩溃守卫 | `kind`(exception/rejection)、`error_name` | 主进程崩溃率 | P0 ✅ |
| `update_status_changed` | `updater.ts:167-209` | `state`、`version` | 更新漏斗主进程半段、失败率 | P0 ✅ |
| `menu_action` | `menu.ts` **仅主进程独占项**（检查更新 / 帮助文档 / 控制台；转发项由 renderer `action_invoked` 覆盖） | `action`(check-for-updates/help-docs/help-console) | 原生菜单使用率 | P1 ✅ |
| `tray_action` | `tray.ts:280-301` | `action`(open-session/show-window/quit)、`pending_count` | 托盘召回率 | P1 ✅ |
| `global_shortcut_invoked` | `shortcuts.ts:51-53` | — | summonApp 使用频次 | P1 ✅ |
| `global_shortcut_register_failed` | `shortcuts.ts:43,55` | `reason`(invalid/conflicted) | 注册失败率（现仅 warn 日志） | P1 ✅ |
| `window_lifecycle` | `window.ts:321-349` | `action`(shown/hidden/closed)（platform 走 context 公共字段，不入事件） | 使用时长、mac 隐藏 vs 退出习惯 | P2 ✅ |
| `native_ipc_used` | `ipc.ts` 仅在成功处理 dialog-open/save、open-in、vibrancy、show-window 后上报；启动同步与能力查询不计 | `channel`（不带 `kimi:` 前缀） | 原生功能使用率总览 | P2 ✅ |

## 计划埋点：renderer

汇聚落点：数据动作埋 `useKimiWebClient.ts:2963` 的 client facade（所有动作必经）；入口归因埋 `App.vue:309` 的 `runShortcutAction`；UI 曝光类才组件级埋点。上报通道见 §5。

| 事件名 | 触发点 | 关键属性 | 回答的问题 | 优先级 |
|---|---|---|---|---|
| `action_invoked` | `App.vue:309` + `:286` | `action`、`source`(shortcut/menu/button/tray) | **入口归因**：同一动作来自键盘/原生菜单/侧栏/托盘哪条路 | P0 ✅ |
| `update_prompt_shown` | `UpdateIndicator.vue:132` | `version` | 更新 pill/弹窗曝光 | P0 ✅ |
| `update_prompt_action` | `UpdateIndicator.vue:114-170` | `action`(skip/download/restart/retry)、`version` | 更新漏斗 UI 半段（与主进程 `update_status_changed` 拼合） | P0 ✅ |
| `onboarding_step` | `OnboardingWizard.vue`（两步 preferences/login） | `step`、`skipped` | onboarding 漏斗与流失步 | P1 ✅ |
| `oauth_login_step` | `useOAuthLoginFlow.ts`（starting/device-code/success/expired/error） | `stage`、终态带 `ok` | 登录成功率与卡点 | P1 ✅ |
| `shortcut_binding_changed` | `ShortcutsPanel.vue` | `action`、`op`(assign/reset/clear/reset_all)（冲突在录制时内联拒绝，`had_conflict` 恒不发） | 自定义快捷键采用率 | P1 ✅ |
| `settings_changed` | `App.vue` 设置 wrapper + `SettingsDialog.vue` + `LanguageSwitcher.vue` + `useUpdateStatus.ts` | `key`(theme/font-size/language/vibrancy/notifications/open-in-default/dock-icon/update-auto-download)、`value`（短枚举） | 主题/语言/vibrancy/Dock 图标/通知等设置分布；auto-download 仅 bridge 成功后计 | P1 ✅ |
| `native_feature_used` | `nativeWorkspacePicker.ts`、`nativeOpenIn.ts`、`App.vue`(workspace_drop) | `feature`(workspace_picker/open_in/workspace_drop)、`fallback`（仅回退路径带 true；dockIcon 并入 settings_changed） | **desktop 专属功能采用率**（web 无对照，验证原生投入价值） | P1 ✅ |
| `approval_decision` | `ApprovalCard.vue`（命名归 `lib/approvalTelemetry.ts`） | `decision`(approve/approveSession/reject/approvePlan/revisePlan/rejectAndExit)、`via`(button/number-key) | 审批交互习惯（core 已有审批结果，这里补 UI 入口维度） | P2 ✅ |
| `session_menu_action` | `ChatHeader.vue`（含头部 openChanges/openPr） | `action`(copyAll/copyFinalSummary/copySessionId/rename/fork/export/archive/openChanges/openPr) | 会话操作使用率 | P2 ✅ |
| `attachment_added` | `useAttachmentUpload.ts` | `via`(drop/click/paste)、`kind`(image/video/file，MIME 分桶；撤回回填不埋） | 附件添加路径 | P2 ✅ |
| `ui_element_toggled` | `ToolDisclosure.vue`(tool_call)、`ThinkingBlock.vue`(thinking_block)（仅用户主动 toggle） | `element`、`expanded` | 详情展开率 | P2 ✅ |

## renderer 上报通道

现有 CloudAppender 是 Node-only，renderer 够不着。已实现（P0）：新增 `kimi:track` IPC——renderer 经 preload 桥 `window.kimiDesktop.track(event, properties)`（`src/renderer/lib/track.ts` 薄封装，无桥 no-op）→ 主进程 `ipc.ts` handler 用 `src/main/track.ts` 的 `asRendererTrackEvent` 做事件白名单 + 逐字段校验（防 renderer 注入任意数据）→ `trackDesktopEvent` 汇入同一管线，复用 consent、deviceId、缓冲、脱敏、失败落盘；单一出口。renderer 可发事件限白名单内 12 个（见上表 renderer 全部），新增需扩 `asRendererTrackEvent` 并在 `telemetry-events.ts` 登记契约。
