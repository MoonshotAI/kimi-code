# 桌面端 e2e（Playwright）

`apps/desktop/e2e/` 用 `@playwright/test` 的 `_electron.launch` 启动构建产物（`apps/desktop`，入口 `out/main.cjs`），按用户旅程验证桌面端。每条旅程一个长用例，模型由本地 stub 代替，浏览器操作由测试直接调用内置浏览器 MCP 驱动，不接真实模型、不依赖网络。

e2e 不进 `pnpm test`（vitest 只收 `*.test.ts`），也不进 PR 的 `ci.yml`。

## 本地运行

前置：`pnpm install`；Linux 没有图形会话时会自动通过 `xvfb-run` 提供虚拟显示，headless 模式也始终使用虚拟显示。

```bash
pnpm e2e:desktop                     # 构建 desktop 后以 headed 模式运行全部 spec，窗口可见
pnpm e2e:desktop:headless            # 原安静模式：不抢焦点、不激活应用、不上屏
pnpm e2e:desktop -- --no-build       # 跳过构建，直接用现有 out/ 与 desktop-dist/
pnpm e2e:desktop -- --no-build --repeat-each=20 core-turn
```

`--no-build` 以外的参数原样传给 `playwright test`。也可以在 `apps/desktop` 下直接运行 `pnpm exec playwright test -c e2e`，此时需自行先 `pnpm run build`，默认同样是 headed 模式，headless 模式用环境变量 `KIMI_E2E_HEADLESS=1`。

失败时 trace（含截图）和 Electron 输出写在 `apps/desktop/test-results/e2e/`，用 `pnpm exec playwright show-trace <trace.zip>` 查看；失败用例的临时目录会保留并记在用例 annotation 里。

### 安静模式

测试进程给应用设置 `KIMI_DESKTOP_E2E=quiet`（可见模式为 `1`），仅对未打包构建生效。焦点约束集中在 `e2e/fixtures/main-shim.cjs`，在应用代码之前生效，不靠逐个调用点处理：

- macOS 在任何窗口创建之前把激活策略设为 `prohibited`：应用不进 Dock、不能被激活，Electron 内部的 `activateIgnoringOtherApps` 也不生效。应用入口在安静模式下同样设置该策略。
- 应用通过 `require('electron')` 拿到的 `BrowserWindow` / `BaseWindow` 被替换为子类，强制 `show: false`、`focusable: false`、`skipTaskbar: true`、`paintWhenInitiallyHidden: true`，`BrowserWindow` 关闭后台节流；`window.open` 放行的子窗口同样带上这些选项。
- 抢焦点的 API 改为空操作并记录：窗口的 `focus`、`moveTop`、`setAlwaysOnTop`、`flashFrame`，`show` 改走 `showInactive`，`showInactive` 先把窗口设为透明度 0、忽略鼠标、不进任务栏并移到屏幕外再显示；所有 WebContents（含 WebContentsView）的 `focus`；`app.focus`、`app.show`、`app.dock.show`、`app.dock.bounce`。用例收尾时把被拦下的调用汇总为 annotation 并打印到 stderr。
- 所有窗口（主窗口、截图、预览等辅助窗口）创建时即为透明度 0、忽略鼠标、不进任务栏并位于屏幕外，显示后页面照常渲染；所有 WebContents 关闭后台节流，Windows 关闭原生窗口遮挡计算（`CalculateNativeWinOcclusion`），屏幕外窗口不被当作被遮挡而降速；不创建托盘图标。
- 安静模式下测试进程对主窗口模拟 `prefers-reduced-motion: reduce`，浏览器控制层随之停用持续动画。Windows CI 没有 GPU，控制层旋转的光谱动画由 GPU 进程软件渲染，会占满一个核心，拖慢所有页面的断言、点击和截图合成。
- 两种 e2e 模式都不自动打开 DevTools，也跳过“仍有会话在运行”的退出确认。

