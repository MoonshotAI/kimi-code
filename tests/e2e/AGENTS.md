# 新 E2E

一端是模拟的用户输入，另一端是真实的产品进程，中间只有 testkit 的假模型是假的。每个场景查三样：模型收到了什么、界面显示了什么、磁盘变成了什么样。同一个场景要在 TUI、Web、Desktop、ACP 四个面上各跑一遍；目前接通了 TUI 和 ACP，Desktop 和 Web 的驱动接入之前，`playwright.config.ts` 里没有它们的 project。

旧 E2E 不在这里：`apps/desktop/e2e/`、`apps/desktop/test/e2e/`、`apps/kimi-code/test/e2e/`，以及 `packages/acp-server/test/` 里的 e2e 和 parity 测试。不要把它们搬进来，也不要 import 它们的夹具。KAP 协议本身的场景在 `tests/scenarios/`。

## 目录

```text
scenarios/<业务>/<行为>.spec.ts   场景，各个面共用
self-test/<动作>.spec.ts          驱动自测：每个动作的正例和反例
surfaces/                          各个面的驱动
support/                           scenario()、selfTest()、VERBS、收尾检查
playwright.config.ts               一个面一个 project
```

## 运行

- TUI 和 ACP 本地直接跑源码：`pnpm --filter @moonshot-ai/e2e exec playwright test --project=tui`，ACP 把 `tui` 换成 `acp`。要跑构建产物，先 `pnpm --filter @moonshot-ai/kimi-code run build`，再设 `TESTKIT_CLI_BUILD=dist`。CI 上一律跑构建产物。
- 源码模式下每个用例都要重新加载一遍 CLI 源码，几个 worker 同时启动 `kimi acp` 时，光等它答复 `initialize` 就要十来秒。想跑得快就用构建产物，或者加 `--workers=2`。
- TUI 驱动借系统的 `script` 命令给 CLI 一个真终端，只支持 Linux 和 macOS。
- ACP 驱动把 `kimi acp` 当子进程启动，自己扮演编辑器：声明 fs 和终端两种能力，读写文件用真实的磁盘，跑命令用真实的 shell。终端命令跑在自己的进程组里，所以也只支持 Linux 和 macOS。
- 工作区必须在 git 工作树之外。`TMPDIR` 如果在某个仓库里，夹具会直接报错：POSIX 上，工作区在 git 工作树里时，Edit 和 Write 会被自动批准，审批场景会挂住。
- CI：`.github/workflows/e2e.yml`，每个 PR 都在 Linux 上跑，作业名带 optional。仓库目前没有必过检查，所以它红了不挡合并。

## 写场景

场景文件长这样，`scenario(标题, 选项, 本体)` 的本体只拿得到 `product`、`model`、`workspace`：

```ts
scenario('reads one file and edits another after approval', { workspace: { 'a.txt': 'hello\n' } }, async ({ product, model, workspace }) => {
  model.script(read('a.txt'), say('Done.'));
  await product.send('Read a.txt.');
  await product.waitIdle();
  expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('hello');
  await product.expectReply('Done.');
});
```

| 规矩 | 由什么守 |
|---|---|
| 场景只用 `support/scenario.ts` 导出的 `scenario` 和 `expect`，以及 `@moonshot-ai/testkit/model` 的剧本步骤 | `scripts/checks/e2e-boundary.mjs` |
| 一个文件只写一个用户行为，标题用英文描述这个行为 | 评审 |
| 三样都要查。<br>模型：请求里的关键内容要显式断言，例如读到的文件内容出现在下一次请求里。<br>界面：至少一个通过的 `expectTool` 或 `expectReply`。<br>磁盘：预期的改动用 `workspace.expectFile` 或 `workspace.expectMissing` 声明 | 界面：收尾检查。<br>磁盘：收尾时对比工作区快照，没声明的改动、声明之后又变了的文件，都算失败。<br>模型：消息结构、没用完的剧本、没放开的等待点由 `model.verify()` 在收尾时查，关键内容靠评审 |
| 只断言主通道 `model.requests('main')`。回合完成后生成会话标题的请求走 `side` 通道 | 评审 |
| 不许跳过、只跑一个、重试、固定等待 | `scripts/checks/e2e-boundary.mjs`；`playwright.config.ts` 里的 `retries: 0` 和 `forbidOnly: true` |
| 场景里不出现面名，也拿不到 `page`、终端、`process.env`、`test.info()`。面和面的差异在驱动里处理 | `scenario()` 不提供这些东西；`scripts/checks/e2e-boundary.mjs` |
| 某个面不适用，写 `except: { 面: '理由' }`；只在某些面跑，写 `onlyOn` 加 `reason`。理由不能为空，不适用的面在报告里显示为跳过并带着理由 | `scenario()` 登记用例时检查，理由为空时列用例那一步就失败 |
| 场景结束时产品必须空闲，产品要能正常退出，除了假模型和本机不能连别的地址 | 收尾检查 |
| 改场景断言就是改产品行为，PR 里要写明为什么改 | CODEOWNERS 评审 |
| 提示词用英文 ASCII 单行，不以 `/`、`!`、`@` 开头，不以反斜杠结尾 | `send()` 运行时检查 |
| 剧本里的思考文本不要包含要断言的回复文字：TUI 上思考和回复只有颜色不同，`expectReply` 分不开 | 评审 |

