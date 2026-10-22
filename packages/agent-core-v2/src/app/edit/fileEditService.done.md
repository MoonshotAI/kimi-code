# IFileEditService（fileEditService）

- v2: `packages/agent-core-v2/src/app/edit/fileEdit.ts`（约 23 行，读 interface 与 fileEditService.ts、editService.ts/textModel.ts 得出）
- 新架构: `packages/harness-core/src/features/edit/service.ts`（editFile/applyEdit/TextModel 纯函数）+ `tool.ts`（Edit 工具）

## 能力对照

- [x] 精确字符串替换（单次替换须唯一，replace_all 全量，返回替换计数）→ applyEdit（service.ts；notFound/notUnique 错误文案一致）
- [x] 行尾风格保持（CRLF/LF 归一为模型文本、写回时物化原风格）→ `packages/harness-core/src/features/edit/line-endings.ts`（toModelTextView/materializeModelText）
- [x] 文件读-改-写与错误归一（EISDIR 判「不是文件」、其余错误消息透出）→ editFile（service.ts）
- [x] 向 agent 暴露为 Edit 工具（v2 消费方为 agent 工具层 editTool）→ `packages/harness-core/src/features/edit/tool.ts`（createEditTool 调 editFile）+ feature.ts 的 useAgentTools 挂载；写入前的路径准入见 path-access.ts
- [x] UTF-8 严格解码（v2 readText errors:'strict'）→ editFile 内 `new TextDecoder('utf-8', { fatal: true })`（service.ts）

## 结论

全部对齐——DI 服务转为 edit feature 内的纯函数 + 工具挂载，替换语义、行尾保持与错误行为一致。
