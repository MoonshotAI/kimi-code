# 多行粘贴误提交解决方案：Bracketed Paste + Paste-Burst Fallback

## 1. 背景

在 iTerm2 + tmux 环境下，向 Kimi Code CLI 输入框粘贴包含换行的文本时，预期行为是整段文本进入输入框；但在某些环境下，回车前的语句会被直接提交执行。

实测结论：

- 当 bracketed paste 标记 `\x1b[200~` / `\x1b[201~` 正常到达时，pi-tui 能正确识别成一次粘贴，不会逐行提交。
- 当 bracketed paste 标记没有到达时，粘贴内容里的 `\r` 会被当成裸 Enter，触发提交。
- 单独的 `\n` 在 pi-tui 的 `Editor` 里会被当成换行插入；单独的 `\r` 才是主要提交来源。

关键代码位置：

- `packages/pi-tui/src/terminal.ts:147`：启动时写入 `\x1b[?2004h`，启用 bracketed paste。
- `packages/pi-tui/src/terminal.ts:412`：退出时写入 `\x1b[?2004l`，关闭 bracketed paste。
- `packages/pi-tui/src/stdin-buffer.ts:315-369`：识别 `\x1b[200~` / `\x1b[201~`，组装 bracketed paste。
- `packages/pi-tui/src/keys.ts:921`：裸 `\r` 被映射成 `enter`。
- `packages/pi-tui/src/components/editor.ts:780`：单独的 `\n` 被当成换行。
- `packages/pi-tui/src/components/editor.ts:792`：`enter` 触发 `submitValue()`。

## 2. 根因

bracketed paste 是由程序主动启用的，流程是：

```text
app 输出 \x1b[?2004h
→ terminal 把粘贴内容包成 \x1b[200~ ... \x1b[201~
→ app 识别标记，整段作为 paste 处理
```

如果中间链路正常：

```text
iTerm2 → tmux → pi-tui
```

粘贴内容会被作为一次 paste，不会逐行提交。

如果 `\x1b[200~` / `\x1b[201~` 没有到达程序，程序只能看到裸字节流：

```text
line1\rline2\rline3\r
```

此时：

- `\r` → `enter` → `submitValue()`
- 于是第一行被直接提交。

需要注意：

- iTerm2 的 “Applications in terminal may access clipboard” 是 OSC 52 剪贴板访问，不是 bracketed paste 开关。
- tmux 的 `set-clipboard` / `allow-passthrough` 主要服务于 OSC 52 / escape passthrough，也不是 bracketed paste 开关。
- 真正决定 bracketed paste 是否生效的是：终端是否在 app 启用 `\x1b[?2004h` 后，把 `\x1b[200~` / `\x1b[201~` 透传给 app。

## 3. 目标

解决方案需要满足：

1. bracketed paste 正常时，多行粘贴作为整体插入，不逐行提交。
2. bracketed paste 失效时，多行粘贴尽量不逐行提交。
3. 不影响正常手敲输入和正常 Enter 提交。
4. 可测试、可关闭、可灰度。
5. 不依赖用户手动修改 tmux 配置作为唯一修复手段。

## 4. 现有实现对比

### 4.1 kimi-code pi-tui

已有：

- 启用 `\x1b[?2004h`
- `StdinBuffer` 识别 `\x1b[200~` / `\x1b[201~`
- `Editor.handlePaste()` 处理粘贴内容

缺少：

- bracketed paste 标记完全没到时的启发式兜底。

### 4.2 oh-my-pi

oh-my-pi 是 pi-tui 的演进 fork，核心机制相同，但健壮性更强：

- 同样启用 `\x1b[?2004h`
- `StdinBuffer` 组装 bracketed paste，性能更好
- 有 paste watchdog，防止结束标记丢失后卡死
- 有 paste byte limit，限制内存
- `bracketed-paste.ts` 解码 tmux extended-keys 重编码的控制字节

但它仍然依赖 bracketed paste 标记到达，**没有解决“标记完全没到”的情况**。

### 4.3 Codex

Codex 的处理最值得参考。它是两层方案：

