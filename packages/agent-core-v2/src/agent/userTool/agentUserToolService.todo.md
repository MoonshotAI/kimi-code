# IAgentUserToolService（agentUserToolService）

- v2: `packages/agent-core-v2/src/agent/userTool/userTool.ts`（约 23 行，读 interface 与 userToolService.ts 得出）
- 新架构: 无对应（仅 interaction 枚举保留 user_tool 种类）

## 能力对照

- [ ] 用户自定义工具的注册/注销/列举（register/unregister/list，含 disclosure）— 新栈两个包内无用户工具注册表；`packages/harness-core/src/features/interaction/interaction.ts` 的 InteractionKind 枚举仍含 `'user_tool'`（传输端口保留），但没有任何 feature 把注册项变成 agent 工具
- [ ] 子代理继承父 agent 用户工具（inheritUserTools，按 activeToolNames 过滤）— 随注册表一并缺失
- [ ] 注册后激活与持久恢复（注册即 addActiveTool、onDidRestore 时按 profile 恢复）— 缺失
- [ ] 调用桥接到宿主执行（执行时发 `user_tool` interaction 请求，由 SDK/客户端回填结果，支持 abort 回填）— v2 由 node-sdk 桥接（legacy）；harness-core 侧仅有 interactions 端口原语，无工具执行到 interaction 的桥接路径

## 结论

未对齐 4 项——用户自定义工具体系（注册/继承/激活/宿主桥接执行）整体未迁，新栈仅保留 user_tool interaction 种类作为传输枚举。
