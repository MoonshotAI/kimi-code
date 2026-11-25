# 在隔离的环境里写测试

测试配置加载、文件读写或消息格式时，可以单独导入 `@moonshot-ai/testkit/fixtures`。Vitest 用例通过 `@moonshot-ai/testkit/vitest` 的 `homeFixtures()` 获取独立目录。需要启动引擎、发送 prompt 时，使用[已有的 KAP 场景夹具](kap-scenarios.md)。

## 给每个用例独立的配置和工作区

下面是可以放进 `packages/testkit/test/` 的完整 Vitest 文件。它写入真实的 TOML 文件，并检查读取方会看到的权限配置。

```ts
import { readFile } from 'node:fs/promises';

import { writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { homeFixtures, type HomeFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

const test = base.extend<HomeFixtures>(homeFixtures());

test('writes manual permissions to the test config', async ({ testHome }) => {
  const path = await writeKimiConfig(testHome.dataDir, {
    defaultPermissionMode: 'manual',
  });

  expect(await readFile(path, 'utf8')).toContain('default_permission_mode = "manual"');
});
```

`testHome.dataDir` 放 `config.toml` 和产品数据，`testHome.workspace` 放待处理的项目文件，`testHome.home` 可以作为被测程序的 `HOME`。夹具在用例结束时清理这三处目录。手动创建时，用 `createTestHome()` 取得同样的对象，在 `finally` 里执行 `await home.remove()`。[临时目录和配置用例](../test/fixtures.test.ts)

要确认被测程序只改了该改的文件时，在动手前后各调用一次 `await snapshotDirectory(testHome.workspace)`，再用 `directoryChanges(before, after)` 取得新增、删除和内容变化的文件列表，空数组表示什么都没变。快照把每个文件的相对路径（统一用 `/` 分隔）映射到内容的 SHA-256，符号链接记录它指向的目标而不跟随，空目录不计入。预期某个文件变成指定内容时，把 `contentDigest(content)` 填进期望的快照再比较。[快照实现](../src/fixtures/snapshot.ts) · [用例](../test/fixtures.test.ts)

只需要检查序列化结果时，可以对 `kimiConfigToml(config)` 返回的字符串做断言。需要测试损坏的配置时，用 `raw` 附加故意写坏的 TOML。覆盖已有配置用 `mergeKimiConfig(base, override)`。同名 provider 或 model 的配置项会整体替换，hooks 数组会依次拼接。[配置写入与合并](../src/fixtures/config.ts)

需要真实的 git 仓库时，用 `await createGitRepository(dir, { files })`：它在 `dir` 初始化仓库，写入 `files`（相对路径到内容）并提交一次。要验证 worktree 相关的行为，用 `await createGitWorktree({ main, worktree }, { files })`：它在 `main` 建同样的仓库，再用 `git worktree add` 在 `worktree` 检出新分支。两者都调用系统的 `git`，提交身份和关闭签名用命令行参数指定，不改动全局 git 配置。断言 Bash 工具打印的工作目录时，用 `bashPathOf(path)` 把本机路径换成 Git Bash 的写法：Windows 上 `C:\Users\me\app` 写成 `/c/Users/me/app`，其他平台原样返回。[git 夹具](../src/fixtures/git.ts)

## 控制环境和网络

