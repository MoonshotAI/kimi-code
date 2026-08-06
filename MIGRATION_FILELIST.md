# 迁移文件清单（全项目）

> 状态标记：✅ 已存在 / ⏳ 待建 / ⏸ 待退役 / 🔄 待迁移

## A. Rust 已存在 ✅

### crates/kimi-acp（1 rs）
- ✅ crates/kimi-acp/src/lib.rs
### crates/kimi-cli（2 rs）
- ✅ crates/kimi-cli/src/main.rs
- ✅ crates/kimi-cli/tests/cli.rs
### crates/kimi-exec（1 rs）
- ✅ crates/kimi-exec/src/lib.rs
### crates/kimi-oauth（1 rs）
- ✅ crates/kimi-oauth/src/lib.rs
### crates/kimi-protocol（10 rs）
- ✅ crates/kimi-protocol/src/context.rs
- ✅ crates/kimi-protocol/src/goal.rs
- ✅ crates/kimi-protocol/src/hooks.rs
- ✅ crates/kimi-protocol/src/lib.rs
- ✅ crates/kimi-protocol/src/methods.rs
- ✅ crates/kimi-protocol/src/plan.rs
- ✅ crates/kimi-protocol/src/rpc.rs
- ✅ crates/kimi-protocol/src/task.rs
- ✅ crates/kimi-protocol/src/usage.rs
- ✅ crates/kimi-protocol/src/wire_types.rs
### crates/kimi-sdk（8 rs）
- ✅ crates/kimi-sdk/src/auth.rs
- ✅ crates/kimi-sdk/src/catalog.rs
- ✅ crates/kimi-sdk/src/lib.rs
- ✅ crates/kimi-sdk/src/session.rs
- ✅ crates/kimi-sdk/tests/auth.rs
- ✅ crates/kimi-sdk/tests/harness.rs
- ✅ crates/kimi-sdk/tests/probe_cancel.rs
- ✅ crates/kimi-sdk/tests/runtime.rs
### crates/kimi-server（18 rs）
- ✅ crates/kimi-server/src/callbacks.rs
- ✅ crates/kimi-server/src/in_process.rs
- ✅ crates/kimi-server/src/lib.rs
- ✅ crates/kimi-server/src/processor.rs
- ✅ crates/kimi-server/src/request_processors/approval.rs
- ✅ crates/kimi-server/src/request_processors/bg.rs
- ✅ crates/kimi-server/src/request_processors/config.rs
- ✅ crates/kimi-server/src/request_processors/cron.rs
- ✅ crates/kimi-server/src/request_processors/fs.rs
- ✅ crates/kimi-server/src/request_processors/git.rs
- ✅ crates/kimi-server/src/request_processors/health.rs
- ✅ crates/kimi-server/src/request_processors/mod.rs
- ✅ crates/kimi-server/src/request_processors/permission.rs
- ✅ crates/kimi-server/src/request_processors/plugin.rs
- ✅ crates/kimi-server/src/request_processors/session.rs
- ✅ crates/kimi-server/src/request_processors/task.rs
- ✅ crates/kimi-server/src/server.rs
- ✅ crates/kimi-server/src/state.rs
### crates/kimi-server-client（3 rs）
- ✅ crates/kimi-server-client/src/lib.rs
- ✅ crates/kimi-server-client/src/stdio_client.rs
- ✅ crates/kimi-server-client/src/ws_client.rs
### crates/kimi-server-transport（8 rs）
- ✅ crates/kimi-server-transport/src/bin/kimi-server-serve.rs
- ✅ crates/kimi-server-transport/src/http.rs
- ✅ crates/kimi-server-transport/src/lib.rs
- ✅ crates/kimi-server-transport/src/stdio.rs
- ✅ crates/kimi-server-transport/src/websocket.rs
- ✅ crates/kimi-server-transport/tests/http_e2e.rs
- ✅ crates/kimi-server-transport/tests/remote_client.rs
- ✅ crates/kimi-server-transport/tests/ws_e2e.rs
### crates/kimi-tui（8 rs）
- ✅ crates/kimi-tui/src/app.rs
- ✅ crates/kimi-tui/src/bottom_pane.rs
- ✅ crates/kimi-tui/src/chatwidget.rs
- ✅ crates/kimi-tui/src/lib.rs
- ✅ crates/kimi-tui/src/markdown.rs
- ✅ crates/kimi-tui/src/picker.rs
- ✅ crates/kimi-tui/src/streaming.rs
- ✅ crates/kimi-tui/src/theme.rs
### crates/kimi-ui（3 rs）
- ✅ crates/kimi-ui/src/event.rs
- ✅ crates/kimi-ui/src/lib.rs
- ✅ crates/kimi-ui/src/render.rs

