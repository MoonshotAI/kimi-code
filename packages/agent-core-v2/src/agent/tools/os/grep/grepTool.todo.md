# IGrepTool（grepTool）

- v2: `packages/agent-core-v2/src/agent/tools/os/grep/grep.ts`（约 107 行；实现 grepTool.ts 约 748 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/os/tools/grep.ts`

## 能力对照

- [x] 参数面：pattern/path/glob/type/output_mode（content、files_with_matches、count_matches）、-i/-n/-A/-B/-C、head_limit/offset、multiline、include_ignored → `packages/harness-core/src/features/os/tools/grep.ts`
- [x] rg 执行与输出整形（行号、上下文行、计数模式、分页提示）→ `packages/harness-core/src/features/os/tools/grep.ts`、`../rg/run.ts`
- [x] 审批规则（按 pattern 做 glob 匹配）与 search 文件访问声明 → `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Grep 条目）
- [ ] runtime lease 代际检查（v2 acquire ['fs','process'] 并校验代际）— 决策不迁：新栈为单一 Node 宿主
- [ ] 执行器级统一截断（v2 `agent/toolResultTruncation/toolResultTruncationService.ts` 的头尾整形 + 溢出指针）— 未迁：新栈执行器仅有宿主可选的 maxResultChars 策略且默认未接线，grep 依靠自备 head_limit/offset 分页

## 结论

未对齐 2 项——runtime lease 决策不迁、执行器级统一截断未迁；grep 工具本体能力已对齐。
