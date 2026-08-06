# Skill 激活支持携带附件(方案 A:全链路)

日期:2026-08-06
状态:待实施

## 背景与根因

桌面端 / Web 输入框里带附件时选中 skill(`/skill:xxx` 或手敲 `/xxx`),附件被**静默丢弃**:skill 直接开跑,文件 chip 还留在输入框里。

四层都不支持附件:

1. `apps/desktop/src/renderer/components/chat/Composer.vue:482` — 命中已知斜杠命令时 `emit('command')` 提前 return,`readyAttachments` 不进 payload,也不 `clearAfterSubmit()`。
2. `App.vue:996` `handleCommand(cmd: string)` — command 事件只有字符串,skill 走 `client.activateSkill(name, args)`(`App.vue:1103`)。
3. `packages/web-core/src/api/daemon/client.ts:1052` — `activateSkill(sessionId, skillName, args?)`,body 无附件字段。
4. daemon 协议 — `kimi-code/packages/kap-server/src/protocol/rest-skill.ts:15` `activateSkillRequestSchema` 只有 `args?: string`;`AgentSkillService.activate`(`agent-core-v2/src/agent/skill/skillService.ts:61`)构造的 user message 固定单个 text part。

底层不是问题:`ContextMessage.content` 是 `ContentPart[]`,普通 prompt 的附件管线可以直接复用。

## 关键设计决策

- **协议字段**:`:activate` body 新增可选 `attachments`,限 image / video / file 三种 part(复用 `kap-server/src/protocol/message.ts` 的 `imageContentSchema` / `videoContentSchema` / `fileContentSchema`),形状与 prompt 提交一致。字段名用 `attachments` 而非 `content`,避免与 skill prompt 本体混淆。
- **附件处理复用 prompt 管线**:`assertPromptFileRefs`(校验 file_id)+ `resolvePromptMediaFiles`(file part 物化为路径引用 text、image/video 读字节压缩)+ `contentToCoreParts`(wire → core parts)目前都是 `kap-server/src/routes/prompts.ts` 的私有函数,提取为共享模块供两条路由复用。
- **追加在 skill prompt 之后**:`AgentSkillService.activate` 把附件 parts append 到渲染出的 skill text part 后面,同一条 user message 进入 turn,origin 仍是 `skill_activation`。
- **TUI / native RPC 不动**:`ActivateSkillRpcInput` 保持 name/args(TUI 无上传附件概念),`SkillActivationInput` 新字段可选,向后兼容。
- **只有 skill 命令带附件**:`/goal` `/swarm` `/btw` `/compact` 等其它命令维持现状(附件留在输入框不清除),不在本期范围。
- **旧 daemon 兼容**:新 client 连旧 daemon 时,旧端点的 strict schema 会直接拒绝未知字段报 40001 —— 可接受(desktop 内嵌 server 随版本走;外部 server 模式属开发场景)。不做静默降级重试。

## 改动清单

### A. kimi-code 仓(工作克隆 `/Users/moonshot/Desktop/moonshot/kimi-code-5`)

先切新分支(当前在 `feat/subagent-model-display`,且有 untracked 的 `apps/kimi-code/dist-web/` 产物,不要动):`git checkout main && git pull && git checkout -b feat/skill-activate-attachments`。

1. `packages/kap-server/src/lib/promptMedia.ts`(新建)— 从 `routes/prompts.ts` 提取 `assertPromptFileRefs` / `resolvePromptMediaFiles` / `contentToCoreParts` 及其私有依赖,`prompts.ts` 改为 import。纯搬移,不改逻辑。
2. `packages/kap-server/src/protocol/rest-skill.ts` — `activateSkillRequestSchema` 加 `attachments: z.array(z.discriminatedUnion('type', [imageContentSchema, videoContentSchema, fileContentSchema])).optional()`。
3. `packages/protocol/src/rest/skill.ts` — 公开契约包同步同一 schema 变更(两处 schema 一向保持一致)。
4. `packages/kap-server/src/routes/skills.ts` — activate 路由:`req.body.attachments` 存在时,依次 `assertPromptFileRefs` → `resolvePromptMediaFiles`(options 的 `resolveOriginalsDir` / `resolveAttachmentsDir` 用 `resolved.handle` 的 `ISessionContext.sessionDir`,与 prompts.ts 相同)→ `contentToCoreParts`,产出的 parts 传给 `activate({ name, args, content })`。
5. `packages/agent-core-v2/src/agent/skill/skill.ts` — `SkillActivationInput` 加 `readonly content?: readonly ContentPart[]`。
6. `packages/agent-core-v2/src/agent/skill/skillService.ts` — `activate` 里 `content = [skillTextPart, ...(input.content ?? [])]`。
7. 测试:`packages/kap-server/test/skills.test.ts` 加 attachments 用例(参照 prompts 测试的 file 附件写法:mock/上传 file store,断言 200 且 message 含附件 part);agent-core-v2 若有 skillService 测试,加 content 透传用例。