## B. Rust 待建 ⏳

### crates/kimi-state
- ⏳ crates/kimi-state/src/lib.rs
- ⏳ crates/kimi-state/src/store.rs
- ⏳ crates/kimi-state/src/session_record.rs
- ⏳ crates/kimi-state/src/schema.rs

### crates/kimi-config
- ⏳ crates/kimi-config/src/lib.rs
- ⏳ crates/kimi-config/src/toml.rs
- ⏳ crates/kimi-config/src/env.rs
- ⏳ crates/kimi-config/src/diagnostics.rs

### crates/kimi-protocol/src/export.rs
- ⏳ crates/kimi-protocol/src/export.rs（ts-rs/schemars TS 绑定）

### crates/utils/*
- ⏳ crates/utils/（微 crate，对齐 codex）

## C. kimi-core（重构，长期）🔄

> 从 kimi-agent 拆分重组：agent/ session/ tools/ context/ goal/ plan/ approval/ permission/ mcp/ skill/ compact/ llm/ shell_command/ git/ media/ cron/ background/ task/ plugin/ config/ usage/ oauth/ kaos/ client.rs

## D. TS 待退役 ⏸（G-6）

### packages/node-sdk（113 ts）→ retired/
- ⏸ packages/node-sdk/examples/kimi-harness-auth-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-cancel-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-config-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-export-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-list-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-log-marker.ts
- ⏸ packages/node-sdk/examples/kimi-harness-logging-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-prompt-demo.ts
- ⏸ packages/node-sdk/examples/kimi-harness-rename-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-set-model-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-set-permission-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-set-thinking-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-smoke.ts
- ⏸ packages/node-sdk/examples/kimi-harness-steer-smoke.ts
- ⏸ packages/node-sdk/examples/runtime-smoke-helpers.ts
- ⏸ packages/node-sdk/examples/t8-race-create-single.ts
- ⏸ packages/node-sdk/examples/t8-race-create.ts
- ⏸ packages/node-sdk/examples/t8-race-direct.ts
- ⏸ packages/node-sdk/src/auth.ts
- ⏸ packages/node-sdk/src/catalog.ts
- ⏸ packages/node-sdk/src/config-rpc.ts
- ⏸ packages/node-sdk/src/events.ts
- ⏸ packages/node-sdk/src/index.ts
- ⏸ packages/node-sdk/src/kimi-code-model-provider.ts
- ⏸ packages/node-sdk/src/kimi-harness.ts
- ⏸ packages/node-sdk/src/legacy/config-schema.ts
- ⏸ packages/node-sdk/src/legacy/config.ts
- ⏸ packages/node-sdk/src/legacy/errors.ts
- ⏸ packages/node-sdk/src/legacy/flags.ts
- ⏸ packages/node-sdk/src/legacy/fs-utils.ts
- …（共 113 文件）

