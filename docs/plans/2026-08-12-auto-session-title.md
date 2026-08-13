# AI 自动生成 Session 标题 接入计划

> 2026-08-12。目标：code-app（desktop 先行，web 同步）接入 kimi-code 的 AI 标题生成接口，先跑通，策略后调。

## 背景与依赖

kimi-code 侧接口来自 **PR #2351**（`feat: auto-generate session titles via the managed chat_title tool`，分支 `auto-title`，**未合并**；本地工作克隆 `/Users/moonshot/Desktop/moonshot/kimi-code-5` 已 fetch 到 `origin/auto-title`，顶端 commit `f99befd9e`，2026-08-03）。

接口现状（以分支代码为准，PR 描述已过时）：

- **REST**：`POST /api/v1/sessions/{session_id}/title/generate`，无 body 参数。
  - 成功 `{ title }`；session 不存在 → `40401`；无法生成（未登录 managed OAuth / 还没有 prompt / 后端调用失败）→ `40922 SESSION_TITLE_UNAVAILABLE`。
- **core（agent-core-v2 `ISessionTitleService.generateTitle()`）**：取主 agent 前 3 条自然语言 user prompt（各加 `user: ` 前缀，拼接总长 cap 1000 字符）→ managed `/tools` `chat_title`；标题 cap 200 字符；持久化 `titleKind`（`prompt` / `generated` / `custom`），**custom 永不覆盖、generated 不重复生成**；并发合并；401 刷新 token 重试一次；成功后广播 `session.meta.updated`。
- **TUI 自动触发已在 PR 内被删除**（`b3cb0e8b2`），触发完全交给客户端——即本计划要做的事。
- **⚠️ PR 描述里的 `{ "force": true }` 在当前分支代码中不存在**（route 无 body、klient 契约零参数、`generateTitle()` 无参）。需求 3（✨ 覆盖用户手动标题）依赖 force——`titleKind === 'custom'` 时 `generateTitle()` 直接返回 `undefined`（REST 40922）。**需要 kimi-code 侧补 force 支持**（向 #2351 追加或合并后单开 PR）。

code-app 现状（相关既有行为）：

- daemon 已从首条 prompt 派生截断标题并经 `session.meta.updated` → `sessionMetaUpdated` 广播；renderer 收到后刷新侧栏标题。该链路本次复用，AI 标题经同一事件回流，**无需改事件处理**。
- `useWorkspaceState.ts`（submit 成功路径，约 :2105 注释）：前端刻意不本地 PATCH 标题——本地 PATCH 会把 session 标成 `isCustomTitle=true` 并抑制 daemon 的标题。接入 AI 标题后此约束不变：自动触发只调 generate 接口，绝不代写标题。
- desktop 内嵌 server 与 web daemon 均为 kap-server（agent-core-v2），接口可用；仅 v2 引擎有效。
- 未合并前，对旧 server 调该路由会 404——自动触发必须对一切错误静默降级。

## 需求

1. **自动触发**：desktop 自行决定时机调 `title/generate` 生成标题（本会话内成功一次即止）。
2. **用户手动标题优先**：用户改过名的 session 显示用户标题，不被自动生成覆盖——后端 `titleKind=custom` 已保证；前端侧只要维持"不主动 PATCH 标题"的现状即可，无额外改动（回归验证项）。
3. **手动生成入口**：session 改名输入框最右侧加 ✨ 按钮，tooltip "Gen Title"，点击调接口（`force: true`），此时允许覆盖用户手动设置的标题。

## 联调方式（PR 合并前）

```bash
# kimi-code-5 克隆
git checkout auto-title   # 或合并后的 main
KIMI_CODE_CORS_ORIGINS="app://renderer,http://127.0.0.1:5174" pnpm dev:server

# code-app
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop
```

#2351 合并后在 code-app bump submodule（`git add kimi-code && git commit -m "chore: bump kimi-code submodule"`），此后内嵌 server 亦可提供接口。

## 实验性开关（后补，已落地）

整个功能由实验 flag `auto_session_title` 门控，默认关：

- **kimi-code**：`agent-core-v2/session/sessionTitle/flag.ts` 注册（env `KIMI_CODE_EXPERIMENTAL_AUTO_SESSION_TITLE` / 主开关 / config.toml `[experimental] auto_session_title = true`），core 的 `generateTitle` 在 flag 关闭时直接返回 unavailable（40923），route/klient/node-sdk 随之受限。
- **code-app**：✨ 按钮在 flag 关闭时从 rename 输入框隐藏；自动触发（turn 结束重试）同 flag 门控。读取顺序与 `secondary-model` 先例一致：meta 的 `experimental_flags` 优先，持久化的 config `[experimental]` 段兜底。

## 改动

### M1　app-core：API 接入（code-app）

`packages/app-core/src/api/types.ts`（`KimiWebApi`）：

```ts
/** POST /sessions/{id}/title/generate — AI 生成标题（managed chat_title）。
    返回生成的标题；不可用（40922：未登录 managed / 无 prompt / 生成失败）
    或路由不存在（旧 server）时返回 null，调用方静默降级。 */
generateSessionTitle(sessionId: string, input?: { force?: boolean }): Promise<string | null>;
```

`packages/app-core/src/api/daemon/client.ts`（`DaemonKimiWebApi`）：