### B. code-app 仓(本仓)

8. `packages/web-core/src/api/types.ts:1125` — `activateSkill(sessionId, skillName, args?, attachments?: AppMessageContent[])`(image/video/file 三种 part)。
9. `packages/web-core/src/api/daemon/client.ts:1052` — body 带 `attachments`(用 mappers 里已有的 toWire 转换);无附件时不发该字段。
10. `apps/desktop/src/renderer/composables/client/useWorkspaceState.ts` — 把 `submitPromptInternal` 里 PromptAttachment → content parts 的转换(1985–1996 行)抽成模块级 helper `attachmentsToContent(attachments)`,`submitPromptInternal` 与 skill 路径共用;`startSessionAndActivateSkill`(1638 行)加 `attachments?: PromptAttachment[]` 透传。
11. `apps/desktop/src/renderer/composables/client/useModelProviderState.ts:427` — `activateSkill` 加 `attachments?: PromptAttachment[]`;乐观消息(443 行)content 追加附件 parts(chip 立即显示);调 `getKimiWebApi().activateSkill` 时带上。
12. `apps/desktop/src/renderer/composables/useKimiWebClient.ts` — 透出签名同步。
13. `apps/desktop/src/renderer/components/chat/Composer.vue`:
    - `command` emit 改为 `command: [payload: { cmd: string; attachments: PromptAttachment[] }]`。
    - `handleSubmit` 已知命令分支:仅当命中的是 **skill**(`isSkill` 项或 `skill:` 前缀)时,payload 带 `readyAttachments` 并 `clearAfterSubmit()`;非 skill 命令保持现状(附件留在输入框)。
    - `useSlashMenu` 的 `emitCommand`(bare 命令直发路径)签名跟随,attachments 传 `[]`。
14. `apps/desktop/src/renderer/components/chat/ConversationPane.vue:136`、`ChatDock.vue:77` — emit 声明跟随;`App.vue:996` `handleCommand` 接 payload,skill 分支把 attachments 传给 `activateSkill` / `startSessionAndActivateSkill`;`passCommandGates` 的 auth gate 目前收 `(text, attachments)`,skill 分支同步传入真实附件(不再传 `[]`)。
15. `apps/desktop/src/renderer/composables/messagesToTurns.ts`(969–1038 行)— skill 激活分支:
    - args 只取一次(现在每个 text part 都 push 一次 args,message 多了 notice text 会重复)。
    - 非 skill XML 的 text part 走与普通分支相同的附件恢复:`attachedFileNotice` → file chip、`mediaPathTag` → 媒体附件;image/video part 走 `resolveMediaUrl`。
16. 同步到 `apps/web`:上述 renderer 文件(Composer、ConversationPane、ChatDock、App、useModelProviderState、useWorkspaceState、useKimiWebClient、messagesToTurns)按既有镜像关系同步;web-core 是共享包,一次改动两端生效。
17. 测试更新:`apps/desktop/src/renderer/lib/modelThinking.test.ts`(activateSkill mock 断言)、`apps/desktop/tests/renderer/startSessionAndActivateSkill.test.ts`(签名)、messagesToTurns 渲染测试(`chat-turn-rendering.test.ts` / `turnsProjector.test.ts`,加 skill+附件用例)。
18. changeset:按 `.agents/skills/changeset` 规则写 `patch`,只写 `kimi-code-app`。kimi-code-5 侧的 changeset 按该仓自己的规范处理。

## 验证

1. kimi-code-5:`pnpm --filter @moonshot-ai/kap-server test` + agent-core-v2 相关测试 + typecheck。
2. 双仓联调(AGENTS.md 双仓工作流):kimi-code-5 起 `pnpm dev:server`,code-app `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop:debug`,验证:
   - skill + 图片 / 文件 / 视频一起发送,气泡显示 skill 卡片 + args + 附件 chip,模型回合能读到附件;
   - 无附件 skill 激活回归不变;
   - 非 skill 命令带附件行为不变(附件留在输入框);
   - 亮色 + 暗色下 chip 渲染正常。
3. code-app:`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`。
4. `pnpm --filter kimi-code-web run build` 确认 web 构建过(同步后)。

## 明确不做

- `/goal` `/swarm` `/btw` `/compact` 等内建命令的附件支持。
- TUI / native RPC(`ActivateSkillRpcInput`)的附件字段。
- 旧 daemon 不认识 `attachments` 字段时的降级重试。