- **被测代码接收环境参数时**，传入 `testEnv({ set: { HOME: testHome.home } })`。它返回新的对象，过滤继承来的 `KIMI_*`、已列出的厂商凭据和代理变量，再设置测试默认值。要保留某个原值用 `keep`，要模拟变量缺失用 `set: { MY_OPTION: undefined }`。测试默认值里有两类：关掉遥测、模型目录刷新这类和外界隔离的设置；以及为了让单元测试更快而关掉的产品功能，单独导出为 `UNIT_TEST_SWITCHES`（目前是会话索引的读模型和搜索 worker）。端到端测试要让产品按用户的默认配置跑时，把 `UNIT_TEST_SWITCHES` 的每个名字设成 `undefined` 传进 `set`。新增只为提速的默认值放进 `UNIT_TEST_SWITCHES`。[环境夹具](../src/fixtures/env.ts)
- **被测代码直接读取 `process.env` 时**，用 `const restore = isolateProcessEnv(...)` 设置临时环境，并在 `finally` 调用 `restore()`。它修改整个进程，同一 worker 内使用这项夹具的测试应顺序运行。[环境恢复用例](../test/fixtures.test.ts)
- **要发现意外的联网请求**，可以在 Vitest 的 `setupFiles` 中注册 `useNetworkGuard()`。testkit 和 KAP 场景项目已经启用它。其他包若需要相同行为，在自己的 setup 文件中从 `@moonshot-ai/testkit/vitest` 导入并调用它。守卫检查当前 Node 进程的 TCP 连接目标，默认允许本机回环连接。端口可以是数字或 Node 接受的端口字符串，Unix socket 路径和 Windows 命名管道交给 Node 处理。IPv4 目标须是 `127.0.0.0/8` 内的合法地址字面量。即使用例捕获了连接错误，结束时仍会报告违规的主机和端口。它的作用域不包括独立子进程。[场景 setup](../../../tests/scenarios/support/setup.ts) · [守卫验收](../test-fixtures/test/network-guard.test.ts)
- **临时放行指定主机**时，从 `@moonshot-ai/testkit/fixtures` 调用 `installNetworkGuard({ allowHosts })`，并在 `finally` 里调用返回对象的 `uninstall()`。多个守卫允许同一主机时，卸载最后一个允许该主机的守卫才会撤销这项许可。

## 等待明确的事件

| 测试要等什么 | 用法 |
|---|---|
| 异步脚本已经开始，并交出某个值 | `const entered = deferred<AbortSignal>()`，让脚本调用 `entered.resolve(signal)`，测试侧等待 `entered.promise` |
| 测试侧决定何时放行一段自己的代码 | `const ready = gate()`，工作方等待 `ready.wait()`，控制方调用 `ready.open()` |
| 已发起的模型请求到达指定输出位置 | 用 `model.hold(name).reached()` 确认模型到达命名挂起点。要证明客户端已收到输出，再读取对应的 SDK 流事件或 WebSocket 帧 |
| 某状态只有查询接口 | `until(label, check, { timeoutMs })` 会轮询，回调返回 `undefined`、`null` 或 `false` 代表继续等待。超时信息含标签及最后的值或错误 |

测取消时，先等脚本进入、请求到达挂起点或客户端收到帧，再发取消操作。这样测试断言的是一个可观察的先后顺序，慢机器上也有相同含义。[生成回复时取消与流中插话](../../../tests/scenarios/conversation.test.ts) · [等待夹具](../src/fixtures/wait.ts)

## 让断言稳定，同时保留对象之间的关系

比较一组帧或多个快照时，在**同一个测试**里复用 `createNormalizer({ idKeys: ['session_id'], paths: { '<workspace>': testHome.workspace } })` 返回的函数。它按首次出现的顺序给每个**值**编号：同一个原始 ID 不论出现在哪个键下、ID 数组里还是嵌在文本中的 UUID，都换成同一个标记，标记的种类取首次出现时的键名。所以「用户消息的 `item_id` 就是 `prompt_ids` 里的那个 ID」这种关系在规范化后仍能看出来。`paths` 的键是要显示的占位符，值是测试机上的实际路径。单份数据可以直接调用 `normalize(value, options)`。如果要验证两个真实 ID 是否相同，直接比较原始值即可。[快照规范化用例](../test/fixtures.test.ts)

时间字段默认换成 `<time>`。数据还要交给会解析时间的代码（例如客户端 reducer）时，传 `timePlaceholder: 'fixed'`：时间字符串换成固定的 `FIXED_TIME`，`timeKeys` 里的数字（例如 `duration_ms`）换成 0，字段类型不变。

## 把预期数据入库：golden

协议文档、录制的帧这类需要人审的预期数据，用 `await expectGolden(path, value, { kind, refreshCommand })` 和入库文件比较。值按键排序后序列化；有差异时列出每一处变化的 JSON Pointer 和前后取值，再给出刷新命令。读取时忽略 CRLF，Windows 检出的文件也能比较。只有环境变量 `TESTKIT_REFRESH` 等于 `kind` 时才写文件，而且在 CI 里拒绝写入，所以 CI 只验证、不生成。仓库根目录的 `pnpm qa:refresh <kind>` 负责设置这个变量。[golden 实现](../src/fixtures/golden.ts)

