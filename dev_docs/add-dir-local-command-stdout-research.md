# add-dir / local-command-stdout 调研记录

本文记录 `/add-dir`、`--add-dir`、`<local-command-stdout>`、bash mode 输出在参考实现中的行为，以及它们对 Kimi Code 当前实现的影响。

## 1. 背景

Kimi Code 当前正在支持 workspace additional dirs：

- `--add-dir <dir>`：启动/resume 时添加额外 workspace 目录
- `/add-dir <dir>`：在 TUI 中手动添加额外 workspace 目录

当前已经修复/确认的行为：

- `--add-dir` 在 resume / continue 场景下也会传入并合并到 session additionalDirs
- caller 传入的相对路径按 `workDir` 解析，而不是 projectRoot
- additional dirs 默认 session-only，不写入 `.kimi-code/local.toml`
- additional dirs 的 `AGENTS.md` 默认不加载进上下文，只保留目录 listing

接下来要确定的是：`/add-dir` 成功后应该插入什么形式的消息。

## 2. 参考实现里的 `/add-dir` 行为

参考实现中，`/add-dir` 是 `local-jsx` 类型的 slash command。

执行成功后，它不会插入 `system-reminder`，而是通过 local slash command 的输出机制插入一条 user 角色消息，内容用 `<local-command-stdout>` 包裹。

示例：

```xml
<local-command-stdout>
Added /path/to/dir as a working directory for this session · /permissions to manage
</local-command-stdout>
```

如果是 remember 模式，内容类似：

```xml
<local-command-stdout>
Added /path/to/dir as a working directory and saved to local settings · /permissions to manage
</local-command-stdout>
```

关键点：

- 不是 `system-reminder`
- 不是 assistant 消息
- 是 user 角色的命令输出消息
- 不会立刻触发模型回复，等价于 `shouldQuery: false`
- 会进入历史，下一轮用户发消息时一起发给模型

## 3. 参考实现里的 `--add-dir` / resume 行为

参考实现中，`--add-dir` 在启动或 resume 时：

- 会初始化额外目录状态
- 会把目录加入权限上下文
- 会影响 system prompt 里的额外目录展示
- 但**不会**插入 `<local-command-stdout>`
- 也**不会**插入 `system-reminder`

也就是说，参考实现只在**手动 `/add-dir`** 时插入命令输出消息；`--add-dir` 只是状态初始化。

另外，参考实现的 resume 不会恢复会话中通过 `/add-dir` 临时加入的 session-only 目录；只有 resume 命令行再次带 `--add-dir` 时才会重新应用。

Kimi Code 当前已经实现了 resume 时传入 `--add-dir`，这一点比参考实现更完整。

## 4. `<local-command-stdout>` 的用途

`<local-command-stdout>` 是“本地 slash command 输出”的通用包装。

典型场景包括：

1. 本地配置/状态命令
   - `/add-dir`
   - `/config`
   - `/status`
   - `/doctor`

2. 本地信息命令
   - `/cost`
   - `/voice`
   - `/usage`

3. 本地会话操作命令
   - `/compact`
   - `/clear`
   - `/btw`

4. fork 子代理命令结果

5. bridge / remote 不支持的命令拒绝消息

错误输出对应另一个 tag：

```xml
<local-command-stderr>
```

## 5. `<local-command-stdout>` 的语义

它在参考实现里有几个重要语义：

- 表示命令输出，不是用户自然语言输入
- 默认会进入模型上下文
- 不会立刻触发模型回复
- UI 会识别并做专门渲染
- title / rewind / resubmit / prompt 计数等逻辑会把它从“真实用户输入”里排除
- 但它仍然作为历史发给模型

需要注意：这些功能的“排除”不是从模型上下文删除，而是不把它当作“用户主动输入的一句话”。

## 6. bash mode 的对比

参考实现里 bash mode（例如 `!ls`）不使用 `<local-command-stdout>`，而是使用专门的 bash tag。

bash 输入：

```xml
<bash-input>ls</bash-input>
```

bash 输出：

```xml
<bash-stdout>...</bash-stdout>
<bash-stderr>...</bash-stderr>
```

同时还有一条 caveat：