### packages/kap-server（156 ts）→ retired/
- ⏸ packages/kap-server/src/di.ts
- ⏸ packages/kap-server/src/envelope.ts
- ⏸ packages/kap-server/src/error-handler.ts
- ⏸ packages/kap-server/src/i18n-locales/en.ts
- ⏸ packages/kap-server/src/i18n-locales/zh.ts
- ⏸ packages/kap-server/src/i18n.ts
- ⏸ packages/kap-server/src/index.ts
- ⏸ packages/kap-server/src/instanceRegistry.ts
- ⏸ packages/kap-server/src/lib/fileLaunch.ts
- ⏸ packages/kap-server/src/lib/httpRange.ts
- ⏸ packages/kap-server/src/lib/requestLog.ts
- ⏸ packages/kap-server/src/middleware/auth.ts
- ⏸ packages/kap-server/src/middleware/defineRoute.ts
- ⏸ packages/kap-server/src/middleware/hostnames.ts
- ⏸ packages/kap-server/src/middleware/origin.ts
- ⏸ packages/kap-server/src/middleware/rateLimit.ts
- ⏸ packages/kap-server/src/middleware/schema.ts
- ⏸ packages/kap-server/src/middleware/securityHeaders.ts
- ⏸ packages/kap-server/src/middleware/validate.ts
- ⏸ packages/kap-server/src/openapi/transforms.ts
- ⏸ packages/kap-server/src/protocol/approval.ts
- ⏸ packages/kap-server/src/protocol/asyncapi.ts
- ⏸ packages/kap-server/src/protocol/display.ts
- ⏸ packages/kap-server/src/protocol/envelope.ts
- ⏸ packages/kap-server/src/protocol/error-codes.ts
- ⏸ packages/kap-server/src/protocol/events-zod.ts
- ⏸ packages/kap-server/src/protocol/goal.ts
- ⏸ packages/kap-server/src/protocol/message.ts
- ⏸ packages/kap-server/src/protocol/pagination.ts
- ⏸ packages/kap-server/src/protocol/question.ts
- …（共 156 文件）

### packages/acp-adapter（61 ts）→ retired/
- ⏸ packages/acp-adapter/src/approval.ts
- ⏸ packages/acp-adapter/src/auth-methods.ts
- ⏸ packages/acp-adapter/src/builtin-commands.ts
- ⏸ packages/acp-adapter/src/config-options.ts
- ⏸ packages/acp-adapter/src/convert.ts
- ⏸ packages/acp-adapter/src/events-map.ts
- ⏸ packages/acp-adapter/src/index.ts
- ⏸ packages/acp-adapter/src/kaos-acp.ts
- ⏸ packages/acp-adapter/src/legacy-model.ts
- ⏸ packages/acp-adapter/src/legacy-types.ts
- ⏸ packages/acp-adapter/src/log-guard.ts
- ⏸ packages/acp-adapter/src/marker.ts
- ⏸ packages/acp-adapter/src/mcp.ts
- ⏸ packages/acp-adapter/src/model-catalog.ts
- ⏸ packages/acp-adapter/src/modes.ts
- ⏸ packages/acp-adapter/src/question.ts
- ⏸ packages/acp-adapter/src/server.ts
- ⏸ packages/acp-adapter/src/session.ts
- ⏸ packages/acp-adapter/src/slash.ts
- ⏸ packages/acp-adapter/src/types.ts
- ⏸ packages/acp-adapter/src/v1-compat.ts
- ⏸ packages/acp-adapter/src/version.ts
- ⏸ packages/acp-adapter/test/_helpers/harness-stubs.ts
- ⏸ packages/acp-adapter/test/approval-cancel.test.ts
- ⏸ packages/acp-adapter/test/approval-display.test.ts
- ⏸ packages/acp-adapter/test/approval-plan-review.test.ts
- ⏸ packages/acp-adapter/test/approval.test.ts
- ⏸ packages/acp-adapter/test/auth-gate.test.ts
- ⏸ packages/acp-adapter/test/cancel.test.ts
- ⏸ packages/acp-adapter/test/config-options.test.ts
- …（共 61 文件）