1. 正常路径：使用 crossterm 的 bracketed paste。
2. 兜底路径：在没有 bracketed paste 的终端上，用 `PasteBurst` 启发式识别“快速连续输入 + Enter”的粘贴突发。

参考：

- [`codex-rs/tui/Cargo.toml`](https://github.com/openai/codex/blob/main/codex-rs/tui/Cargo.toml)
- [`codex-rs/tui/src/tui.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/tui.rs)
- [`codex-rs/tui/src/tui/event_stream.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/tui/event_stream.rs)
- [`codex-rs/tui/src/bottom_pane/paste_burst.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/paste_burst.rs)
- [`codex-rs/tui/src/bottom_pane/chat_composer.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer.rs)

Codex 的 `handle_paste()` 会把 `\r\n` / `\r` 归一化成 `\n`，避免粘贴里的 CR 触发提交。

## 5. 推荐方案

采用两层防御：

```text
第一层：bracketed paste 正常路径
第二层：paste-burst 启发式兜底
```

### 5.1 第一层：保持并增强 bracketed paste

保留现有 bracketed paste 流程，并可从 oh-my-pi backport 以下健壮性改进：

1. tmux extended-keys 重编码解码  
   处理 tmux 在 bracketed paste 内把控制字节重编码成：
   - `\x1b[106;5u`
   - `\x1b[27;5;106~`

2. paste watchdog  
   开始标记到了但结束标记丢失时，不能永远卡在 paste mode。

3. paste byte limit  
   防止异常输入无限增长内存。

4. O(n) paste 组装  
   避免大粘贴时字符串重复拼接导致卡顿。

这些改进能增强“标记到了之后”的稳定性，但不能解决“标记没到”的问题。

### 5.2 第二层：新增 paste-burst 启发式兜底

新增一个 `PasteBurst` 状态机，只在**没有 bracketed paste 标记**时生效，用于识别这种输入：

```text
短时间内连续收到多个普通字符 + Enter
```

典型触发场景：

```text
line1\rline2\rline3\r
```

但没有 `\x1b[200~` / `\x1b[201~` 包裹。

进入 paste-burst 后：

- 普通字符仍然按现有逻辑正常插入，避免改变当前输入体验。
- `PasteBurst` 只记录最近普通字符的时间与数量。
- 当短时间内累计到足够多的普通字符后，接下来的 Enter / `\r` 会被当成换行，而不是提交。
- burst 结束后的短窗口内，Enter 仍按换行处理，避免粘贴末尾的 Enter 误提交。

## 6. PasteBurst 详细设计

### 6.1 放置位置

建议新增：

```text
packages/pi-tui/src/paste-burst.ts
```

由 `Editor` 使用：

```text
packages/pi-tui/src/components/editor.ts
```

理由：

- 裸 `\r` / `\n` 是在 `Editor.handleInput()` 里被解释成 submit / newline 的。
- `StdinBuffer` 只负责序列切分，不应引入输入框语义。
- `PasteBurst` 是纯状态机，便于单独测试。

### 6.2 输入分类

`PasteBurst` 只处理这些输入：

1. 单个可打印字符  
   包括 ASCII、中文、Emoji 等。

2. Enter  
   主要是裸 `\r`。

3. 非字符输入  
   例如方向键、Ctrl/Alt 组合键、popup 导航键等。遇到这些输入时，应调用 `reset()` 清空 burst 状态，再按正常逻辑处理。

不要把带修饰键的输入喂给 `PasteBurst`，避免把快捷键误判成粘贴。

### 6.3 推荐参数

初始值建议参考 Codex，并根据实测调整：

```ts
const PASTE_BURST_MIN_CHARS = 8;
const PASTE_BURST_CHAR_INTERVAL_MS = 8;
const PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS = 30;
const PASTE_ENTER_SUPPRESS_WINDOW_MS = 120;
```

含义：

- `PASTE_BURST_MIN_CHARS`：连续多少个普通字符后才可能是粘贴。
- `PASTE_BURST_CHAR_INTERVAL_MS`：两个字符间隔小于该值才认为属于同一突发。
- `PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS`：进入 burst 后，Enter 在这个窗口内仍按换行处理。
- `PASTE_ENTER_SUPPRESS_WINDOW_MS`：burst 结束后的一小段时间内，Enter 仍按换行处理，避免粘贴末尾的 Enter 误提交。

### 6.4 状态

```text
Idle
PendingFirstChar
Buffering
EnterSuppressWindow
```

状态说明：

- `Idle`：没有最近输入状态。
- `BurstActive`：已经连续收到足够多的快速普通字符，Enter 应按换行处理。
- `EnterSuppressWindow`：burst 结束后的短窗口，Enter 仍按换行处理。

### 6.5 核心方法

建议接口：

```ts
class PasteBurst {
  onPlainChar(now: number): void;
  shouldInsertNewlineInsteadOfSubmit(now: number): boolean;
  extendWindow(now: number): void;
  reset(): void;
}
```

### 6.6 ASCII / 非 ASCII 差异

为了尽量降低对正常手敲的影响，当前实现不 hold 任何字符：

- ASCII 和非 ASCII 字符都立即插入。
- `PasteBurst` 只根据输入时序判断接下来的 Enter 是否应该被当成换行。
- 这样不会引入“先显示一个字符，再突然变成 paste”的闪烁，也不会影响 IME 输入。

### 6.7 与 `Editor.handleInput()` 集成

处理顺序建议：

1. 如果当前输入是 bracketed paste 标记：
   - 走现有 `handlePaste()`。
   - 调用 `pasteBurst.reset()`，避免显式 paste 和 burst 状态互相污染。
2. 如果当前输入不是普通字符、也不是 Enter：
   - 调用 `pasteBurst.reset()`，避免状态泄漏到后续输入。
3. 如果当前输入是裸 Enter：
   - 先保留现有 backslash workaround。
   - 如果 `shouldInsertNewlineInsteadOfSubmit(now)` 为 true，则 `addNewLine()`，并 `extendWindow(now)`。
   - 否则走原来的 submit 逻辑。
4. 如果当前输入是单个可打印字符：
   - 调用 `onPlainChar(now)` 记录时序。
   - 然后按现有逻辑插入字符。

## 7. 配置与灰度

建议增加一个开关，避免影响所有用户：

```ts
disablePasteBurst?: boolean;
```

或者使用实验 flag：

```text
KIMI_CODE_EXPERIMENTAL_PASTE_BURST
```

推荐发布顺序：

1. 默认关闭，先在测试和内部使用。
2. 手动验证 iTerm2 + tmux、Windows Terminal、普通 macOS Terminal。
3. 观察是否有正常手敲被误判成 paste。
4. 默认开启。
5. 保留关闭开关作为 escape hatch。

## 8. 测试计划

建议把测试加到现有 `Editor` 测试文件里，避免新增过多测试文件。

### 8.1 bracketed paste 路径不变

- 输入 `\x1b[200~a\r\nb\x1b[201~`
- 应作为一次 paste 插入
- 不触发 submit

### 8.2 非 bracketed paste burst 被识别

输入：

```text
a
b
c
<idle>
```

字符间隔小于 `PASTE_BURST_CHAR_INTERVAL_MS` 时：

- 字符仍按现有逻辑插入
- 不触发 submit
- 随后的 Enter 在 burst 窗口内按换行处理

### 8.3 burst 内 Enter 不提交

输入：

```text
abc\rdef\r
<idle>
```

期望：

- `\r` 被当成换行处理
- 不触发 submit
- 输入框保留多行文本

### 8.4 正常手敲不受影响

输入：

```text
a
<等待超过 interval>
b
<等待超过 interval>
Enter
```

期望：

- `a`、`b` 作为正常输入
- Enter 正常 submit

### 8.5 Enter suppression window

输入：

```text
abcdefgh
Enter
```

如果 Enter 距离上次 burst 活动小于 `PASTE_ENTER_SUPPRESS_WINDOW_MS`：

- 先按换行处理

超过窗口后：

- 恢复 submit 行为

### 8.6 非 ASCII / IME

输入中文：

```text
测
试
文
本
```

快速连续到达时：

- 中文字符仍按现有逻辑立即插入
- 快速连续输入后的 Enter 应按换行处理

### 8.7 disable 开关

当 `disablePasteBurst = true`：

- 所有输入按正常 typing 处理
- 不做 paste-burst Enter 抑制

## 9. 手动验证

### 9.1 bracketed paste 正常

在 tmux 里运行：

```sh
printf '\033[?2004h'; cat -A; printf '\033[?2004l'
```

粘贴多行文本，应看到：

```text
^[[200~ ...
...
^[[201~
```

### 9.2 CRLF 文件粘贴

使用：

```text
paste-test-crlf.txt
```

粘贴到 Kimi Code 输入框：

- 修复前：如果 bracketed paste 生效，也不会复现。
- 修复后：无论 bracketed paste 是否生效，都应尽量作为整段粘贴处理。

### 9.3 send-keys 强制模拟裸 Enter

```sh
tmux send-keys -t <target> -l '复现第一行'
tmux send-keys -t <target> Enter
tmux send-keys -t <target> -l '复现第二行'
tmux send-keys -t <target> Enter
```

修复前：裸 Enter 会提交。

修复后：如果输入足够快，应被 paste-burst 合并为一次粘贴，至少不应逐行误提交。

注意：`send-keys` 的时序可能受 tmux 和系统调度影响，不能完全等同于真实粘贴，只能作为近似验证。

## 10. 风险与缓解

### 10.1 快速手敲被误判成粘贴

风险：

```text
用户快速敲一个短命令 + Enter
```

可能被误判成 paste。

缓解：

- 只处理无修饰键的普通字符。
- 要求至少 `PASTE_BURST_MIN_CHARS` 个连续快速字符。
- 提供 disable 开关。
- 初始默认关闭，先灰度。

### 10.2 短 Enter suppression 影响正常提交

`PASTE_ENTER_SUPPRESS_WINDOW_MS` 可能让用户在快速输入后按 Enter 时被当成换行。

缓解：

- 窗口保持较短，例如 80-120ms。
- 只在前一个输入被判定为 burst 后开启。
- 正常慢速输入不开启。

### 10.3 慢速粘贴无法识别

如果终端把粘贴拆成很慢的 chunk，间隔超过 `PASTE_BURST_CHAR_INTERVAL_MS`，启发式可能失效。

缓解：

- 可适当提高 interval。
- 但不能无限提高，否则会误伤正常输入。
- bracketed paste 仍是主路径，启发式只是兜底。

## 11. 环境侧建议

应用层启发式是兜底，环境侧仍建议保持健康配置。

`~/.tmux.conf`：

```conf
set -g extended-keys on
```

然后重启 tmux：

```sh
tmux kill-server
tmux new -s test
```

可选，不是 bracketed paste 必需：

```conf
set -g set-clipboard on
set -g allow-passthrough on
```

这两行主要用于 OSC 52 / escape passthrough，不应被当作 bracketed paste 修复手段。

## 12. 推荐落地步骤

1. 新增 `PasteBurst` 状态机，先写单元测试。
2. 在 `Editor.handleInput()` 接入，默认关闭。
3. 确保 bracketed paste 显式路径不变。
4. 增加 disable 开关或实验 flag。
5. 跑现有测试，确认无回归。
6. 手动验证 iTerm2 + tmux、`send-keys`、CRLF 文件粘贴。
7. 内部试用一段时间。
8. 默认开启，保留关闭开关。

## 13. 结论

根本机制是 bracketed paste：

```text
标记到了 → 一次粘贴 → 不逐行提交
```

但不能保证所有终端、tmux、SSH、Windows 环境都可靠传递标记。

因此完整方案是：

```text
bracketed paste 作为主路径；
paste-burst 启发式作为失效兜底。
```

这和 Codex 的方向一致。它不能从协议层面“根本消除”标记不到的情况，但能把实际误提交概率降到足够低，并且可测试、可关闭、可灰度。