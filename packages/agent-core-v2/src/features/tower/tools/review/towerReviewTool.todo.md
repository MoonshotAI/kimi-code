# ITowerReviewTool（towerReviewTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/review/review.ts`（32 行，实现见同目录 reviewTool.ts，100 行；store 侧 submitReview() 在 protocol/store.ts）
- 新架构: `packages/harness-core/src/features/tower/tools/review.ts`（createTowerReviewTool）+ `packages/harness-core/src/features/tower/protocol/store.ts`（submitReview）

## 能力对照

- [x] 输入 schema（target/status 正则/merge 枚举/findings/checks/decision，strict）→ `packages/harness-core/src/features/tower/tools/review.ts`
- [x] 提交资格：仅该 target 的 assigned reviewer（或 tower）可提交；status/merge 格式校验 → `packages/harness-core/src/features/tower/protocol/store.ts`（submitReview）
- [x] 评审落盘：round 自动编号、reviewed_commit 精确 tip 戳、mission 戳、seq 排序、frontmatter+checks/decision 渲染、activity log → 同文件
- [ ] 标准通知自动存储与投递：clean 通知 tower、non-clean 通知 mission owner 并抄送 tower（storedMessages + deliverTowerMessage 唤醒/steer）— 新栈只写评审文件，输出改为提示 reviewer 手动 TowerSend
- [ ] 非 clean 评审把 completed mission 自动翻回 active；tower 提交属 break-glass 须记录原因的文案约束 — 未迁
- [ ] 输出 notified 收件人列表与按 verdict 的合并门 next 指引（merge-ready/hold/fix-then-merge 非批准）— 新栈输出简化为一行提示

## 结论

未对齐 3 项——评审记录与合并门所读的戳（tip/round/mission）对齐；自动通知投递、状态翻回联动与指引文案降级。