### packages/oauth（40 ts）→ retired/
- ⏸ packages/oauth/examples/kimi-oauth-smoke.ts
- ⏸ packages/oauth/src/api-error.ts
- ⏸ packages/oauth/src/constants.ts
- ⏸ packages/oauth/src/custom-registry.ts
- ⏸ packages/oauth/src/errors.ts
- ⏸ packages/oauth/src/identity.ts
- ⏸ packages/oauth/src/index.ts
- ⏸ packages/oauth/src/managed-feedback-upload.ts
- ⏸ packages/oauth/src/managed-feedback.ts
- ⏸ packages/oauth/src/managed-kimi-code.ts
- ⏸ packages/oauth/src/managed-usage.ts
- ⏸ packages/oauth/src/model-alias-merge.ts
- ⏸ packages/oauth/src/oauth-manager.ts
- ⏸ packages/oauth/src/oauth.ts
- ⏸ packages/oauth/src/open-platform.ts
- ⏸ packages/oauth/src/redact.ts
- ⏸ packages/oauth/src/refreshProviderModels.ts
- ⏸ packages/oauth/src/storage.ts
- ⏸ packages/oauth/src/token-state.ts
- ⏸ packages/oauth/src/toolkit.ts
- ⏸ packages/oauth/src/types.ts
- ⏸ packages/oauth/src/utils.ts
- ⏸ packages/oauth/test/custom-registry.test.ts
- ⏸ packages/oauth/test/helpers.ts
- ⏸ packages/oauth/test/identity.test.ts
- ⏸ packages/oauth/test/managed-feedback-upload.test.ts
- ⏸ packages/oauth/test/managed-feedback.test.ts
- ⏸ packages/oauth/test/managed-kimi-code.test.ts
- ⏸ packages/oauth/test/managed-usage.test.ts
- ⏸ packages/oauth/test/model-alias-merge.test.ts
- …（共 40 文件）

### packages/protocol（72 ts）→ retired/
- ⏸ packages/protocol/src/__tests__/approval.test.ts
- ⏸ packages/protocol/src/__tests__/envelope.test.ts
- ⏸ packages/protocol/src/__tests__/events.test.ts
- ⏸ packages/protocol/src/__tests__/file.test.ts
- ⏸ packages/protocol/src/__tests__/fs.test.ts
- ⏸ packages/protocol/src/__tests__/message.test.ts
- ⏸ packages/protocol/src/__tests__/model-catalog.test.ts
- ⏸ packages/protocol/src/__tests__/pagination.test.ts
- ⏸ packages/protocol/src/__tests__/question.test.ts
- ⏸ packages/protocol/src/__tests__/request-id.test.ts
- ⏸ packages/protocol/src/__tests__/rest-auth.test.ts
- ⏸ packages/protocol/src/__tests__/rest-file.test.ts
- ⏸ packages/protocol/src/__tests__/rest-fs-browse.test.ts
- ⏸ packages/protocol/src/__tests__/rest-fs.test.ts
- ⏸ packages/protocol/src/__tests__/rest-message.test.ts
- ⏸ packages/protocol/src/__tests__/rest-meta.test.ts
- ⏸ packages/protocol/src/__tests__/rest-prompt.test.ts
- ⏸ packages/protocol/src/__tests__/rest-session.test.ts
- ⏸ packages/protocol/src/__tests__/rest-task.test.ts
- ⏸ packages/protocol/src/__tests__/rest-terminal.test.ts
- ⏸ packages/protocol/src/__tests__/rest-tool.test.ts
- ⏸ packages/protocol/src/__tests__/rest-workspace.test.ts
- ⏸ packages/protocol/src/__tests__/session.test.ts
- ⏸ packages/protocol/src/__tests__/snapshot.test.ts
- ⏸ packages/protocol/src/__tests__/task.test.ts
- ⏸ packages/protocol/src/__tests__/time.test.ts
- ⏸ packages/protocol/src/__tests__/tool.test.ts
- ⏸ packages/protocol/src/__tests__/ws-control.test.ts
- ⏸ packages/protocol/src/approval.ts
- ⏸ packages/protocol/src/asyncapi.ts
- …（共 72 文件）