macOS 上 `webContents.focus()` 会调用所在窗口的 `Focus(true)`，进而 `[NSApp activateIgnoringOtherApps:NO]`；浏览器浮层打开页面对话框、控制层和标注拾取都会调用它，透明窗口因此在不可见的情况下夺走键盘焦点。

### 焦点检测

`e2e/focus-watch/` 是可用于验证 headless 焦点约束的检测器。被测命令作为检测器打开的前台程序的子进程运行，与开发者在终端里启动测试的情形一致（前台程序的子进程才有资格抢前台）：

- macOS `focus-watch.swift`：`focus-watch <log> [--passive] -- <command...>`。自身作为前台应用打开一个带输入框的窗口并激活，再启动命令；监听 `NSWorkspace` 的应用激活通知、自身失去激活和 key window 的通知，每 10 ms 采样前台应用，后台线程每 20 ms 枚举所有上屏的普通层窗口。名称含 electron / kimi 的应用被激活或成为前台、这类应用有透明度不为 0 的上屏窗口（逐个列出，启动前已在屏幕上的窗口不计），或中性窗口失去激活 / key 状态，都记为违规。`--passive` 不建窗口，只旁路观察。
- Windows `focus-watch.ps1 -Log <log> -Command <command>`：在新的控制台窗口里运行命令并把该窗口置为前台，每 10 ms 采样 `GetForegroundWindow` 所属进程，前台属于 electron / kimi 进程，或这类进程有可见、未最小化、透明度不为 0 且与屏幕相交的顶层窗口，即违规。

命令失败时检测器返回命令的退出码，否则有违规返回 1。可以先用 `steal-control.cjs`（普通 `show()` + `focus()` 的 Electron 窗口）确认检测器能抓到抢焦点；再用 `--inactive`（只 `showInactive()`、不激活）确认两端的可见窗口枚举能抓到上屏但不抢焦点的窗口；再用 `--quiet`（预加载 `main-shim.cjs` 的安静模式下同时 `showInactive()` 和 `show()` + `focus()`）确认安静模式下没有违规且对照程序正常退出。需要验证焦点约束时，再把启动 Electron 的单元测试或 `e2e:desktop:headless` 放到检测器下运行。

### Electron 单元测试

`pnpm test` 中真正启动 Electron 的用例（`browser-local-file-probe`，以及只在 Windows 运行的 `screenshot-frame`）只建 `show: false` 的窗口；`local-file-probe.cjs` 在 macOS 上启动即设 `prohibited` 激活策略，因此本机也不会激活应用。

### 原生界面守卫

`e2e/fixtures/main-shim.cjs` 以 `-r` 预加载进主进程，在应用代码之前替换 `dialog.showMessageBox(Sync)`、`showOpenDialog(Sync)`、`showSaveDialog(Sync)`、`showErrorBox`、`showCertificateTrustDialog` 以及 `shell.openExternal`、`openPath`、`showItemInFolder`：调用只被记录并返回取消，屏幕上不会出现任何原生窗口。`app` fixture 收尾时若有记录，用例失败并列出每次调用。安静模式隐藏的是应用窗口，系统级原生对话框不受它影响，所以守卫对两种模式都生效。需要原生对话框参与的旅程用 `app.answerNativeDialog(api, answer)` 预置一次性应答（如 `showOpenDialog` 返回工作区路径），而不是放宽守卫；被预置应答消费的调用不算违规，收尾时仍未用掉的应答会让用例失败。

应用还会预置 `kimi-web.notify-enabled=0`，避免系统通知授权提示；钥匙串由 Playwright 的 `--use-mock-keychain --password-store=basic` 处理。

### 收尾

收尾顺序：结束 stub 模型挂起的回合 → 关闭 MCP 客户端 → 读取原生调用记录 → `electron.close()`。`app.relaunch()` 对当前进程走同样的收尾，再用同一套 `KIMI_CODE_HOME` / userData 重新启动。15 秒内未退出则杀掉整个进程树（macOS / Linux 杀进程组，Windows `taskkill /T /F`）并让用例失败。

## CI

`.github/workflows/desktop-e2e.yml` 支持手动、`release/*` 推送和 E2E 相关同仓 PR 触发：

