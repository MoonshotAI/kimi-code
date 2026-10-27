# IWorkspaceTrustDisclosure（workspaceTrustDisclosure）

- v2: `packages/agent-core-v2/src/workspace/workspaceTrust/trustDisclosure.ts`（约 35 行，读 interface 与 trustDisclosureService.ts 实现得出）
- 新架构: 无对应（归属宿主层）

## 能力对照

- [ ] describeGatedActivation()——未信任时汇总「信任后将激活」的内容：项目层 MCP server（.mcp.json/.kimi-code/mcp.json，含 transport/command/url/origin）— 未见等价：新栈 untrusted 时项目层根本不加载，management.listServers 也不展示（loadMcpServersDetailed 同样吃静态 trusted）
- [ ] 项目外 additionalDir 与 skill 根目录披露（含来源文件）— 未见等价（原料在：workspaces.additionalDirs、skill roots，但无组装）
- [ ] 指令来源披露（项目内 AGENTS.md 路径、project 技能名、生效的 workspace agent profile 名）— 未见等价
- [x] 承载该能力的信任状态本身 → `packages/harness-core/src/features/workspaces/` 的 trust 投影与 face（getTrust/isTrusted/trust/untrust）

## 结论

未对齐 3 项——「信任前披露将激活内容」整体缺失：归属宿主层组装（legacy node-sdk 的 WorkspaceTrustInfo 走 kap-server RPC），agent-core/harness-core 两包内无等价 facade。