```xml
<local-command-caveat>
...
</local-command-caveat>
```

bash 行为：

- 输入和输出都是 user 角色消息
- caveat 是 user 消息，但带 meta 标记
- `shouldQuery: false`
- 执行完只 append 到上下文，本轮不请求模型
- 下一轮用户正常输入时，这些 bash 消息会作为历史一起发给模型

结论：

| 场景 | tag |
|---|---|
| slash command 输出 | `<local-command-stdout>` |
| slash command 错误 | `<local-command-stderr>` |
| bash 输入 | `<bash-input>` |
| bash 输出 | `<bash-stdout>` |
| bash 错误 | `<bash-stderr>` |

Kimi Code 当前要处理的是 slash command 输出，所以应该用 `<local-command-stdout>`，而不是 bash tag。

## 7. `<local-command-stdout>` 是否进入模型上下文

默认会。

参考实现的 API 规范化逻辑会把 local command 输出纳入 API 对话，并与相邻 user 消息合并。

原因是：模型需要能在后续轮次引用之前的命令输出。

但它不是立刻发送：

```text
执行 slash command
↓
插入 <local-command-stdout>
↓
本轮不主动请求模型
↓
用户下一条正常消息
↓
命令输出作为历史一起发送
```

## 8. title / rewind / resubmit / prompt 计数的影响

这些功能会跳过 `<local-command-stdout>`，但只是从“真实用户输入”逻辑里跳过，不是从模型上下文删除。

### title

生成会话标题时，不会用命令输出当标题。

例如不会用：

```text
Added ../shared as a working directory
```

作为会话标题。

但消息仍在历史里。

### rewind

rewind 选择器会跳过命令输出，因为它不是用户主动输入的 prompt。

但如果用户 rewind 到更早的时间点，这之后的命令输出也会随历史一起被移除。

### resubmit

resubmit 不会把命令输出当作用户输入重新提交。

但如果 resubmit 某个真实 prompt，历史里已有的命令输出仍然会作为上下文一起发送。

### prompt 计数

统计用户 prompt 数量时，会跳过 terminal output。

也就是说：

```text
普通用户输入：算一个 prompt
<local-command-stdout>：不算
```

但这只是计数，不影响上下文。

## 9. 对 Kimi Code 的设计建议

当前需求是：

- `/add-dir` 成功后插入一条 `<local-command-stdout>`
- 不插入 `system-reminder`
- 不立刻发给 AI
- 不出现在 live 消息流
- 不出现在 resume 后的用户可见 transcript
- 但仍然进入模型上下文

这个需求和参考实现不完全一致。参考实现里 `<local-command-stdout>` 通常会在 transcript / resume 里出现；而当前需求要求它对用户不可见。

因此建议设计：

1. 新增一个 core RPC 方法，例如 `appendLocalCommandStdout`
2. 在 core agent context 里实现同名方法
3. 内容包成：

```xml
<local-command-stdout>
...
</local-command-stdout>
```

4. role 用 `user`
5. origin 用内部 injection 类型，例如：

```ts
{ kind: 'injection', variant: 'local-command-stdout' }
```

6. 不启动 turn
7. 不 append 到 TUI transcript
8. `--add-dir` / resume flag 不插入这条消息，只有手动 `/add-dir` 插入

这样做的效果：

- 用户在 live transcript 里看不到它
- resume 后 transcript 也看不到
- 不会作为真实用户输入参与 undo / title / resubmit / prompt 计数
- 但仍在历史 records 里
- 下一轮用户发消息时，会作为上下文发给模型

## 10. 待确认点

实现前需要确认：

1. `variant` 名称用 `local-command-stdout` 还是 `add-dir`
2. `/add-dir` 成功后是否保留 `showStatus` 的瞬时反馈
3. 这条消息是否需要写入 records（建议写入，否则 resume 后模型也看不到）
4. 是否需要覆盖 export / replay 的隐藏行为测试

当前推荐：

- `variant: 'local-command-stdout'`
- 保留 `showStatus` 作为瞬时反馈，但不写入 transcript
- 写入 records，确保模型后续可见
- 增加 runtime 测试，确认 record 是 user 角色、内容为 `<local-command-stdout>`、origin 为内部 injection