### packages/kaos（32 ts）→ retired/
- ⏸ packages/kaos/src/current.ts
- ⏸ packages/kaos/src/environment.ts
- ⏸ packages/kaos/src/errors.ts
- ⏸ packages/kaos/src/index.ts
- ⏸ packages/kaos/src/internal.ts
- ⏸ packages/kaos/src/kaos.ts
- ⏸ packages/kaos/src/local.ts
- ⏸ packages/kaos/src/login-shell-path.ts
- ⏸ packages/kaos/src/process.ts
- ⏸ packages/kaos/src/ssh.ts
- ⏸ packages/kaos/src/types.ts
- ⏸ packages/kaos/test/cmd.test.ts
- ⏸ packages/kaos/test/current.test.ts
- ⏸ packages/kaos/test/e2e/concurrent-operations.test.ts
- ⏸ packages/kaos/test/e2e/exec-edge-cases.test.ts
- ⏸ packages/kaos/test/e2e/glob-boundaries-parity.test.ts
- ⏸ packages/kaos/test/e2e/process-lifecycle.test.ts
- ⏸ packages/kaos/test/e2e/ssh-mock.test.ts
- ⏸ packages/kaos/test/e2e/ssh-resolve-path.test.ts
- ⏸ packages/kaos/test/e2e/symlink-stat-parity.test.ts
- ⏸ packages/kaos/test/environment.test.ts
- ⏸ packages/kaos/test/internal.test.ts
- ⏸ packages/kaos/test/local.test.ts
- ⏸ packages/kaos/test/login-shell-path.test.ts
- ⏸ packages/kaos/test/setup.ts
- ⏸ packages/kaos/test/shell.test.ts
- ⏸ packages/kaos/test/spawn-options.test.ts
- ⏸ packages/kaos/test/ssh-create.test.ts
- ⏸ packages/kaos/test/ssh-process.test.ts
- ⏸ packages/kaos/test/ssh.test.ts
- …（共 32 文件）

### packages/kosong（88 ts）→ retired/
- ⏸ packages/kosong/src/capability.ts
- ⏸ packages/kosong/src/catalog.ts
- ⏸ packages/kosong/src/errors.ts
- ⏸ packages/kosong/src/generate.ts
- ⏸ packages/kosong/src/http/undici-agent.ts
- ⏸ packages/kosong/src/index.ts
- ⏸ packages/kosong/src/message.ts
- ⏸ packages/kosong/src/provider.ts
- ⏸ packages/kosong/src/providers/anthropic-profile.ts
- ⏸ packages/kosong/src/providers/anthropic.ts
- ⏸ packages/kosong/src/providers/astron-models.ts
- ⏸ packages/kosong/src/providers/astron.ts
- ⏸ packages/kosong/src/providers/capability-registry.ts
- ⏸ packages/kosong/src/providers/chat-completions-stream.ts
- ⏸ packages/kosong/src/providers/google-genai.ts
- ⏸ packages/kosong/src/providers/index.ts
- ⏸ packages/kosong/src/providers/kimi-files.ts
- ⏸ packages/kosong/src/providers/kimi-schema.ts
- ⏸ packages/kosong/src/providers/kimi.ts
- ⏸ packages/kosong/src/providers/merge-user-messages.ts
- ⏸ packages/kosong/src/providers/native-stream.ts
- ⏸ packages/kosong/src/providers/openai-common.ts
- ⏸ packages/kosong/src/providers/openai-legacy.ts
- ⏸ packages/kosong/src/providers/openai-responses.ts
- ⏸ packages/kosong/src/providers/reasoning-key.ts
- ⏸ packages/kosong/src/providers/request-auth.ts
- ⏸ packages/kosong/src/providers/tool-call-id.ts
- ⏸ packages/kosong/src/tool.ts
- ⏸ packages/kosong/src/usage.ts
- ⏸ packages/kosong/test/anthropic-errors.test.ts
- …（共 88 文件）

