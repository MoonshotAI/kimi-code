# 新 E2E

一端是模拟的用户输入，另一端是真实的产品进程，中间只有 testkit 的假模型是假的。每个场景查三样：模型收到了什么、界面显示了什么、磁盘变成了什么样。同一个场景要在 TUI、Web、Desktop、ACP 四个面上各跑一遍，四个面都已接通。

旧 E2E 不在这里：`apps/desktop/e2e/`、`apps/desktop/test/e2e/`、`apps/kimi-code/test/e2e/`，以及 `packages/acp-server/test/` 里的 e2e 和 parity 测试。不要把它们搬进来，也不要 import 它们的夹具。KAP 协议本身的场景在 `tests/scenarios/`。

## 目录

```text
scenarios/<业务>/<行为>.spec.ts   场景，各个面共用
self-test/<动作>.spec.ts          驱动自测：每个动作的正例和反例
surfaces/                          各个面的驱动
support/                           scenario()、selfTest()、VERBS、收尾检查、步骤标题、CI 运行页摘要
playwright.config.ts               一个面一个 project，另有两个跑法：tui-kitty、acp-bare
```

## 运行

- 两个面各多一种跑法，各是一个 project，跑同一套场景和自测：`tui-kitty` 里终端支持 Kitty 键盘协议，`acp-bare` 里编辑器不声明 fs 和终端能力。CI 上它们和原来的 project 在同一个作业里跑。
- TUI 和 ACP 本地直接跑源码：`pnpm --filter @moonshot-ai/e2e exec playwright test --project=tui`，ACP 把 `tui` 换成 `acp`。要跑构建产物，先 `pnpm --filter @moonshot-ai/kimi-code run build`，再设 `TESTKIT_CLI_BUILD=dist`。CI 上一律跑构建产物。
- 源码模式下每个用例都要重新加载一遍 CLI 源码，几个 worker 同时启动 `kimi acp` 时，光等它答复 `initialize` 就要十来秒。想跑得快就用构建产物，或者加 `--workers=2`。
- TUI 驱动用 `node-pty` 给 CLI 一个真终端。Linux 和 macOS 上由一个 `/bin/sh` 启动脚本先跑 CLI，CLI 退出后在同一个终端里打印退出码和 `stty -a`；Windows 上 CLI 直接跑在 ConPTY 里，退出码取自伪终端，不跑 `stty`。终端是 xterm.js（`@moonshot-ai/pi-tui/testing` 的 `VirtualTerminal`），按键直接写字节。`node-pty` 先找自己包目录里编译好的原生模块，没有再用它自带的预编译文件（只有 macOS 和 Windows 的）。`pnpm install` 时 `apps/desktop` 的 `postinstall`（`apps/desktop/scripts/rebuild-native.mjs`）会为 Electron 重新编译它，编出来的是 N-API 模块，Node 也能加载；Linux 上只能靠这一步，设了 `KIMI_SKIP_DESKTOP_PTY_REBUILD=1` 安装的 Linux 检出里 TUI 和 Web 都跑不起来。
- ACP 驱动把 `kimi acp` 当子进程启动，自己扮演编辑器：声明 fs 和终端两种能力，读写文件用真实的磁盘，跑命令用真实的 shell。Linux 和 macOS 上终端命令跑在自己的进程组里，`terminal/kill` 和 `terminal/release` 杀掉整个进程组；Windows 上用 `taskkill /T` 杀进程树，命令已经退出时它留下的后台进程够不到。
- Desktop 跑的是构建产物，先 `pnpm --filter kimi-code-app run build`，再 `pnpm --filter @moonshot-ai/e2e exec playwright test --project=desktop`。改了 `apps/desktop` 或它依赖的 `packages/` 之后要重新构建，否则测到的是旧界面。Desktop 在 macOS 上同时最多跑 2 个用例；在 Linux、Windows 上，或者设了 `E2E_HEADED=1` 时只跑 1 个（`playwright.config.ts` 里 Desktop 的 `workers`）。原因是同一个桌面上的几个 Desktop 实例会互相抢窗口焦点：产品打开菜单时会激活自己的窗口，别的窗口失去焦点，就关掉自己开着的菜单。macOS 的安静模式不让应用被激活（`app.setActivationPolicy('prohibited')`），所以不受影响。Electron 的二进制文件在第一次被调用时才下载，两个用例同时启动会撞上 `spawn ETXTBSY`，所以新装的检出先跑一次 `pnpm --filter kimi-code-app exec node -e "require('electron')"`，CI 的 Desktop 作业也是这样做的。Linux 上没有显示器时，外面套一层 `xvfb-run -a`。
- Web 跑的是 CLI 自带的 Web 界面。先 `pnpm sync:web` 把界面构建出来，改了 `apps/desktop/src/renderer` 或它依赖的 `packages/` 之后要重跑；第一次还要装浏览器：`pnpm --filter @moonshot-ai/e2e exec playwright install chromium`。然后 `pnpm --filter @moonshot-ai/e2e exec playwright test --project=web`。CLI 本身和 TUI 一样，默认跑源码，设 `TESTKIT_CLI_BUILD=dist` 跑构建产物。`kimi web` 和用户一样跑在一个真终端里（`surfaces/terminal-process.ts`，`node-pty`），终端输出渲染到 xterm.js 里，地址从渲染出的屏幕按行读（Windows 的 ConPTY 用光标定位而不是换行输出横幅）；结束时驱动在这个终端里按 Ctrl+C，要求它以 0 退出。
- Desktop 的窗口和 Web 的浏览器默认都不显示。想看着跑，设 `E2E_HEADED=1`。
- 工作区必须在 git 工作树之外。`TMPDIR` 如果在某个仓库里，夹具会直接报错：POSIX 上，工作区在 git 工作树里时，Edit 和 Write 会被自动批准，审批场景会挂住。
- CI：`.github/workflows/e2e.yml`，在 Linux 上跑，作业名带 optional。每次合并到 main 都跑；PR 上跳过 draft，只在打了 `e2e` 标签，或改动了 `tests/e2e/`、`packages/testkit/` 或这个工作流时跑。改了产品代码、想在合并前看 E2E 结果，就给 PR 打 `e2e` 标签。Desktop 和 Web 各分成两片（`--shard`），各占一个作业；Desktop 作业跑在 xvfb 的虚拟显示器里，Web 作业先装 Chromium。Windows 上也跑这四个面，作业名是 `Windows <面> (optional)`，Desktop 和 Web 各分成两片（例如 `Windows web (optional, 1/2)`、`2/2`）；它们在上面那些会跑 E2E 的 PR 上和手动触发（`workflow_dispatch`）时跑，合并到 main 时不跑，免得每次合并再多占六个 runner。Windows 上只跑 `tui`、`acp`、`desktop`、`web` 四个 project，不跑 `tui-kitty`、`acp-bare` 两个跑法。仓库目前没有必过检查，所以它红了不挡合并。
- Windows 上 Desktop 收尾时只能确认主进程退出了，查不到它的子进程：`process.kill(-pid, 0)` 这种按进程组的查法在 Windows 上没有。

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
| `restart()` 关掉产品再打开，回到原来的会话：产品必须空闲；先走产品自己的退出，查这个进程的网络记录，把它的诊断留到失败时一起附上，再用同一个 home、工作区和假模型起新进程。重启之后、下一次发消息之前，`expectReply`、`expectTool`、`expectError`、`expectAbsent` 读的「最近一回合」是恢复出来的最后一回合，也就是对话里最后一条用户消息之后的内容；整段对话用 `expectTranscript` 查。ACP 上恢复出来的最后一回合取自 `session/load` 回放里最后一条用户消息之后：重启前的编辑器和它开的终端都已经不在，所以命令的输出从工具调用内容的文字里读，也不再要求编辑器那一侧的证据（读写文件、终端的退出码）；回放里没有「这一回合失败了」这种消息，重启后查失败的场景要排除 ACP。重启前一次消息都没发过时，驱动只能证明产品重新可用，证明不了回到的是原来的会话。`expectTranscript` 在整段对话的用户消息和回复里找（工具卡不算），要求恰好出现一次 | 场景会话；`restart`、`expect-transcript` 的自测 |
| 某个面不适用，写 `except: { 面: '理由' }`；只在某些面跑，写 `onlyOn` 加 `reason`。理由不能为空，不适用的面在报告里显示为跳过并带着理由 | `scenario()` 登记用例时检查，理由为空时列用例那一步就失败 |
| 跑法（`tui-kitty`、`acp-bare`）下某个用例不适用，写 `exceptVariants: { 'bare-editor': '理由' }`。只用在两种情形：协议或终端本来就提供不了这项能力；或者是已经记录的产品缺口，负责人在 PR 里同意先排除，理由开头写明 `Product gap` | `scenario()` 登记时检查理由不为空 |
| 某个动作在某个平台上暂时查不了（动作表里的 `unavailableOn`，例如 Windows 上的 `expectTerminalRestored`），用到它的场景写 `exceptPlatforms: { win32: '理由' }`，这个平台上整条场景显示为不适用。没写就跑到这个动作时报错。自测按动作表自动带上。`unavailableOn` 只用于驱动还做不到的检查，不能用来绕开产品在某个平台上的 bug | 场景会话的分发；`scenario()` 登记时检查理由不为空；在其他平台上跑时，收尾检查要求场景确实用到了一个在被排除平台上不可用的动作 |
| 常规场景预先信任工作区。首次打开工作区的 TUI 场景可设 `workspaceTrust: 'trust'` 或 `workspaceTrust: 'exit'`。驱动通过终端选择信任并继续，或按 Esc 返回 shell。重启沿用同一个 home，由产品读取已记录的信任状态 | 信任场景检查模型收到的项目指令和重启后的会话。退出场景检查终端模式和模型请求 |
| 场景结束时产品必须空闲，产品要能正常退出，除了假模型和本机不能连别的地址 | 收尾检查 |
| 改场景断言就是改产品行为，PR 里要写明为什么改 | CODEOWNERS 评审 |
| 提示词用一行文字，可以是中文，不含控制字符，不以 `/`、`!`、`@` 开头，不以反斜杠结尾 | `send()`、`queue()`、`steer()` 的运行时检查 |
| 回合进行中再发消息用 `queue(文字)`（排到回合结束后，按顺序作为新回合发出）或 `steer(文字)`（插进正在跑的回合）。两者都要求回合正在跑，剧本里先用 `held` 或门控把回合挂住再调用。ACP 上没有这两个动作，场景用 `except: { acp: '理由' }` 排除它。插话时模型正在输出，这次请求会被中止、立刻带着插话重发；命令正在跑时不中止，插话排在工具结果之后随下一次请求送出。被中止的思考不进上下文，被中止的正文会留下，所以插话之后的请求断言写 `userTextsSinceReply.at(-1)` | 类型（`product` 按场景跑的面收窄）；评审 |
| 回合进行中要改工作区（例如放一个门控文件，让正在跑的命令继续），用 `workspace.write(路径, 内容)`，和用户自己在磁盘上改文件一样。写进去的内容算声明过的改动，之后产品又改了它，要再用 `expectFile` 声明 | 收尾时对比工作区快照 |
| 剧本里的思考文本不要包含要断言的文字：TUI 上思考和回复只有颜色不同，`expectReply`、`expectTranscript`、`expectAbsent` 都分不开，会把思考里的文字当成回复 | 评审 |
| `expectReply` 要求这段文字在本回合的回复里恰好出现一次，次数在第一次看到它的那一刻数。要查「回复被显示了两遍」，在 `waitIdle()` 之后调用；回合还在跑时调用它，是把它当同步点用，之后才出现的重复查不到 | 评审；`expect-reply` 的自测 |
| 问题只用单选。多选问题只有 TUI 的 `answer()` 会报错，Desktop、Web、ACP 不检测 | 评审 |
| 模型向用户提问用剧本里的 `askUserQuestion({ questions: [...] })`。一个场景一次只问一个单选问题，选项写短、不超过五个（TUI 的问题面板一次最多列六项，最后一项是 Other）。用户用 `answer(选项)`、`answerOther(文字)` 或 `dismissQuestion()` 回答；ACP 上没有 `answerOther`，场景用 `except: { acp: '理由' }` 排除它。模型下一次请求里的工具结果是 JSON：选了或填了是 `{"answers":{"<问题>":"<答案>"}}`，关掉是 `{"answers":{},"note":"User dismissed the question without answering."}` | 类型；评审 |
| 模型服务的失败用剧本里的 `httpError(状态码, { message })` 造。400、401 不重试，回合失败，用 `expectError(message)` 查；503、500、429 这类会自动重试，模型收到一模一样的第二次请求。`Retry-After` 只认秒，写 `retryAfterSeconds`。默认最多试 10 次、退避合计约 128 秒，超过用例的 120 秒限时，所以一个场景只造一两次可重试的失败。`message` 用中性的文字，不要出现 overloaded、rate limit、上下文超限一类字样，它们会改变产品对错误的分类 | 评审 |
| `expectTool` 的 `output` 只有 Bash 能带，写的是命令打印出来的文字，不能是命令本身的一部分。要查输出的命令写成 `printf 'rea%s\n' dy` 这样，让打印出来的 `ready` 不出现在命令里。`output` 要写成命令打印出来的完整一行。`running` 也只有 Bash 能用，而且必须带 `output`：它是「命令已经打印了这一行、还没结束」的同步点，等到它成立再去 `stop()` | 类型；`expectTool()` 的运行时检查 |
| 场景里的命令不要留下长时间运行的后台进程。命令自己的进程一结束，回合就照常继续，四个面都一样；但留下的进程只有 ACP 上会被编辑器清掉，TUI、Web、Desktop 上会一直留到它自己结束。Desktop 上应用退出后，它的输出可能还被应用进程组之外的东西握着（macOS 上是崩溃上报的辅助进程，它要等留下的进程结束才退出）；驱动等到限时，确认应用自己的进程都退出了，才放手，所以这样的用例会慢十秒左右。应用自己的进程没退干净则算收尾失败 | 评审。「回合照常结束、产品照常收尾」由 `waitIdle` 的自测固定 |

