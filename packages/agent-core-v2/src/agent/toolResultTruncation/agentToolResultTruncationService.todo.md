# IAgentToolResultTruncationService（agentToolResultTruncationService）

- v2: `packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncation.ts`（约 26 行，读 interface 与 toolResultTruncationService.ts 实现得出）
- 新架构: 无对应（仅工具内自治）

## 能力对照

- [x] 超长文本结果落盘并给模型指针（spill 文件 + output_path 提示）— 部分等价：`packages/harness-core/src/features/os/tools/bash.ts`（Bash 输出超阈值 spill 到 spillDir，仅 Bash 自治）
- [ ] truncateForModel 统一裁剪面：逐行 2000 字符整形、超 50K 保留前缀落 tool-results 文件、媒体 parts 保留、未落盘时的纯文本回退 — 未迁；agent-core 只有 executor 的 maxResultChars 平切（`packages/agent-core/src/tool/executor.ts` 的 truncateResult）
- [ ] spillExempt 豁免与既有 spill 元数据（outputPath/totalChars/suffix）透传合并 — 随统一裁剪面一并未迁
- [ ] isSpillFilePath/isWireJournalPath 路径判定（供其他域识别 spill 与 wire 日志路径）— 随服务整体未迁

## 结论

未对齐 3 项——统一结果裁剪服务未实施（归属倾向 builtin 机制 + 逐 tool 裁剪）；仅 Bash 工具内自治 spill 与 agent-core 平切兜底。
