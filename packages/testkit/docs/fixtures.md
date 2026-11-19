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

只需要检查序列化结果时，可以对 `kimiConfigToml(config)` 返回的字符串做断言。需要测试损坏的配置时，用 `raw` 附加故意写坏的 TOML。覆盖已有配置用 `mergeKimiConfig(base, override)`。同名 provider 或 model 的配置项会整体替换，hooks 数组会依次拼接。[配置写入与合并](../src/fixtures/config.ts)

## 控制环境和网络

- **被测代码接收环境参数时**，传入 `testEnv({ set: { HOME: testHome.home } })`。它返回新的对象，过滤继承来的 `KIMI_*`、已列出的厂商凭据和代理变量，再设置测试默认值。要保留某个原值用 `keep`，要模拟变量缺失用 `set: { MY_OPTION: undefined }`。[环境夹具](../src/fixtures/env.ts)
- **被测代码直接读取 `process.env` 时**，用 `const restore = isolateProcessEnv(...)` 设置临时环境，并在 `finally` 调用 `restore()`。它修改整个进程，同一 worker 内使用这项夹具的测试应顺序运行。[环境恢复用例](../test/fixtures.test.ts)
- **要发现意外的联网请求**，可以在 Vitest 的 `setupFiles` 中注册 `useNetworkGuard()`。testkit 和 KAP 场景项目已经启用它。其他包若需要相同行为，在自己的 setup 文件中从 `@moonshot-ai/testkit/vitest` 导入并调用它。它检查当前 Node 进程的 TCP 连接目标，默认允许本机回环连接。即使用例捕获了连接错误，结束时仍会报告违规的主机和端口。它的作用域不包括独立子进程。[场景 setup](../../../tests/scenarios/support/setup.ts) · [守卫验收](../test-fixtures/test/network-guard.test.ts)

## 等待明确的事件

| 测试要等什么 | 用法 |
|---|---|
| 异步脚本已经开始，并交出某个值 | `const entered = deferred<AbortSignal>()`，让脚本调用 `entered.resolve(signal)`，测试侧等待 `entered.promise` |
| 测试侧决定何时放行一段自己的代码 | `const ready = gate()`，工作方等待 `ready.wait()`，控制方调用 `ready.open()` |
| 已发起的模型请求到达指定输出位置 | 用 `model.hold(name).reached()` 确认模型到达命名挂起点。要证明客户端已收到输出，再读取对应的 SDK 流事件或 WebSocket 帧 |
| 某状态只有查询接口 | `until(label, check, { timeoutMs })` 会轮询，回调返回 `undefined`、`null` 或 `false` 代表继续等待。超时信息含标签及最后的值或错误 |

测取消时，先等脚本进入、请求到达挂起点或客户端收到帧，再发取消操作。这样测试断言的是一个可观察的先后顺序，慢机器上也有相同含义。[生成回复时取消与流中插话](../../../tests/scenarios/conversation.test.ts) · [等待夹具](../src/fixtures/wait.ts)

## 让断言稳定，同时保留对象之间的关系

比较一组帧或多个快照时，在**同一个测试**里复用 `createNormalizer({ idKeys: ['session_id'], paths: { '<workspace>': testHome.workspace } })` 返回的函数。它按首次出现的顺序为 ID 编号，所以同一个会话在前后两份数据里仍对应同一个标记。`paths` 的键是要显示的占位符，值是测试机上的实际路径。单份数据可以直接调用 `normalize(value, options)`。如果要验证两个真实 ID 是否相同，直接比较原始值即可。[快照规范化用例](../test/fixtures.test.ts)

构造图片输入时，`dataUrl('image/png', solidPng(2, 2))` 可以生成完整的 PNG。需要区分损坏的 Base64 和无法解码的图片时，从 `BROKEN_DATA_URLS` 选择对应样本。`mp4Header()` 只构造 MP4 的文件类型头，适合格式识别测试。[媒体样本](../src/fixtures/media.ts)