## 写驱动

动作清单是 `support/verbs.ts` 里的 `VERBS`，它是一张表：每个动作写明存在于哪些面（`on`）、不在某个面上的理由（`absentBecause`）、算不算「查过界面」（`checksInterface`），以及是不是由场景会话而不是驱动来做（`bySession`，目前只有 `restart`）。动作有 `send`、`queue`、`steer`、`approve`、`reject`、`rejectWithFeedback`、`expectApproval`、`answer`、`answerOther`、`dismissQuestion`、`setPermissionMode`、`stop`、`waitIdle`、`expectTool`、`expectReply`、`expectError`、`expectAbsent`、`continue`、`restart`、`newSession`、`compact`、`expectTranscript`，只在 TUI 和 Web 上有的 `resize`，只在 TUI 上有的 `exit`、`expectTerminalRestored`，以及只在 ACP 上有的 `waitForUsageUpdates`。场景拿到的 `product` 由这张表按场景跑的面推导：用了只在部分面上有的动作，场景必须用 `except` 或 `onlyOn` 排除其他面，否则类型检查报错；驱动漏实现自己面上的动作，类型检查也会报错。

| 规矩 | 由什么守 |
|---|---|
| 驱动只能做用户能做的操作：<br>TUI 只往真终端里写按键、读屏幕；<br>Desktop 和 Web 只点击、输入、读页面上的角色、名字、文字和状态，另外读文件按钮上的完整路径（界面上只在悬停提示里显示），Web 上还可以改浏览器视口（等于用户拖浏览器窗口）；<br>ACP 只像编辑器那样收发 ACP 消息，并回应 fs 和终端请求 | `scripts/checks/e2e-boundary.mjs` 的 import 白名单和后门清单；评审 |
| 不许在页面或 Electron 里执行代码，不许拦截或伪造网络请求，不许从测试直接请求产品的 HTTP 或 WebSocket 接口，不许 import 产品内部的包或旧夹具，不许带调试开关启动产品 | `scripts/checks/e2e-boundary.mjs` |
| 前置准备只能用用户自己也能用的方式：配置文件、命令行参数、用户文档里公开的环境变量。绕不过去的界面就在界面上走。隔离用的环境变量一律来自 testkit 的 `testEnv()` 和 `kimiCliEnv()`，驱动不自己拼 | 评审；`scripts/checks/e2e-boundary.mjs` 要求这个目录里出现的每个 `KIMI_*` 名字都写在 `docs/en/configuration/env-vars.md` 里 |
| 产品专门为测试加的开关和其他例外，只能登记在 `scripts/checks/e2e-boundary.json` 里并写明理由；不再用到的条目会被报出来 | `scripts/checks/e2e-boundary.mjs` |
| 改变状态的动作等到界面上出现证据才返回。动作先等到确定的状态再下结论：审批出现了或回合结束了，期望成立了或回合结束了，不靠超时来判断 | 驱动自测 |
| `expectTool` 和 `expectReply` 只看对话里最后一条用户消息之后的内容，不管这条消息是 `send` 或 `steer` 发的，还是排队之后被发出去的：TUI 上是转录里最后一个 `❯`，Desktop 和 Web 上是对话列表里最后一个不含嵌套列表的顶层行（用户消息就是这样的行；压缩分隔线、定时提醒、目标这类行也会被当成锚点，写到这些功能的场景之前要先收紧），ACP 上是最后一次 `session/prompt`。所以插话之前已经开始的工具，插话之后 `expectTool` 看不到，要在插话前用 `running` 加 `output` 查它；排队的消息都跑完之后，只看得到最后一条的回复。工具卡片不算回复，问题收集到的答案也不算（TUI 的 `Collected your answers` 块，Desktop 和 Web 的同名卡片和 `<问题> —— No answer` 那一行），工具调用前后的两段话不拼在一起匹配；被用户停止而没跑完的工具算 `failed`；回合是否结束要看产品自己的信号（TUI 的活动指示，ACP 的 `session/prompt` 答复，Desktop 和 Web 上 `Interrupt` 按钮不在、没有审批卡、输入框可见，并且页面内容连续两次读到的都一样），不能凭转录里出现的某段文字 | 驱动自测 |
| Desktop 和 Web 上，判断对话里有没有、有几次某段文字，读的是条目的文本内容（`filter({ hasText })`、`allTextContents()`），不读 `innerText`：回复正文的 Markdown 渲染库给刚出现的回复块设了 `content-visibility: auto`，浏览器画出这一块之前，它的 `innerText` 是空字符串。窗口一段时间不出帧时（比如同一台机器上另一个 Desktop 正在启动），按 `innerText` 数会少数，「恰好出现一次」这类检查因此会放过重复 | 评审 |
| `waitIdle()` 等到产品空闲：回合结束，没有挂着的审批，并且没有排队的消息（TUI 输入框上方的排队区是空的，Desktop 和 Web 上没有 `N waiting to send`）。排队的消息要都作为新回合跑完它才返回；挂着审批或问题时直接报错。`send()` 要求同样的空闲，回合在跑、有消息在排队或挂着审批时都报错。<br>TUI 上排队区空了还不够：产品从队列里取出下一条消息之后、开始新回合之前，会画出一帧没有活动指示、排队区也是空的画面，和真正空闲的画面一样。所以驱动记下 `queue()` 排进去的每条消息，要等它们都作为用户消息出现在转录里，才算空闲；等不到时，报错里列出还没出现的消息 | 驱动自测；破坏性检查：把产品出队后发送的延迟改成 300 毫秒，不等排队消息出现时，`queue`、`steer`、`waitIdle`、`expectReply` 里用到排队的自测和「排队消息按顺序跑」场景都变红 |
| ACP 的 `waitForUsageUpdates(次数)` 等当前会话收到恰好指定次数的 `usage_update`，次数超过时立即报错。用它同步配置了上下文上限的假模型场景：释放后台任务前先等前台回合的更新，再等后台通知回合结束后发出的下一次更新。后续用 `expectTranscript` 和 `expectTool` 检查编辑器收到的内容 | 驱动自测和后台任务场景 |
| `queue(文字)` 和 `steer(文字)` 只在回合正在跑时能用，产品空闲或挂着审批时报错；`queue` 遇到同样的文字已经在队列里也报错；`steer` 在队列里还有消息时报错，因为 TUI 的 Ctrl+S 会把整个队列连同这条一起插进去，Desktop 和 Web 只插这一条。<br>TUI：`queue` 粘贴后按 Ctrl+Q，不用 Enter（WaitFor 或 tower 模式下 Enter 会插话），证据是输入框上方的排队区出现 `❯ 文字` 这一行，排队区把它截短了就报错，所以消息要写短；`steer` 粘贴后按 Ctrl+S，证据是转录里多了一条 `❯ 文字`，并且排队区里已经没有它（插话还没被引擎收下时，它同时出现在两处）。<br>Desktop 和 Web：`queue` 在输入框里输入后按 Ctrl/Cmd+Enter，证据是排队区（`N waiting to send` 和 `Remove` 按钮所在的那一块）里出现名字就是这段文字的按钮；对话目录（`navigation`）里也有以用户消息为名字的按钮，不算排队。`steer` 输入后按 Enter（运行中发送默认是插话），证据是插话前最后一条用户消息之后出现了文字相同的用户消息行，并且排队区里没有它。不能照 `send()` 那样按对话长度找新行：在思考时插话，被中止的思考行会被删掉，插话正好落在它原来的位置上。<br>ACP 没有这两个动作：编辑器在一个回合里只能发一个 `session/prompt`，第二个会被拒绝（`-32600`） | 驱动自测 |
| `expectTool` 的 `running` 指命令已经在跑、还没结束：TUI 上块头是 `Running a command`，Desktop 和 Web 上卡片的状态是 `running`，ACP 上是这次工具调用已经出现、还没报出 `completed` 或 `failed`。回合已经结束时，没有命令算运行中。它必须和 `output` 一起用，因为各面对「还在等审批」的命令判断不一致：TUI、Desktop、Web 上等审批时卡片就已经显示运行中，ACP 上审批之前编辑器还不知道这是哪条命令。找不到、而界面上正挂着审批时，驱动直接报错，不等到超时；挂着的是别的命令的审批也一样 | 类型；`expectTool()` 的运行时检查；驱动自测 |
| `expectTool` 的 `output` 查的是这张卡片的输出区域里有没有完全相同的一行（去掉首尾空白后比较）。卡片头、命令本身、别的卡片和回复都不算。<br>TUI：块头之后、第一条转录记录（`Approved:`、`Rejected:`、`Interrupted by user`、`Error: [`）之前的那些行。命令自己打印了以这几个前缀开头的行时，这一行和它之后的内容不算输出。卡片折叠着的时候产品不显示全部输出：运行中只显示最后一行非空输出，前面还有别的行时这一行以 `… ` 开头，驱动比较前把它去掉；成功结束后超过三行也只显示最后一行；失败时超过四行只显示前三行。<br>Desktop 和 Web：卡片详情里标题为 `Output` 的面板的正文。驱动先点开卡片、读完再收回去，收不回去就报错，所以查完之后卡片一定是收起的。<br>ACP：这次工具调用最新一条带内容的更新里嵌着的终端，必须是编辑器为这条命令创建的，它的输出里有这一行 | 驱动自测 |
| 要查的那一行写短一点，不要用回车覆盖（进度条那种写法）：TUI 上太长的行会被截断或折行，带回车的行在三种界面上显示得不一样 | 评审 |
| 输出区域里除了命令打印的内容，还有两种不是命令打印的文字，不要拿它们当 `output`：产品追加在结果末尾的行（`Command executed successfully.`、`Interrupted by user`、`Command failed with exit code: 3.` 这一类），TUI、Desktop、Web 上有，ACP 的终端里没有；界面的占位和提示（Desktop 和 Web 的 `No output`，TUI 的 `Press Ctrl+B to run in background` 和 `cwd:` 行） | 评审 |
| ACP 上的 `output` 能证明两件事：产品没有把嵌在工具调用里的终端换掉（内容是整体替换的，所以只看最新一条）；命令确实打印了这一行。它证明不了输出被显示出来了：在 ACP 里那是编辑器的事，而这里的编辑器就是驱动自己。模型有没有拿到输出，由场景里的模型断言来查 | 评审；改坏产品的破坏性检查 |
| TUI 上 `stop()` 的证据是转录的最后一条变成了 `Interrupted by user`。只看到屏幕上多了一行不够：被停止的命令自己的卡片里也有同样的一行 | 驱动自测；改坏产品的破坏性检查 |
| `stop()` 在审批挂着时也能停止回合，TUI 除外。ACP 照真实编辑器的做法：发 `session/cancel` 之后立即对挂着的 `session/request_permission` 答复 `cancelled`，再等 `session/prompt` 以 `cancelled` 结束。产品里取消和审批答复是两条异步路径，模型收到的工具结果有时是 `Aborted before command started`，有时是「审批被取消」，两种都表示命令没跑，场景按两种都接受来写。Desktop 和 Web 上审批卡展开时 Esc 等于拒绝，所以先点卡片的 `Minimize`，等卡片收起（`Expand` 出现，`Minimize` 和 `Approve` 不见了）再按两次 Esc，证据是回合空闲、出现 `Manually stopped`。TUI 报错：面板上 Esc、Ctrl+C、Ctrl+D 都等于拒绝，用户没法不回答审批就停止回合 | 驱动自测 |
| 审批的回答：`approve()` 只批准这一次。`approve({ for: 'session' })` 批准，并让本会话里同样的操作不再询问（Bash 按完整命令，Edit 和 Write 按工具加路径）：TUI 按 `2`，证据是转录多出 `Approved for session: …`；ACP 选 `approve_always`；Desktop 和 Web 点 `Approve for session`，证据是这个按钮消失。`rejectWithFeedback(理由)` 拒绝并把理由交给模型：TUI 按 `4`，在行内输入框里粘贴理由再回车，证据是转录多出以 `— "理由"` 结尾的 `Rejected: …`；Desktop 和 Web 点 `Feedback`，在 `Explain why you are rejecting…` 里输入，点 `Reject with feedback`，证据是这个按钮消失。ACP 没有 `rejectWithFeedback`：权限选项只有选项 id，编辑器没法附上理由 | 驱动自测 |
| `expectApproval({ name, target })` 先等到审批出现或回合结束，只看审批，不回答它。工具名对的是审批的标题：TUI 的 `Run this command?`、`Apply these edits?`、`Write this file?`，Desktop 和 Web 的 `Run command?`、`Apply changes?`、`Write file?`，ACP 审批请求的 `toolCall.title`。Bash 要看到完整的命令：TUI 是面板里 `$ ` 开头的那一行连同它的折行（去掉空白后比较），Desktop 和 Web 是卡片里恰好等于 `$ 命令` 的一行，ACP 是审批请求的 `rawInput.command`，或者标题、文字内容里等于命令或以 `: 命令` 结尾的一行。文件要看到路径：一行等于工作区相对路径、以空格加相对路径结尾，或者以 `<工作区>/<路径>` 结尾；ACP 还认 diff 的 `path`、`locations` 和 `rawInput` 里的路径。ACP 只看审批请求里的 `toolCall`，不看审批之前 `tool_call_update` 里的参数 JSON：编辑器在审批时显示的是请求里的内容 | 驱动自测 |
| `answer(选项)`、`answerOther(文字)`、`dismissQuestion()` 先等到问题出现或回合结束：回合结束了报错，挂着的是审批就立即报错。`answer` 和 `answerOther` 只回答一次一个、单选的问题，模型一次问了几个问题时报错（`dismissQuestion` 照样能把它们关掉）；`answer` 的选项不在列表里时报错，列出能选的，什么都不选。<br>TUI：问题面板占着输入框的位置，以一条横线和 `question` 开头。`answer` 按选项前的序号键，面板自动翻到 Submit 页，驱动确认上面写着 `→  选项`、光标在 `→ [1] Submit` 上再回车；`answerOther` 按最后一项（Other）的序号键，粘贴文字，等它出现在 `Other: ` 后面，回车保存，再在 Submit 页回车；`dismissQuestion` 按 Esc。证据是本回合多出 `● Collected your answers` 块，里面有 `→  答案` 这一行；关掉的问题，块里是 `User dismissed the question without answering.`。<br>Desktop 和 Web：问题卡没有容器角色，选项是没有角色的 `<label>`，驱动只能在问题卡（从 `Submit` 或 `Next question` 按钮往上、含 `Minimize` 按钮的最近一层）里按文字点选项，这是一处可访问性缺口。`answerOther` 在名字以 `Other` 开头的输入框里输入（名字后面带快捷键数字）。然后点卡片里的 `Submit`，证据是按钮消失，并且本回合出现 `Collected your answers` 卡片，问题下面一行是答案。`dismissQuestion` 点卡片里最后一个 `Dismiss`（卡片头上还有一个同名按钮），证据是本回合出现 `<问题> —— No answer`。<br>ACP：问题是 `toolCall.title` 为 `AskUserQuestion` 的 `session/request_permission`，选项是各个选项名（`q0_opt_<序号>`，`allow_once`）加 `Skip`（`q0_skip`，`reject_once`）；`answer` 按名字选，`dismissQuestion` 选 `Skip`，证据是答复已发出。驱动不声明 elicitation，所以一次问几个问题时 agent 只用权限请求问第一个，驱动从同一个工具调用的 `rawInput.questions` 认出问了几个。ACP 没有 `answerOther`：权限请求只有选项 id，编辑器没法回一段文字 | 驱动自测 |
| 挂着问题时，回答审批的动作（`approve`、`reject`、`rejectWithFeedback`）、`expectApproval` 和 `waitIdle()` 立即报错 `a question is pending…`，不等到超时；`queue`、`steer` 也报错。`stop()` 挂着问题时四个面都报错：TUI 上 Esc 和 Ctrl+C 等于关掉问题，Desktop 和 Web 上问题卡替掉了输入框和 `Interrupt` 按钮、Esc 等于 `Dismiss`，用户都没法不回答就停止回合；ACP 为了四个面一致也不停 | 驱动自测 |
| `expectTool({ name: 'AskUserQuestion', target: 问题原文, status: 'done' })` 找本回合问过这个问题的卡片，答了和关掉都算 `done`。TUI：`Collected your answers` 块里 `Q  问题` 后面紧跟 `→  答案`；关掉的问题，这个块只写着已关掉、不显示问题，所以 TUI 上找不到关掉的问题，驱动报错时说明这一点。Desktop 和 Web：展开着的 `Collected your answers` 卡片里，标签之后按「问题、答案」成对排列的行里问题那一行（答案那一行不算），或者 `<问题> —— No answer` 这一行。ACP：`tool_call` 的标题是 `AskUserQuestion`，`rawInput.questions` 里有这个问题，状态 `completed`，并且编辑器答复过这次工具调用的问题 | 驱动自测 |
| `setPermissionMode(mode)` 的 `mode` 用配置里的名字：`manual` 是 Always Ask，`yolo` 是 Ask When Needed，`auto` 是 Never Ask。产品空闲时才能用，已经是这个模式也报错。TUI 粘贴 `/permission` 回车，在 `Select permission mode` 里用方向键移到目标再回车，证据是转录多出 `Permission mode: <界面名>`。ACP 发 `session/set_mode`（`default`、`yolo`、`auto`），证据是答复成功，并且收到同一个模式的 `current_mode_update`。Desktop 和 Web 点输入框旁、名字是当前模式的按钮，在菜单里点名字以目标模式开头的 `menuitemradio`，证据是按钮名变成目标模式。Desktop 的这个菜单画在单独的窗口 `app://renderer/browser-overlay.html` 里，驱动在那个窗口里按角色和名字点 | 驱动自测 |
| `expectError(文字)` 先等到失败出现或回合结束，回合正常结束时报错。`文字` 对的是模型服务返回的错误信息，也就是剧本里 `httpError` 的 `message`。只看最近一条用户消息之后。<br>TUI：一行以 `Error: [` 开头、后面紧跟固定提示 ``If this persists, run `/export-debug-zip`…`` 的行，`] ` 之后的文字（可能折行，压掉空白后比较）包含 `文字`。这一行挂在上一块的缩进下面，没有 `●` 或 `✗`，按块切分会漏掉，所以驱动按行找。回复里引用的 `Error: [x] …` 后面没有那行提示，不算失败。<br>Desktop 和 Web：页面上可见、不在 `inert` 里的 `alert`，也就是 `Model request failed — this turn was interrupted` 那张卡片，里面有 `文字`。它在对话列表外面，只在回合结束、最近一回合失败时出现。<br>ACP：`session/prompt` 以 JSON-RPC 错误结束，错误码不是 `-32600`、`-32602`，错误的 `message` 里有 `文字`（401 一类的认证失败是 `Authentication required: …`）。`waitIdle()` 照旧不评判失败的回合 | 驱动自测 |
| `expectAbsent(文字)` 查最近一回合的回复里没有这段文字，范围和 `expectReply` 一样：工具卡片、用户消息、更早的回合都不算。调用时产品必须已经空闲，否则直接报错、不等待，因为回合还在跑时「还没出现」和「不会出现」分不开。它不算查过界面，场景里还要有一个通过的 `expectReply` 一类的检查 | 驱动自测；收尾检查 |
| `continue()` 只在 Desktop 和 Web 上有：先等到失败的回合或回合结束，点失败卡片（`alert`）里的 `Continue`，证据是这张卡片消失。没有失败卡片时报错；用户停止的回合也没有，那里只有 `Manually stopped`。模型收到的下一次请求里没有新的用户消息，`remindersSinceReply` 末尾多一条 `No new user message was sent. Continue the interrupted work…`。TUI 和 ACP 上没有这个动作，用户在那里再发一条消息 | 驱动自测 |
| `tui-kitty`：驱动扮演支持 Kitty 键盘协议的终端。它读 CLI 输出里的协议序列（`CSI > n u` 推入、`CSI < n u` 弹出、`CSI = n ; m u` 设置），对查询（`CSI ? u`）回答当前的标志位；协议开着时，Esc 和 Ctrl+C、Ctrl+O、Ctrl+Q、Ctrl+S 按 Kitty 编码发送；标志位要求松开事件时，这几个键和方向键另发松开事件（方向键按下仍是旧编码）；数字、回车和粘贴不变。驱动只模拟标志位 1、2、4，CLI 要了别的位、或者弹出的层比推入的多，都报错。启动后 CLI 必须开着协议、没有退回 modifyOtherKeys，否则启动失败；`expectTerminalRestored()` 另要求 CLI 退出后把协议关掉、推入的层都弹出 | 驱动自测在这个 project 里全部再跑一遍；破坏性检查：不回答查询时启动失败，Ctrl+S 编错时插话的正例变红 |
| `acp-bare`：编辑器在 `initialize` 里不声明任何能力，也不处理 fs 和终端请求，产品调用了就按「调用了编辑器没实现的方法」在收尾时报错。产品自己读写文件、自己跑命令，所以不要求编辑器那一侧的证据，命令的输出从工具调用内容的文字里读。编辑器不提供终端时产品要等命令结束才给出输出，这是产品缺口，「运行中的输出」相关的 3 条用例在这个跑法下先排除，等负责人定 | 驱动自测在这个 project 里全部再跑一遍 |
| `compact()` 照用户的做法手动压缩上下文，产品必须空闲，压缩完才返回。TUI 输入 `/compact` 回车，证据是转录里多一条 `Compaction complete`（出现 `Compaction cancelled` 就报错）；Desktop 和 Web 在输入框里输入 `/compact`，回车选中命令、再回车发送，证据是对话里多一条 `Context compacted`；ACP 像编辑器那样把 `/compact` 作为提示词发出，产品先回答压缩已开始，压缩在后台跑完后另发一段 `Compaction completed.`，证据就是这一段（取消或被挡住时报错）。压缩请求走假模型的 `compaction` 通道，剧本用 `model.lane('compaction').script(...)`。压缩被拒绝时 TUI 显示 `Compaction cancelled`、ACP 补发 `Compaction cancelled.`，驱动立即报错；Desktop 和 Web 什么都不显示，驱动只能等到限时。压缩之后、下一次发消息之前，各面的「最近一回合」不一样（TUI 是压缩前的最后一回合，Desktop 和 Web 是分隔线之后、是空的，ACP 是 `/compact` 那一回合），所以压缩后先发消息再查 | `compact` 的自测；破坏性检查：TUI 不等压缩完成时正例变红 |
| `newSession()` 新建一个会话，产品必须空闲。TUI 输入 `/new`，证据是屏幕上最后一条 `Started a new session (…)` 里的会话 ID 变了（`/new` 会清掉滚动区，所以不能数这一行出现了几次）；Desktop 和 Web 点侧栏的 `New Session`，证据是对话变空、消息输入框可用（对话本来就是空的时候，这个证据分不出按钮有没有生效）；ACP 像编辑器新开一个对话那样发 `session/new`，要求拿到另一个会话 ID，之后对话、模式和最近一回合都只看新会话的消息，离开的会话晚到的通知丢掉。新建会话之后、发消息之前重启，驱动只等产品重新可用，不再等之前会话的提示词。新会话的第一条请求里不应有之前会话的内容，这一点由自测固定 | `newSession` 的自测 |
| 重启：TUI 用同一个 home 和工作区跑 `kimi --continue`，等转录里出现上一条提示词；ACP 新起 `kimi acp`，要求 `initialize` 公布 `loadSession`，再对原会话 ID 发 `session/load`，回放在答复之前到齐；Desktop 用同一个 `--user-data-dir` 再启动，不再传 `--workspace`；Web 用原来的端口重新起 `kimi web`，浏览器从第一次启动就用持久的配置目录（`<测试目录>/web-profile`），重新打开它打印的地址。Desktop 和 Web 重启后不点引导向导，向导如果又出现就报错；它们都要自动回到原来的会话，等对话里出现上一条提示词 | `restart` 的自测 |
| `resize(尺寸)` 只在 TUI 和 Web 上有，尺寸是 `normal` 或 `narrow`，产品启动时是 `normal`，改成当前的尺寸就报错。<br>TUI：`normal` 是 120×40，`narrow` 是 60×40。驱动先改虚拟终端，再改伪终端的尺寸（CLI 收到 `SIGWINCH`）；证据是改尺寸之后 CLI 清屏重画了一次（`ESC[2J ESC[H ESC[3J`），屏幕上最后一条输入框或面板的横线是新宽度，并且连续两次读到的屏幕一样。只看横线不够：xterm.js 会把旧的整行横线折成两行，长度可能正好等于新宽度。Windows 上 ConPTY 会自己重新输出整个画面，不原样转发清屏的序列，所以只要求改尺寸之后收到了新的输出、横线是新宽度。这个证据更弱：ConPTY 自己的重画也算新输出，审批面板那种没有拐角的整行横线被折行后可能正好是新宽度，所以 Windows 上证明不了 CLI 自己重画了，「不发尺寸变化时正例超时」这条破坏性检查在 Windows 上也不成立。<br>Web：`normal` 是 1440×900，`narrow` 是 390×844（手机宽度），用 Playwright 改视口；证据是当时在屏幕上的输入区域（消息输入框，或者挂着的审批卡、问题卡）宽度变了、整块落在视口里，并且连续两次读到的位置一样。<br>重启之后保持重启前的尺寸，和用户在同一个窗口里重新打开产品一样。<br>ACP 没有窗口；Desktop 的窗口最窄 900 像素，用户拉不到手机宽度，而且只能在 Electron 主进程里执行代码才能改 | 驱动自测固定「能在空闲、审批挂着、重启之后改」和「改成当前尺寸就报错」；「产品没重画就不返回」造不出用户走得到的反例，靠改坏驱动的破坏性检查（不发 `SIGWINCH`、不改视口时正例超时） |
| TUI 的 `exit()` 照用户的做法退出，等退出标记和伪终端关闭，要求退出码 0；`expectTerminalRestored()` 读启动脚本在 CLI 退出后、在同一个 shell 里跑的 `stty -a`，要求 `icanon` 和 `echo` 都开着 | `exit`、`expect-terminal-restored` 的自测只固定前置条件；「模式没恢复就报错」造不出用户走得到的反例，靠评审和改坏驱动的破坏性检查 |
| 每个动作在每个面上都要有正例和反例。自测写成 `selfTest('动作', { positive, negative })`，放在以动作命名的文件里；要加动作，先改 `VERBS`。某个用例要用只在部分面上才有的动作（例如 `waitIdle` 的自测里用 `queue`），写成 `selfTestCase({ except: … }, run)`，`run` 拿到的 `product` 按这个用例跑的面收窄 | `selfTest()` 登记时检查每个面都有正反例；`self-test/coverage.spec.ts` 检查每个动作都有自测文件 |
| 动作的含义由自测固定，改自测就等于改含义 | CODEOWNERS 评审 |
| 产品不连真网络：会去 CDN 下载的工具和 Desktop 启动时要取的模型目录，在 `surfaces/offline.ts` 里桩成 404，其余对外连接由 testkit 的网络守卫记下 | 收尾检查 |
| 产品进程的环境一律用 `surfaces/environment.ts` 的 `productEnv()`：它在 `kimiCliEnv()` 的基础上去掉 testkit 给单元测试关掉的会话索引读模型和搜索 worker，让产品按用户的默认配置跑。工作区信任仍由 `kimiCliEnv()` 预先设好（`KIMI_CODE_TRUST_WORKSPACE`），设了 `workspaceTrust` 的场景去掉这个变量 | 评审 |
| Desktop 和 Web 的页面操作都在 `surfaces/renderer.ts` 里，两个面共用。挂着的审批只认按钮可见而且可点的审批卡：用户点了之后、产品处理完之前，卡片还在但按钮是禁用的，这时不算有审批要回答。证据只认用户看得见的内容：收起的工具分组和收起的卡片详情（页面上带 `inert`）里的东西不算，所以查工具卡片之前先点开收起的分组。只有一处例外：区分 rejected 和 failed 时，拒绝说明读自卡片的详情，不要求详情是展开的 | 驱动自测；评审 |
| Desktop 和 Web 上，工具卡片靠三样认出来：工具标签（Bash 的标签是 `Run`）、目标、状态。文件类工具的目标对的是文件按钮上的完整路径，不是只对文件名；Bash 的目标对的是卡片头上的命令，命令输出里的文字不算。回复只认 Markdown 渲染出来的那一块，思考块和工具卡片不算。一块内容要么是回复、要么是卡片：回复里写了工具标签和目标（例如加粗的 `Run` 后面跟一段命令，或者被渲染成文件链接的文件名）不算工具卡片 | 驱动自测 |
| Desktop 用启动参数 `--workspace=` 打开工作区，引导向导在界面上点 `Skip` 跳过。网络分三路：主进程里 Node 发的请求由 testkit 的网络守卫记下；渲染进程的请求由驱动记下（只看不拦）；域名解析用启动参数关掉。有一路记不到：主进程经 Electron 的 `net` 发的请求走 Chromium 的网络栈，只会因为域名解析被关而失败，不会让用例变红 | 评审 |
| Desktop 的发送要认出「新出现的那条消息」：看消息在对话里的位置，不数同样文字出现了几次，也不记这一行的内部标识。对话列表只渲染视口附近的行，而且新消息这一行在服务端确认前后会换标识 | 驱动自测 |
| Desktop 和 Web 的发送先输入文字，再等界面上的 Send 按钮可用，最后按 Enter。项目的信任状态仍在读取时，输入框可以编辑，发送入口暂不可用 | `surfaces/renderer.ts` |
| Web 把 `kimi web --port <端口> --no-open` 当子进程启动，读它打印的 `Local:` 地址，用 Chromium 打开。地址原样使用，不加任何额外参数。端口不用 `--port 0` 向系统要：系统分配的端口在动态端口范围里（Linux 默认 32768–60999，macOS 和 Windows 是 49152–65535），重启时产品关掉的那一两秒里，任何向系统要空闲端口的进程（例如并行 worker 刚起的假模型或 `kimi web`）都可能分到它，页面就回不到同一个 origin。所以首次启动的端口取自 10000–31999：`support/global-setup.ts` 每次运行随机定一个起点，每个 worker 按 Playwright 的 `parallelIndex` 占 10 个端口，同时在跑的用例不会要同一个端口，同一台机器上同时跑的两次运行也很少撞上。端口被别的程序占着时产品自己往后顺延，驱动用它实际打印的端口；顺延出这 10 个端口时驱动报错，因为再往后是别的 worker 的端口，这个 worker 重启时可能被它拿走。引导向导在界面上点 `Skip` 跳过，工作区在页面的 `New project` 对话框里填路径添加。服务端进程用 testkit 的网络守卫，页面这一侧和 Desktop 一样由驱动记下 | 评审；端口落在本机的动态端口范围里（Linux 读 `ip_local_port_range`，其他平台按 49152–65535）时 `restart()` 直接报错。破坏性检查：首次启动改回 `--port 0` 时，Web 上每条走到重启的自测都变红 |
| Web 结束时，页面里不能有未捕获的错误，页面不能有发往本机以外的请求或 socket；关掉浏览器之后给服务端所在的进程组发 Ctrl+C，它要在限时内以 0 退出。这一条查得出服务端卡住或崩溃，查不出「关闭过程出了错」：产品在关闭出错时也以 0 退出，默认也不打印日志 | 收尾检查 |
| Desktop 和 Web 共用的记录和收尾在 `surfaces/page-driver.ts` 里：发往本机以外的请求和 socket、页面里的未捕获错误、trace、失败时的页面内容。这两个面的驱动只管各自的进程怎么启动、怎么退出 | 评审 |
| Desktop 结束时，窗口里不能有未捕获的错误，应用要以 0 退出，渲染进程不能有发往本机以外的请求。退出用的是 Playwright 的 `close()`，它在主进程里调用应用的退出，不是用户点的退出；这是驱动里唯一一处在产品进程里执行代码的地方，查的是应用收到退出请求后能不能干净退出 | Desktop 驱动的收尾检查 |
| TUI 驱动像真终端那样对待同步输出：产品用 `ESC [?2026h` 和 `ESC [?2026l` 包起来的一帧，收齐了才写进虚拟终端。否则伪终端把一帧切成几段送来时，读屏幕会读到只画了一半的帧，例如输入框和排队区还没画出来 | 驱动自测（`queue` 的「同样的文字已经在队列里」反例在读到半帧时会漏判） |
| 每个驱动实现 `frame()`，返回用户此刻看到的画面：Desktop 和 Web 是主页面的 1 倍截图，TUI 是终端当前的视口文本，ACP 没有界面，是编辑器这一侧本回合收到的内容加上上一帧之后新增的 JSON-RPC 消息。取画面只能用只看不改的手段：截图时不隐藏光标（`caret: 'initial'`），不在页面里执行代码，不往界面里画任何东西，不用会改页面的截图选项（`style`、`mask`、`animations: 'disabled'`） | 评审 |
| Desktop 和 Web 的驱动按产品的默认设置和英文界面工作。「消息自动折叠」默认是关的，打开之后被折起来的卡片驱动找不到 | 评审 |
| ACP 上工具的结果不能只看 agent 自己报的状态，还要核对编辑器这一侧：Read 完成，要在这次工具调用期间有一条同一路径、编辑器答复成功的 `fs/read_text_file`；Edit 和 Write 完成，要有同样条件的 `fs/write_text_file`；Bash 完成，它引用的终端必须是编辑器建的、跑的是这条命令、退出码是 0 | ACP 驱动的 `expectTool`。场景和自测只能证明它不误报；真实产品造不出反例，靠改坏驱动的破坏性检查和评审 |
| ACP 的 stdout 上只能有 JSON-RPC 消息，agent 只能调用编辑器实现了的方法，编辑器只往测试目录里写文件，结束时没有还在跑的终端命令，进程在输入关闭后以 0 退出 | ACP 驱动的收尾检查 |
| ACP 上每条 `session/update` 都要通过 SDK 的 schema | 没通过的通知到不了驱动，回合就永远不算结束：等待超时，报错里写明收到几条、通过几条 |
| 编辑器的行为照真实编辑器来：命令一退出就报告退出状态，不等它留下的后台进程；`terminal/release` 之后这个终端就不存在了；命令起不来时 `terminal/create` 直接失败 | 评审 |