## 写驱动

动作清单是 `support/verbs.ts` 里的 `VERBS`，`Product` 接口由它推导：`send`、`approve`、`reject`、`stop`、`waitIdle`、`expectTool`、`expectReply`。

| 规矩 | 由什么守 |
|---|---|
| 驱动只能做用户能做的操作：<br>TUI 只往真终端里写按键、读屏幕；<br>Desktop 和 Web 只点击、输入、读页面的无障碍树；<br>ACP 只像编辑器那样收发 ACP 消息，并回应 fs 和终端请求 | `scripts/checks/e2e-boundary.mjs` 的 import 白名单和后门清单；评审 |
| 不许在页面或 Electron 里执行代码，不许拦截或伪造网络请求，不许从测试直接请求产品的 HTTP 或 WebSocket 接口，不许 import 产品内部的包或旧夹具，不许带调试开关启动产品 | `scripts/checks/e2e-boundary.mjs` |
| 前置准备只能用用户自己也能用的方式：配置文件、命令行参数、用户文档里公开的环境变量。绕不过去的界面就在界面上走。隔离用的环境变量一律来自 testkit 的 `testEnv()` 和 `kimiCliEnv()`，驱动不自己拼 | 评审；`scripts/checks/e2e-boundary.mjs` 要求这个目录里出现的每个 `KIMI_*` 名字都写在 `docs/en/configuration/env-vars.md` 里 |
| 产品专门为测试加的开关和其他例外，只能登记在 `scripts/checks/e2e-boundary.json` 里并写明理由；不再用到的条目会被报出来 | `scripts/checks/e2e-boundary.mjs` |
| 改变状态的动作等到界面上出现证据才返回。动作先等到确定的状态再下结论：审批出现了或回合结束了，期望成立了或回合结束了，不靠超时来判断 | 驱动自测 |
| `expectTool` 和 `expectReply` 只看最近一条用户消息之后的内容，工具卡片不算回复，工具调用前后的两段话不拼在一起匹配；回合是否结束要看产品自己的信号（TUI 的活动指示，ACP 的 `session/prompt` 答复），不能凭转录里出现的某段文字 | 驱动自测 |
| 每个动作在每个面上都要有正例和反例。自测写成 `selfTest('动作', { positive, negative })`，放在以动作命名的文件里；要加动作，先改 `VERBS` | `selfTest()` 登记时检查每个面都有正反例；`self-test/coverage.spec.ts` 检查每个动作都有自测文件 |
| 动作的含义由自测固定，改自测就等于改含义 | CODEOWNERS 评审 |
| 产品不连真网络：会去 CDN 下载的工具在 `surfaces/offline.ts` 里按前缀桩成 404，其余对外连接由 testkit 的网络守卫记下 | 收尾检查 |
| ACP 上工具的结果不能只看 agent 自己报的状态，还要核对编辑器这一侧：Read 完成，要在这次工具调用期间有一条同一路径、编辑器答复成功的 `fs/read_text_file`；Edit 和 Write 完成，要有同样条件的 `fs/write_text_file`；Bash 完成，它引用的终端必须是编辑器建的、跑的是这条命令、退出码是 0 | ACP 驱动的 `expectTool`。场景和自测只能证明它不误报；真实产品造不出反例，靠改坏驱动的破坏性检查和评审 |
| ACP 的 stdout 上只能有 JSON-RPC 消息，agent 只能调用编辑器实现了的方法，编辑器只往测试目录里写文件，结束时没有还在跑的终端命令，进程在输入关闭后以 0 退出 | ACP 驱动的收尾检查 |
| ACP 上每条 `session/update` 都要通过 SDK 的 schema | 没通过的通知到不了驱动，回合就永远不算结束：等待超时，报错里写明收到几条、通过几条 |
| 编辑器的行为照真实编辑器来：命令一退出就报告退出状态，不等它留下的后台进程；`terminal/release` 之后这个终端就不存在了；命令起不来时 `terminal/create` 直接失败 | 评审 |

## 红了怎么办

- **先分清是产品坏了还是驱动坏了。** 自测也红，多半是驱动或产品的界面变了；只有场景红，先看场景断言的那条产品行为。
- **不许靠重试、加等待、跳过让它变绿。** flaky 用例照根 `AGENTS.md` 的规则处理：先找根因。实在找不到根因可以删，PR 里写明删掉的用例原来覆盖什么、现在由谁覆盖。
- **看失败附件。** 每个失败的用例都附上假模型的请求摘要、网络守卫的记录和产品日志；TUI 另有完整的屏幕内容、最近的输入和退出码；ACP 另有按顺序记下的 JSON-RPC 消息（最近 4000 条）、不是 JSON-RPC 的 stdout 行和 stderr 末尾。隔离目录在失败时保留，路径记在用例的 `test home` 标注里。

## 不在这里做的事

- 不往 `tests/protected.yaml` 登记。现在登记的 Playwright 条目都会被当成 Desktop 旅程去检查。
- 不写 `@quarantine`。`scripts/checks/quarantine.mjs` 只允许 Desktop 旅程进隔离名单。