- 手动运行使用输入的 ref 和 OS（默认 `macos-windows`，即 macOS 和 Windows 各一台自托管 runner），`spec_filter` 可只跑匹配的用例；`release/*` 推送使用被推送提交的 SHA，只运行一台 macOS 自托管 runner。macOS 通过共享的 `fullmoon-e2e-macos` label 调度，由 GitHub 按可用性在 26、27 两台 runner 中选择一台。
- 修改 `apps/desktop/e2e/**` 或该 workflow 的同仓 PR 自动运行 macOS 和 Windows 各一台自托管 runner，测试 GitHub 为该 PR 生成的 merge commit。fork PR 不自动在自托管 runner 上执行，需要时由维护者手动运行。
- 手动重跑同组可取消旧的手动 run；同一 PR 的新提交可取消该 PR 的旧 run；release 推送不取消旧 run，手动、PR 与 release 运行互不取消。

```bash
gh workflow run desktop-e2e.yml -f ref=<branch> -f os=all   # os: ubuntu | macos | windows | macos-windows | all
```

工作流安装依赖、构建 desktop，以 headed 模式运行启动 Electron 的单元测试和 e2e（Ubuntu 只跑 e2e 并自动经 `xvfb-run`）。macOS 保留焦点检测器自检，但不再把主测试流程置于“不得上屏或抢焦点”的约束下；需要验证安静模式的焦点约束时，可以另行用 `e2e:desktop:headless` 配合焦点检测器。无论成败都上传 `test-results/screens/` 截图到 GitHub Artifacts。失败时另外上传检测日志、`test-results/` 与 HTML 报告。

## 写旅程用例

- 一条用户旅程一个 `test`，内部按“动作 → 断言”分段；不嵌套 `describe`，用例之间不共享可变状态。
- 从 `./fixtures/app` 引入 `test` / `expect`。fixture：`scratch`（临时根目录）、`model`（stub 模型，含 `config.toml`）、`pages`（随机端口的 `e2e/pages/*.html`）、`app`（启动后的应用，含临时 `KIMI_CODE_HOME`、userData、Downloads、工作区；默认已通过 REST 注册工作区，`test.use({ seedWorkspace: false })` 则从无工作区的界面开始）、`agent`（已开启回合的浏览器 MCP 客户端）。
- 前置状态用代码准备（配置、localStorage、REST），不点 UI；需要新的回合时调用 `app.startAgentTurn(prompt)`。
- stub 模型（`e2e/fixtures/model.ts`）只为带工具的请求消费脚本，标题生成等不带工具的请求立即返回固定回复。`model.script(...steps)` 按请求顺序排入回复：`say`（分块文本，可设块间隔）、`bash` / `waitFor` / `agent` / `call` / `batch`（OpenAI `tool_calls` 增量）、`httpError`（429 / 500 等）、`after`（首字节前延迟）、`finishWith`（结束原因）、`held(name, step, n)`（在第 n 块前挂起，`model.hold(name)` 的 `reached()` / `release()` / `fail(status)` / `cut()` 控制；`fail(status)` 只适用于 n 为 0 的挂起，n > 0 时 200 响应头已发出，调用会直接抛错，流中途出错用 `cut()` 断开连接）。没有脚本时先流式输出一段文本再挂起，回合因此保持运行，浏览器控制才被接受；收尾时释放。`model.requests()` 记录每个请求的完整 `messages`、上次助手回复之后的用户消息（`userTextsSinceReply`，不含 system reminder）与 reminder、客户端是否提前断开（`aborted`，`model.aborts()` 计数）；`messageProblems(messages)` 检查空消息、重复的用户消息和未配对的工具调用。`model.heldTurns()` / `model.waitForHeldTurn()` 同时计入无脚本挂起的回合和停在 `held` 处的脚本回合。`app.startTurn(prompt)` 发送并等到对应请求到达，`app.submit(prompt)` 只发送（回合运行时默认立即插入 steer，设为 Queue 时入队）。`app.serverGet(path)` 经渲染进程读取内嵌 server 的 `/api/v1` REST 接口并返回 `data`，`app.sessionId()` 返回当前会话 ID，可用来断言回合与 prompt 记录（如 `/sessions/{id}/transcript?agent_id=main`）。`test.use({ permissionMode: 'manual' | 'auto' | 'yolo' })` 写入 `default_permission_mode`。旧的 `model.queueReply(chunks, { holdAfterFirstChunk })` 仍可用。
- 选择器优先 role / 文本（界面固定为英文）；只有没有合适 role 或标签的元素才加 `data-testid`。
- 不写固定等待，用自动等待的 locator 和 `expect.poll`。
- 页面：`app.window` 是主界面；`app.overlay()` 是浏览器浮层（页面对话框在这里渲染）；`app.controlSurface()` 是代理控制层（控制光效、对话框记录）；`app.page(url => ..., '描述')` 取内置浏览器标签页。
- 关键界面状态断言通过后调用 `app.snapshot(name)` 留图：主窗口与其上可见的浏览器页面、浮层、控制层逐层 `capturePage` 后合成为一张 PNG，存到 `test-results/screens/<spec>/<test-title>/<nn>-<name>.png`，安静模式下同样可用。截图只供人工查看，不做像素断言。
- 页面的 alert / confirm 打开期间，该标签页的渲染线程被阻塞，不能在页面上做 Playwright 断言；改为断言工具返回和浮层。
- Playwright 默认会自动关闭没有监听者的页面对话框，与应用自己的对话框代理竞争。`app` fixture 在 context 上注册了空的 `dialog` 监听以关闭该行为，不要移除。