构造图片输入时，`dataUrl('image/png', solidPng(2, 2))` 可以生成完整的 PNG。需要区分损坏的 Base64 和无法解码的图片时，从 `BROKEN_DATA_URLS` 选择对应样本。`mp4Header()` 只构造 MP4 的文件类型头，适合格式识别测试。[媒体样本](../src/fixtures/media.ts)

## 启动被测程序的子进程

需要真正的进程边界时（冷启动、强杀、终端读屏），用 `TestProcess.start({ label, command, cwd, env, logDir })` 启动 Node 子进程。入口文件不存在时直接失败。它一直读空 stdout，保留 stdout 和 stderr 的尾部，可以用 `waitForLine(predicate)` 等结构化的就绪行，用 `onOutput(listener)` 把输出交给虚拟终端。子进程提前退出时，等待会立刻失败，并附上退出码和 stderr。[进程夹具](../src/fixtures/process.ts) · [用例](../test/fixtures.test.ts)

- **启动 CLI** 用 `command: kimiCliCommand()` 和 `env: kimiCliEnv(testHome, extra)`。前者默认用 tsx 运行 `apps/kimi-code/src/main.ts`；环境变量 `TESTKIT_CLI_BUILD=dist` 时改用 Node 直接运行发布用的 `apps/kimi-code/dist/main.mjs`，不加载 tsx，也不打开开发服务器开关，所以要先构建，没有构建产物时子进程不会启动。后者在 `testEnv()` 基础上，把 OS home、`KIMI_CODE_HOME` 指向测试目录，关闭自动更新，并把 Kimi 服务地址指向网络守卫会拦截的 `KIMI_SERVICE_URL`。产品启动时会读的两个可选配置接口用 `kimiServiceStubs()` 回 404；对这个地址的其他请求都会记为违例，所以首轮流程里新增的服务依赖会让测试变红。只需要 OS home 那组变量（`HOME`、`USERPROFILE`、XDG 和 Windows 的 AppData）时，用 `osHomeEnv(dir)`。[CLI 命令与环境](../src/fixtures/cli.ts)
- **子进程的网络**：每个 `TestProcess` 都预加载 testkit 的网络守卫，违例逐条追加到 `logDir` 下的日志，所以子进程被强杀后仍能读到。收尾时调用 `await child.networkViolations()`；如果子进程没有加载守卫，这个调用会失败，不会返回空列表。产品会访问、又无法改地址的固定下载（例如 CDN 上的 fd 压缩包），用 `fetchStubs: [{ method, url, status }]` 在子进程里直接回固定状态码。`url` 默认要和请求地址完全相同；调用方算不出完整地址时（例如文件名随平台变化的下载），加 `prefix: true`，以 `url` 开头的地址都回这个状态码。不经 `TestProcess` 启动的 Node 程序，例如 Playwright 启动的 Electron 主进程，用 `-r` 或 `--import` 加载 `NETWORK_GUARD_PRELOAD`，把 `networkGuardEnv(log, stubs)` 合入环境，收尾时用 `readNetworkViolations(log, label)` 读取违例。[Desktop 驱动](../../../tests/e2e/surfaces/desktop.ts)
- **结束子进程**：先走被测程序自己的退出路径并等 `child.closed`，再检查退出码；超时或模拟崩溃时用 `await child.forceKill()`，它在 POSIX 上结束整个进程组，在 Windows 上结束进程树。只需要清理测试自己启动的其他进程时，用 `killProcessTree(pid)`，并在 POSIX 上以 `detached: true` 启动它。
- **KAP 服务端子进程**用 `KapProcess.start({ home })`，见 [KAP 场景指南](kap-scenarios.md#重启清理与失败诊断)。终端读屏见 [TUI 驱动](../../../tests/e2e/surfaces/tui.ts)。

需要读取仓库里的数据文件（例如其他包录下的样本）时，用 `repoPath('tests', 'scenarios', ...)` 从仓库根目录定位，不要写跨包的相对路径。