- 实现 `POST /sessions/{id}/title/generate`，body `{}` 或 `{ force: true }`。
- `DaemonApiError` code `40922` 及 404 → 返回 `null`；其余错误同样吞掉返回 `null`（自动触发路径不允许抛错打扰用户；手动入口由调用方自行决定提示）。
- 标题落地以 `sessionMetaUpdated` 事件回流为准（与 daemon 派生标题同链路），返回值仅供调用方即时使用。

### M2　renderer：自动触发（desktop 先行）

Hook 点：`apps/desktop/src/renderer/composables/client/useWorkspaceState.ts`（web 对应副本 `apps/web/src/composables/client/useWorkspaceState.ts` 同步）。

策略（刻意保持简单，幂等性交给后端）：

- **时机**：每个 **turn 结束边界**（`onMainTurnEnd`）尝试一次，直到成功。不在 prompt 接受时调——`first_turn` 摘录需要首轮 assistant 回复，那一刻还没有。
- **参数**：自动路径固定 `source: 'first_turn'`（首轮 user + 首轮 assistant 正文）；core 严格语义——还没有 assistant 回复时返回 40923，客户端下轮再试。
- **终止条件**（per-session 内存态 `titleGenBySession`）：
  - 成功 → 标 `done`，本会话不再自动调（后端也不会重复生成，双保险）。
  - 连续 `null` 达 3 次 → 标 `giveup`（典型场景：未登录 managed OAuth，避免每个 turn 白打请求）。
  - 任何错误一律静默，无 toast、无重试风暴；fire-and-forget 全程 try/catch 兜底，绝不影响 prompt 主路径。
- 用户已手动改名（custom）的 session：后端返回 40923 → 计入 giveup 计数，天然停止。
- 不新增 UI 状态（无 loading 态）；标题经 `sessionMetaUpdated` 回流刷新。

### M3　renderer：✨ 手动生成按钮（desktop 先行）

`apps/desktop/src/renderer/components/SessionRow.vue`（web 副本同步）：

- 进入 rename 态时整行变为输入框（时间/状态/hover 操作区全部卸载），生成 action 内嵌在输入框右端；图标为新增的 `gen-title` 双星 glyph（`packages/app-client/src/icons/kimi/gen-title.svg`，注册进 icons 注册表；不复用 task 语义的 `sparkles`）。
- tooltip：i18n key（`sidebar.genTitle`，app-i18n `en` = "Gen Title"，`zh` = "生成标题"）。
- 点击行为（不离开 rename 态）：emit `generateTitle: [id, done]`，由上层调 `generateSessionTitle(id, { force: true, source: 'digest' })`——`digest` 摘录（首条 prompt + 最近一轮问答）让多轮后的重生成反映当前话题：
  - 点击即清空输入框并在框内左侧显示三点 wave loading，action 置灰防重入；
  - 成功 → 输入框填入生成的标题（`done(title)`），用户可确认或继续编辑；标题同时经 `sessionMetaUpdated` 回流；
  - `null` → 恢复点击前的文本 + toast 提示不可用（i18n `sidebar.genTitleUnavailable`）。
- 生成中输入框的 blur 只是焦点噪音（点内部 action 也会触发），不处理；**点输入框外任意位置解散**走 document 级 capture pointerdown：生成中 = 取消编辑（生成结果仍经事件落标题/失败 toast），生成后 = 提交语义关闭；填入的生成标题不会被回写成 custom。
- 亮 + 暗色下验证 hover/focus/tooltip/loading；`pnpm --filter kimi-code-web run check:style` 不得新增 findings。

### M4　kimi-code 侧：补 force（阻塞 M3）

- 向 #2351 追加（或合并后单开 PR）：`generateTitle(opts?: { force?: boolean })`——`force` 时跳过 `titleKind === 'custom'|'generated'` 的早退，REST route 接受可选 body `{ "force": true }`，klient/node-sdk 同步透传（PR 描述本就如此承诺，属补齐实现）。
- 工作克隆：`/Users/moonshot/Desktop/moonshot/kimi-code-5`，不在 code-app 的 submodule 里改。

### M5　测试与验证

- `packages/app-core`：client 单测（mock http）——成功返回 title / 40922 → null / 404 → null / 网络错 → null；`force` body 透传。
- renderer：若已有 useWorkspaceState 测试套路，补"submit 成功触发一次、失败按 turn 重试、3 次 giveup、成功即 done"用例；无则手动验证为主。
- 端到端（外部 server 联调）：新 session 发 prompt → 首轮结束后侧栏标题变为 AI 标题；手动改名后再无变化；✨ 点击后覆盖为新标题；退出 managed 登录的 profile 下无任何请求痕迹/报错。
- 双端：desktop 验证完成后同步 `apps/web` 副本并复验。
- `pnpm typecheck && pnpm lint && pnpm test` 通过。

## PR 划分

- **PR-K**（kimi-code-5 克隆）：M4 force 补齐（合入 #2351 或独立 PR）。
- **PR-1**（code-app）：M1 + M2（API + 自动触发）。不依赖 force，可先开发并联调；#2351 合并 + bump submodule 前合入也无害（旧 server 404 静默降级）。
- **PR-2**（code-app）：`chore: bump kimi-code submodule` + M3（✨ 按钮，依赖 force 落地）。
- 每个 code-app PR 走 `changeset` skill，一律 `patch`、只写 `kimi-code-app`。

## 明确不做（本期）

- 不调生成策略（喂 user+assistant、调整条数/长度）——core 常量维持现状，后续再向 kimi-code 提。
- 不做"标题生成中"loading 态、不做设置项开关。
- 不动 web 端品牌/布局等其他分叉点；TUI 侧不回填触发。
