# KimiTUI 重构分支 — 合并 main 分析

> 分支：`refactor-kimi-tui`（26 commits）
> 分叉点：`ce420bf` (refactor(tui): unify resume replay rendering #88)
> 分析日期：2026-05-27

---

## 一、分支概况

本分支将 `kimi-tui.ts` 从 6160 行的 God-class 拆分为 1666 行协调器 + 6 个 Controller + 8 个 Command 模块。详见下方「架构变化」章节。

## 二、main 上的新增变更（分叉后 12 个 commit）

### 涉及 TUI 的 6 个 commit（核心冲突来源）

| Commit | 功能 | 改动位置（基于 main 原始结构） |
|---|---|---|
| `73c4232` fix: show original session command after fork (#103) | fork 后提示返回原 session 的命令 | `kimi-tui.ts` — `handleForkCommand` |
| `2e8c417` fix(tui): stop thinking spinner leaking (#97) | 修复空 delta 导致 thinking spinner 泄漏 | `kimi-tui.ts` — `flushThinkingToTranscript` + `onThinkingUpdate` |
| `5587061` feat: expose LLM stream timing events (#101) | debug 模式显示 step timing | `kimi-tui.ts` — 新增 `maybeShowDebugTiming` + `handleStepCompleted` |
| `d03f6f4` feat(tui): add /export-debug-zip (#112) | 新增 `/export-debug-zip` 命令 | `kimi-tui.ts` — 新增 `handleExportDebugZipCommand` + slash dispatch |
| `028d069` feat(tui): add /export-md (#113) | 新增 `/export-md` 命令 + `utils/export-markdown.ts` | `kimi-tui.ts` — 新增 `handleExportMdCommand` + slash dispatch |
| `2c7a8cc` feat(tui): expand paste markers on second paste (#116) | 编辑器二次粘贴展开 paste marker | `components/editor/custom-editor.ts`（无冲突） |

### 不涉及 TUI 的 6 个 commit（自动合并，无冲突）

| Commit | 范围 |
|---|---|
| `6f55f1d` fix(agent-core): route session logs exclusively to session sink | agent-core |
| `d599183` feat(export): record install source and shell environment in manifest | session export |
| `d1c381f` test(agent-core): consolidate test helpers into AgentTestContext | agent-core tests |
| `8b5065c` ci: add pkg.pr.new previews | CI |
| `b7e7404` docs: document /export-md and /export-debug-zip | docs |
| `2b74025` feat: rework permission decision policies (#26) | agent-core permission 系统重写 |

---

## 三、合并冲突预判

运行 `git merge-tree` 结果：

| 文件 | 状态 |
|---|---|
| `apps/kimi-code/src/tui/kimi-tui.ts` | **CONFLICT** — 内容冲突 |
| `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts` | auto-merge（无冲突） |
| 其余 141 个文件 | auto-merge（无冲突） |

### kimi-tui.ts 冲突详解

main 上在旧 `kimi-tui.ts` 中添加了以下内容，但重构分支已将对应代码搬到了不同文件：

| main 上的改动 | 原始位置（main） | 重构后应归属的文件 | 处理方式 |
|---|---|---|---|
| `/export-md` + `/export-debug-zip` slash dispatch case | `kimi-tui.ts` L1592 (slash switch) | `commands/dispatch.ts` | 手动移入 dispatch + 新建 `commands/export.ts` 或放入 `commands/session.ts` |
| `handleExportMdCommand` 方法体 (~40 行) | `kimi-tui.ts` L5526+ | `commands/session.ts` 或新建 `commands/export.ts` | 手动搬迁 |
| `handleExportDebugZipCommand` 方法体 (~25 行) | `kimi-tui.ts` L5526+ | 同上 | 手动搬迁 |
| `flushThinkingToTranscript` bug fix (移除 early return) | `kimi-tui.ts` L1937 | `controllers/streaming-ui.ts` | 手动 apply 修复逻辑 |
| `onThinkingUpdate` guard (空 text + 无组件时 skip) | `kimi-tui.ts` L3728 | `controllers/streaming-ui.ts` | 手动 apply |
| `maybeShowDebugTiming` 新方法 + `handleStepCompleted` 调用 | `kimi-tui.ts` L3003/3041 | `controllers/session-event-handler.ts` | 手动搬迁 |
| `handleForkCommand` 返回提示文案改动 | `kimi-tui.ts` L5526 | `commands/session.ts` | 手动 apply 文案变更 |
| 新 import (`mkdir`, `writeFile`, `pathToFileURL`, `toTerminalHyperlink`, `detectInstallSource`, `detectShellEnvironment`, `buildExportMarkdown`, `formatStepDebugTiming`) | `kimi-tui.ts` 顶部 | 分别加到对应目标文件的 import 区 | 手动处理 |
| `commands/registry.ts` 新增 export-md / export-debug-zip 注册 | `commands/registry.ts` | 同文件（自动合并成功） | 无需处理 |
| `components/editor/custom-editor.ts` paste marker 扩展 | `custom-editor.ts` | 同文件（不涉及重构） | 无需处理 |
| `components/messages/plan-box.ts` 提取 `toTerminalHyperlink` | `plan-box.ts` | 同文件（不涉及重构） | 无需处理 |
| `utils/export-markdown.ts` 新文件 (241 行) | 新文件 | 新文件（自动合并） | 无需处理 |

### 非 TUI 的重大变更（无冲突但需注意）

- **Permission policies 重写** (`2b74025`)：agent-core 的 permission 系统从旧的 monolithic `check-rules.ts` + `policy.ts` 重写为 12 个独立 policy 模块。TUI 层不直接依赖这些内部类型，但 `PermissionMode` 行为可能有细微变化，合并后需跑完整测试。

---

## 四、合并策略建议

### 推荐：merge origin/main → 手动解决 kimi-tui.ts 冲突

1. **`git merge origin/main`** — 触发合并
2. **解决 `kimi-tui.ts` 冲突** — 这个文件的冲突本质是：main 往旧文件加了新功能，重构分支把旧文件拆碎了。git 无法自动匹配。具体操作：
   - 接受重构分支侧的 kimi-tui.ts 结构（丢弃 main 在旧结构上的 hunks）
   - 将 main 的 6 个功能逐一搬入重构后的正确位置（见上表）
3. **处理新文件** — `utils/export-markdown.ts` 会自动带入，无需手动
4. **跑测试** — 确保 export-md / export-debug-zip / thinking spinner fix / debug timing / fork 提示 / paste marker 全部正常

### 工作量估算

| 任务 | 预计耗时 |
|---|---|
| 冲突解决（kimi-tui.ts 接受 ours + 手动搬迁 main 功能） | 30-60 min |
| 新增 export 命令搬入 commands/ | 15-20 min |
| thinking/debug-timing fix 应用到 controllers/ | 10-15 min |
| fork 提示文案 + 测试修复 | 5-10 min |
| 全量测试验证 | 10-20 min |
| **合计** | **~1.5-2 小时** |

---

## 五、重构架构概览（供合并时参考）

### 文件结构

```
kimi-tui.ts (1666 行, 协调器 / Host)
├── controllers/
│   ├── session-event-handler.ts   (921 行) — SDK Event 分发与处理
│   ├── streaming-ui.ts            (749 行) — 流式消息渲染管线
│   ├── session-replay.ts          (467 行) — 历史会话回放
│   ├── tasks-browser.ts           (440 行) — 任务面板
│   ├── editor-keyboard.ts         (291 行) — 编辑器键盘控制
│   └── auth-flow.ts               (133 行) — 认证流程
├── commands/
│   ├── dispatch.ts                (261 行) — 输入分发（slash vs 普通消息）
│   ├── config.ts                  (383 行) — /model, /yolo, /theme 等配置命令
│   ├── auth.ts                    (349 行) — /login, /logout, /connect 命令
│   ├── info.ts                    (185 行) — /usage, /status, /mcp 信息命令
│   ├── prompts.ts                 (183 行) — /init, /feedback 等提示命令
│   ├── session.ts                 (105 行) — /fork, /title 会话命令
│   └── index.ts / registry.ts / parse.ts / resolve.ts / types.ts / skills.ts
├── tui-state.ts                   (100 行) — TUIState 接口 + 工厂函数
├── types.ts                       (+30 行) — 新增启动相关类型
└── utils/startup.ts               (15 行)
```

### Host 接口通信

每个 Controller 定义 `*Host` 接口，`KimiTUI` 以鸭子类型实现：

| Controller | Host 接口 | 关键依赖 |
|---|---|---|
| StreamingUIController | `StreamingUIHost` | state, session, setAppState, patchLivePane, pushTranscriptEntry |
| SessionEventHandler | `SessionEventHost` | state, session, streamingUI, sessionReplay, updateActivityPane |
| SessionReplayRenderer | `SessionReplayHost` | state, session, streamingUI, pushTranscriptEntry |
| TasksBrowserController | `TasksBrowserHost` | state, requestRender |
| AuthFlowController | `AuthFlowHost` | harness, state, startupNotice |
| EditorKeyboardController | `EditorKeyboardHost` | state, session, sendMessage, cancelInFlight |
| SlashCommand dispatch | `SlashCommandHost` | state, harness, session, 各 controller 引用 |

### AppState 字段变化

重构分支移除了 `yolo`（用 `permissionMode` 推导）和 `isStreaming`（用 `streamingPhase` 推导）。合并 main 时注意 main 的新代码是否引用了这两个字段。

---

## 六、合并后 Checklist

- [ ] `/export-md` 命令正常工作
- [ ] `/export-debug-zip` 命令正常工作
- [ ] thinking spinner 不再泄漏（空 delta 场景）
- [ ] debug timing 在 `KIMI_CODE_DEBUG=1` 下显示
- [ ] fork 后显示返回原 session 的提示
- [ ] 二次粘贴 paste marker 展开正常
- [ ] permission policies 重写后权限行为正常
- [ ] `AppState` 无 `yolo` / `isStreaming` 引用残留
- [ ] 全量 `pnpm test` 通过
- [ ] TypeScript 编译无错误