## 用例分层

`e2e/playwright.config.ts` 把 spec 分成按依赖排列的 project，下游通过 `dependencies` 依赖上游。被依赖的 project 中任一用例失败时，Playwright 跳过所有下游 project（报告为 did not run），基础故障在几分钟内暴露，不必等完整一轮。

```
smoke: core-turn
├─ gate-session-api: approval-permission-modes
│   └─ approvals-state
├─ gate-turn-engine: lifecycle-model-errors
│   └─ turns-transcript
└─ app-shell
```

- `smoke`：应用启动、信任工作区、完成一轮对话。它失败时其余 project 都不跑。
- `gate-session-api`：会话状态 REST 与权限状态。下游 `approvals-state` 是审批、计划、任务与目标、会话模型和退出 / 连接相关的 spec。
- `gate-turn-engine`：轮次生命周期、模型 stub 与 transcript REST。下游 `turns-transcript` 是 `transcript-*`、`turn-*` 以及依赖轮次与 transcript 的 bash、子 agent、写作、改动和选区评论 spec。
- `app-shell`：其余所有 spec（会话列表、设置、引导、文件面板、浏览器、终端等），只依赖 `smoke`；未列入其他 project 的新 spec 自动落在这里。
- 配置加载时校验：列出的 spec 文件必须存在，且同一 spec 不得出现在两个 project 中。

- 门槛（被依赖的 project）只放一两条短而稳定的用例；已知 flake 的 spec 不得作为门槛。门槛里的一次 flake 会让整棵子树不跑，分层会放大 flake。
- 如需重试，只给门槛 project 设 1 次，其余 project 保持 `retries: 0`。
- 分层只在失败时节省时间，全部通过时总耗时不变；不要为了提速而加层。
- 新 spec 默认放在最下层。只有当它验证的能力是其他 spec 的前提，并且历史运行显示它们一起失败时，才提为门槛。
- 按文件或标题筛选时（包括 PR 只跑改动的 spec、手动运行的 `spec_filter`），Playwright 会连同依赖的门槛 project 一起运行；需要跳过门槛时加 `--no-deps`。

## Flake 策略

`retries: 0`、`workers: 1`。新用例合入前在本机用 `--repeat-each=20` 跑通。出现 flake 时先 `test.skip` 并注明原因与跟进链接，再定位根因修复；不加重试、不加固定等待。
