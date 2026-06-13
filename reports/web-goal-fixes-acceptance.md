# Web TODO 修复验收简报

> 验收范围：`c8b16e8e..HEAD`，分支 `feat/web`，当前最终 ahead 17。
> 方法：以代码静态分析和小实验为主，测试只作为防拼写/接口断裂的烟雾检查。

## 结论

整体可以验收。发现并补了 2 个明显问题，均已追加进对应 commit：

1. `90b11087`（P1-9）：原修复只把前端 diff 报错静音，且 files tab 仍隐藏；已补上 `fs:diff` 协议、server route、service 实现、stub 和 files tab 非 git 分支处理。
2. `76d12cf6`（P2-12）：slash skill 激活后，在 `turn.started` 到来前没有本地 in-flight 防线；已补乐观 user turn、发送态和队列保护，失败会回滚。

其余 commit 没看到需要追加修正的明显问题。

## 最终 commit 验收

| commit | 问题 | 结论 |
|---|---|---|
| `c6a4f264` | P0-1 ws 重连后流式恢复 | 通过。`turn.ended` 清 per-turn offset，`offset===0` 自愈只覆盖漏掉新 turn 边界的情况，缺口仍触发 resync。 |
| `4154fc0b` | P0-2 模型切换失败回滚 | 通过。失败时回滚到旧 model；成功后的 status refresh 失败不会误回滚。 |
| `e9f3b246` | P0-3 thinking 期间上滑被拉回底部 | 通过。抑制窗口只留给 smooth scroll，同步 streaming scroll 不再吞用户上滑。 |
| `88ae65bb` | P0-4 tool spinner 残留 | 通过。只有 session active 时保留 final running tool；idle 后会收尾，避免永久转圈。 |
| `176d3d87` | P1-5 手动中断反馈 | 通过。Esc 和停止按钮统一走 `handleInterrupt()`。 |
| `980ff9d4` | P2-10 月亮占位消失时机 | 通过。首个 `assistantDelta` / `messageUpdated` 会清 `sendingBySession`。 |
| `71f80cad` | P2-11 markdown 表格 hover | 通过。选择器改成 `.table-node` 类并覆盖 scoped hover 背景。 |
| `9414ba4e` | P1-6 tool call 渲染 | 通过。展开体不重复 summary；相邻 `.box` 在 `ChatPane.vue` 用 CSS 合并，media card 不受影响。 |
| `a195dff7` | P1-8 审批和提问统一 dock | 通过。question 优先，approval 复用同一 dock 槽位，事件仍直接向外 emit。 |
| `76d12cf6` | P2-12 slash skills | 已追加修正后通过。补本地 in-flight、乐观 skill activation chip、失败回滚；下一条 prompt 会进 queue。 |
| `4b0eae5a` | P2-13 Add workspace 子目录过滤 | 通过。server/stub 都只返回目录，前端只对当前目录子文件夹做本地过滤。 |
| `481bfa0d` | P2-14 前端错误进入排查日志 | 通过。opt-in 时捕获 window error / unhandled rejection / console error/warn，不影响默认路径。 |
| `0f33d72a` | P2-15 Steer + 图片 | 通过。Composer steer payload 带附件，client 转成 file image content，乐观回显能显示图片。 |
| `da18be33` | P1-7 todo / 后台任务面板 | 通过。todo tab 不可折叠，悬浮 todo 可折叠；tasks 卡分离“打开 tab”和“折叠”。 |
| `90b11087` | P1-9 files tab / diff 报错 | 已追加根因修正后通过。`fs:diff` 端到端补齐，files tab 重新启用；非 git workspace 直接走 All 文件树。原 console.warn 降级保留为局部兜底。 |
| `f6a0ac07` | 原逐 commit 报告 | 文档性质。部分 hash 因本次 autosquash 已更新勘误。 |
| `bedd4f28` | P1-9 对比 + P3 设计 | 文档性质。P1-9 对比里的 stash 建议已被本次实际合入，保留为历史背景；P3 设计仍是未实现设计项。 |

## 小实验

- 在 `/private/tmp` 新建临时 git repo，验证 `git diff HEAD -- path` 对 modified/deleted 的输出，以及 `git diff --no-index -- /dev/null path` 对 untracked/no-commit repo 的输出。
- 结果与 `FsGitService.diff()` 使用方式一致：`--no-index` 有差异时退出码为 `1`，应当按成功 diff 处理。

## 验证记录

- `pnpm --filter @moonshot-ai/kimi-web test`：17 files / 91 tests passed。
- `pnpm --filter @moonshot-ai/kimi-web typecheck`：passed。
- `pnpm --filter @moonshot-ai/protocol typecheck`：passed。
- `pnpm --filter @moonshot-ai/services typecheck`：passed。
- `pnpm --filter @moonshot-ai/server typecheck`：passed。
- `pnpm --filter @moonshot-ai/server exec vitest run test/fs-git.e2e.test.ts`：29 tests passed（需要本地监听，提权后运行）。
- `pnpm --filter @moonshot-ai/kimi-web build`：passed；仍有既有 large chunk warning。
- `pnpm exec oxlint ...`：0 errors，108 warnings（既有风格类 warning 为主）。
- `git diff --check c8b16e8e..HEAD`：clean。
