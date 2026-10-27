# IReadTool（readTool）

- v2: `packages/agent-core-v2/src/agent/tools/os/read/read.ts`（约 51 行；实现 readTool.ts 约 626 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/os/tools/read.ts`

## 能力对照

- [x] 分页参数面（line_offset 正/负、column_offset、n_lines、max_chars 及上限封顶）与 Next Read 续读参数回显 → `packages/harness-core/src/features/os/tools/read.ts`
- [x] kimi-file:// 附件分支 → `packages/harness-core/src/features/os/tools/read.ts`（attachmentReadFs，经 `features/files` 的 KimiFileRegistryRef 接通，见 `../feature.ts`）
- [x] UTF-16 转码（TRANSCODE_MAX_BYTES 上限）、二进制/目录拒绝、状态块（实际范围/总行数/有效 max_chars）→ `packages/harness-core/src/features/os/tools/read.ts`
- [x] 审批规则（按路径的规则匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Read 条目）
- [x] read 配置段（默认/最大 max_chars）→ `packages/harness-core/src/features/os/configSections.ts`（readConfigSection）
- [ ] runtime lease 代际检查 — 决策不迁：新栈为单一 Node 宿主
- [ ] 执行器级统一截断（v2 `agent/toolResultTruncation/toolResultTruncationService.ts` 的头尾整形 + 溢出指针）— 未迁：新栈执行器仅有宿主可选的 maxResultChars 策略且默认未接线，read 依靠自备 max_chars 分页

## 结论

未对齐 2 项——runtime lease 决策不迁、执行器级统一截断未迁；read 工具本体（含 kimi-file:// 附件）已对齐。
