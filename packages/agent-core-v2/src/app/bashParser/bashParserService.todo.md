# IBashParserService（bashParserService）

- v2: `packages/agent-core-v2/src/app/bashParser/bashParser.ts`（约 28 行，读 interface 与 bashParserService.ts 得出；实现是对 `@moonshot-ai/tree-sitter-bash` parse 的 DTO 快照包装）
- 新架构: 无包装服务；消费方直接调用 `packages/tree-sitter-bash` 的 `parse`

## 能力对照

- [x] bash 源码解析（确定性预算 timeoutMs/maxNodes，aborted/hasError 判别结果）→ `packages/tree-sitter-bash`（两栈共用同一引擎包）
- [x] 消费方一：权限危险命令分析 → `packages/harness-core/src/features/permission/analyzers/bash-danger.ts`（直接 import parse）
- [x] 消费方二：AGENTS.md 提醒的 bash 目标提取 → `packages/harness-core/src/features/agentsMdReminder/feature.ts`（直接 import parse）+ `bash-targets.ts` 遍历 SyntaxNode
- [ ] 消费方三：tower 的 Bash 命令守卫（v2 towerService 经 bashParser.parse 做 analyzeTowerBashCommand 越权否决）— 新栈 tower 守卫（`packages/harness-core/src/features/tower/guard.ts`）只做 TodoList/Agent 恢复/写路径三类拦截，不含 bash 命令分析，该消费面未随 tower 迁移（属 tower 域能力缺口，非 parser 本身缺失）

## 结论

未对齐 1 项——parser 能力本体由 tree-sitter-bash 包直接承载且两个消费方已迁；v2 的 tower bash 守卫消费面在新 tower 中不存在。