## 看每一步的画面

- 每个动作在报告里是一个中文命名的步骤，例如「用户发送「Read a.txt.」」「用户批准」「检查工具卡：Edit「b.txt」已完成」「检查回复里有「Done.」」。标题由 `support/steps.ts` 生成，加动作时 `STEP_TITLES` 不补上就过不了类型检查。
- 启动产品和前置准备（引导向导、添加工作区）合成一个步骤「启动产品，等到可以输入」。产品就绪、拍完工作区快照之后，存一帧「00 启动完成」。
- 场景的每一步完成后，support 调驱动的 `frame()` 存一帧，按步骤编号命名，例如「03 用户批准之后」。工作区的 `write`、`expectFile`、`expectMissing` 也是中文步骤（「用户在磁盘上把…写成…」「检查磁盘：…」），不存帧，也不占编号。
- 用例失败时（动作报错、断言不成立、超时），收尾前、关闭产品之前再存一帧。动作报错的，这一帧用那一步的编号和标题，例如「03 用户批准：失败时的画面」；其余的用下一个编号，叫「07 失败时的画面」。两种失败没有这一帧：启动失败（还没有画面，报错里有启动时的页面内容和输出），收尾检查失败（产品已经关了，看收尾检查的报错和诊断附件）。
- 驱动自测不存每一步的帧，只在失败时存这最后一帧：反例本来就要动作报错，通过的自测不留画面。
- 画面只当证据，不拿来做断言。取画面失败不会让用例变红，那一帧会写成「取不到这一刻的画面」和原因。
- 帧的附件名以 `.png` 或 `.txt` 结尾。Playwright 拿附件名里最后一个点之后的部分当文件扩展名，名字里的「b.txt」会让截图存成打不开的文件。
- 本地跑完用 `pnpm --filter @moonshot-ai/e2e exec playwright show-report` 打开报告。Desktop 和 Web 的帧在用例的「Screenshots」里，TUI 和 ACP 的帧在「Attachments」里。
- CI 上每个面的报告不管红绿都上传成 artifact `e2e-<面>-report`，保留 7 天；失败时另传 `e2e-<面>-failure`（`test-results/`）。分片的面在名字后面加片号，例如 `e2e-desktop-report-2`。报告解压后双击 `index.html` 就能看步骤和画面。Desktop 和 Web 失败时的 trace 在附件 `desktop-trace`、`web-trace` 里，报告不会把它们显示成「View Trace」，下载后用 `pnpm --filter @moonshot-ai/e2e exec playwright show-trace <zip>` 打开。
- 运行页的摘要由 `support/run-summary.ts` 在设置了 `GITHUB_STEP_SUMMARY` 时写出：整体结果，不属于任何用例的错误（例如加载场景文件时出错），每个面的场景结果表和自测的通过数。摘要里写的 artifact 名字和 `.github/workflows/e2e.yml` 里的要一致。
- 报告会作为公开仓库的 artifact 上传，场景里的提示词、文件内容和剧本只能用假数据。