## E. apps/kimi-code 待迁移 🔄（G-1/G-3，最大块）

### apps/kimi-code（497 ts）→ kimi-cli/kimi-tui
- 🔄 apps/kimi-code/src/built-in-catalog.ts
- 🔄 apps/kimi-code/src/cli/build-info.ts
- 🔄 apps/kimi-code/src/cli/commands.ts
- 🔄 apps/kimi-code/src/cli/goal-prompt.ts
- 🔄 apps/kimi-code/src/cli/headless-exit.ts
- 🔄 apps/kimi-code/src/cli/native-session-adapter.ts
- 🔄 apps/kimi-code/src/cli/native-session.ts
- 🔄 apps/kimi-code/src/cli/options.ts
- 🔄 apps/kimi-code/src/cli/prompt-render.ts
- 🔄 apps/kimi-code/src/cli/prompt-session.ts
- 🔄 apps/kimi-code/src/cli/run-prompt.ts
- 🔄 apps/kimi-code/src/cli/run-shell.ts
- 🔄 apps/kimi-code/src/cli/rust-engine.ts
- 🔄 apps/kimi-code/src/cli/session-engine.ts
- 🔄 apps/kimi-code/src/cli/startup-error.ts
- 🔄 apps/kimi-code/src/cli/sub/acp.ts
- 🔄 apps/kimi-code/src/cli/sub/doctor.ts
- 🔄 apps/kimi-code/src/cli/sub/export.ts
- 🔄 apps/kimi-code/src/cli/sub/login-flow.ts
- 🔄 apps/kimi-code/src/cli/sub/login.ts
- 🔄 apps/kimi-code/src/cli/sub/plugin-run-node.ts
- 🔄 apps/kimi-code/src/cli/sub/provider.ts
- 🔄 apps/kimi-code/src/cli/sub/upgrade.ts
- 🔄 apps/kimi-code/src/cli/sub/vis.ts
- 🔄 apps/kimi-code/src/cli/sub/web/access-urls.ts
- 🔄 apps/kimi-code/src/cli/sub/web/deprecated-server.ts
- 🔄 apps/kimi-code/src/cli/sub/web/index.ts
- 🔄 apps/kimi-code/src/cli/sub/web/legacy-kill.ts
- 🔄 apps/kimi-code/src/cli/sub/web/networks.ts
- 🔄 apps/kimi-code/src/cli/sub/web/rotate-token.ts
- 🔄 apps/kimi-code/src/cli/sub/web/run.ts
- 🔄 apps/kimi-code/src/cli/sub/web/shared.ts
- 🔄 apps/kimi-code/src/cli/telemetry.ts
- 🔄 apps/kimi-code/src/cli/update/cache.ts
- 🔄 apps/kimi-code/src/cli/update/cdn.ts
- 🔄 apps/kimi-code/src/cli/update/install-lock.ts
- 🔄 apps/kimi-code/src/cli/update/install-state.ts
- 🔄 apps/kimi-code/src/cli/update/preflight.ts
- 🔄 apps/kimi-code/src/cli/update/prompt.ts
- 🔄 apps/kimi-code/src/cli/update/refresh.ts
- …（共 497 文件）

---
总计：
- packages/node-sdk: 113 ts 待退役
- packages/kap-server: 156 ts 待退役
- packages/acp-adapter: 61 ts 待退役
- packages/oauth: 40 ts 待退役
- packages/protocol: 72 ts 待退役
- packages/kaos: 32 ts 待退役
- packages/kosong: 88 ts 待退役
- apps/kimi-code: 497 ts 待迁移
