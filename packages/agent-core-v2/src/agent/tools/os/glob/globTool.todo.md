# IGlobTool（globTool）

- v2: `packages/agent-core-v2/src/agent/tools/os/glob/glob.ts`（约 55 行；实现 globTool.ts 约 425 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/os/tools/glob.ts`

## 能力对照

- [x] pattern/head_limit/offset/path/include_ignored 参数面，files-only 结果，include_dirs 兼容忽略 → `packages/harness-core/src/features/os/tools/glob.ts`
- [x] rg 执行语义（--files --hidden --sortr=modified，按修改时间排序）→ `packages/harness-core/src/features/os/tools/glob.ts`、`../rg/run.ts`
- [x] 输出上限截断（MAX_OUTPUT_BYTES）、字符上限 + offset 分页提示、Windows 路径提示（WINDOWS_PATH_HINT）→ `packages/harness-core/src/features/os/tools/glob.ts`
- [x] 审批规则（按 pattern 做 glob 匹配）与 search 文件访问声明 → `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Glob 条目）
- [ ] runtime lease 代际检查（v2 acquire ['fs','process'] 并校验代际）— 决策不迁：新栈为单一 Node 宿主
- [ ] 执行器级统一截断（v2 `agent/toolResultTruncation/toolResultTruncationService.ts` 的头尾整形 + 溢出指针）— 未迁：新栈执行器仅有宿主可选的 maxResultChars 策略且默认未接线，glob 依靠自备分页/截断

## 结论

未对齐 2 项——runtime lease 决策不迁、执行器级统一截断未迁；glob 工具本体能力已对齐。