## 红了怎么办

- **先分清是产品坏了还是驱动坏了。** 自测也红，多半是驱动或产品的界面变了；只有场景红，先看场景断言的那条产品行为。
- **不许靠重试、加等待、跳过让它变绿。** flaky 用例照根 `AGENTS.md` 的规则处理：先找根因。实在找不到根因可以删，PR 里写明删掉的用例原来覆盖什么、现在由谁覆盖。
- **看失败附件。** 先看报告里这个用例的步骤：红在哪一步，最后一帧「失败时的画面」是什么样。每个失败的用例还附上假模型的请求摘要、网络守卫的记录和产品日志；TUI 另有完整的屏幕内容、最近的输入和退出码；ACP 另有按顺序记下的 JSON-RPC 消息（最近 4000 条）、不是 JSON-RPC 的 stdout 行和 stderr 末尾；Desktop 和 Web 另有 Playwright trace（用 `pnpm --filter @moonshot-ai/e2e exec playwright show-trace <trace.zip>` 打开）、页面内容的末尾、应用或服务端的输出和页面里的未捕获错误。产品没能启动（包括 `restart()` 之后没能重新启动）时，驱动在关掉进程之前收集同样的诊断，附件名前加上第几次启动，例如 `launch-1-desktop-trace`、`launch-2-tui-screen`；Web 在打开页面之前就失败时，附上 `kimi web` 终端里的内容（`launch-1-web-server`）。隔离目录在失败时保留，路径记在用例的 `test home` 标注里。

## 不在这里做的事

- 不往 `tests/protected.yaml` 登记。现在登记的 Playwright 条目都会被当成 Desktop 旅程去检查。
- 不写 `@quarantine`。`scripts/checks/quarantine.mjs` 只允许 Desktop 旅程进隔离名单。
