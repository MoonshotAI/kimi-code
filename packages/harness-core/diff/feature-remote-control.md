# feature-remote-control：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/feature-remote-control/`（1488 行：client.ts 1106 + lock.ts 170 + manager.ts 162 + feature.ts 46 + index.ts 4）+ REST 开关在 `packages/harness-core/src/feature-http/route-features/remote-control.ts`（105 行）
- agent-core-v2：`packages/remote-control/`（1470 行：remote-control.ts 1106 + lock.ts 170 + manager.ts 191 + index.ts 3；独立包，DI-free）+ kap-server 装配与路由 `packages/kap-server/src/start.ts:195-204,445-449`、`packages/kap-server/src/routes/remoteControl.ts`（122 行）；CLI/TUI 消费方 `apps/kimi-code/src/cli/sub/web/remote-control.ts`、`apps/kimi-code/src/tui/commands/web.ts`
- 蓝本关系：v2 独立包是直接行为蓝本（非 refact-237 第一批 human 蓝本）。`client.ts` 与 `lock.ts` 为逐字移植（与 v2 `remote-control.ts`/`lock.ts` diff 为空）；`manager.ts` 因 v2 版依赖 agent-core-v2 的 `human/xstate2` 而纯 TS 重写。Handoff 第 39 轮（L317），用户选定「移植而非复用」

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 代码归属 | 独立包 `@moonshot-ai/remote-control`，kap-server 与 CLI 共用 | 移植进 harness-core 自维护，v2 包保持原样继续服务 kap-server/CLI；relay 协议演进需双向同步（记录在案的已知代价） | 第 39 轮用户选定（L317：manager.ts 依赖 agent-core-v2 human/xstate2，harness-core 硬约束不引 v2） |
| 装配形态 | kap-server `start.ts:195-204` 直接 `createRemoteControlManager`（无 feature 概念），随 server 进程共生 | `createFeature('remote-control')` app tier 工厂 `createRemoteControl(props)`，**不进 preset**、默认 off 不自动 enable、不挂 example（开启需真实 Kimi 登录 + 生产 relay）；unmount 经 pushCleanup 走 `manager.close()`（feature.ts:25-45） | 第 39 轮（L317 ①⑤） |
| manager 状态机实现 | xstate2 machine：off/starting/on/stopping 四态 + invoke startTunnel/stopTunnel + `tunnel.exited` 事件（manager.ts:32-108） | 纯 TS 重写（162 行）：同四态 + listener Set + 重检循环；并发 enable 共享单次启动、并发 disable 共享单次停止的语义等价；tunnel 意外退出经 `handle.closed` + handle 身份守卫转 off（manager.ts:69-85） | 第 39 轮（L317 ①「重检循环实现并发 enable 共享单次启动/并发 disable 共享单次停止」） |
| 隧道启动注入点 | v2 manager 写死 `import { startRemoteControl }`（manager.ts:3） | options 新增必填 `start`（manager.ts:28）；feature 层 `props.start?` 可选、默认 `startRemoteControl`（feature.ts:22,36）——测试可注入 fake 隧道 | 第 39 轮（L317 偏差②） |
| facade 暴露 | 无 facade 概念：kap-server 路由直接握 manager 引用 | `RemoteControlRef` token + `RemoteControlFace { status, enable, disable }` 经 useExpose 落 app 层（feature.ts:13,38-42）；`close` 不进 facade，仅 cleanup 内部用 | 第 39 轮（L317 ①） |
| `staticEnableError` 路由守卫 | kap-server 在非 loopback 绑定时传入 `'Remote Control requires a loopback host.'`，enable 请求直接 40001（start.ts:447-448；remoteControl.ts:84-87） | 不迁：feature-http 路由无此分支 | 第 39 轮偏差③「kap-server 未传，无消费方」——**与 Handoff 记录不符**：v2 代码中 kap-server 确实条件性传入（start.ts:447-448），是真实消费方；harness-core 侧 listen 默认 127.0.0.1 且无 exposure 分类概念，实际风险窗口小 |
| 路由错误码 | AlreadyRunning → 40928（与 harness-core 同码）；其余 enable 失败 → `INTERNAL_ERROR` 50001（remoteControl.ts:92-101）；facade 恒在无 UNAVAILABLE 分支 | AlreadyRunning → `REMOTE_CONTROL_ALREADY_RUNNING` 40928（HTTP 409）；facade 缺席 → `REMOTE_CONTROL_UNAVAILABLE` 40937（HTTP 409，sessionExport 40936 先例）；其余失败 → `REMOTE_CONTROL_FAILED` 50002（HTTP 500）（route-features/remote-control.ts:59-65,78-86；route/http.ts:33-42） | 第 39 轮收口（L317：40925 先例 + 40928 与 v2 同码 + 50002 新增）；40925→40937 改号见 feature-http.md「错误码号段约定」行 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| 本地 server 鉴权闭环 | RC 客户端转发时注入 `Authorization: Bearer <token>`，kap-server 有 `createAuthHook` 校验该 token（middleware/auth.ts:64-89），闭环成立 | client.ts 同样注入 Bearer 头（client.ts:193），但 feature-http **无任何 auth 检查**，头被忽略——开启 RC 即把未鉴权 server 暴露给 relay，宿主需自行评估 | 安全相关已知缺口；第 39 轮偏差④在案（L317）：「feature-http 补 auth 是独立议题」 |
| 路由层 HTTP 状态语义 | kap-server 一律 HTTP 200 + envelope（错误码在 body `code` 字段，error-handler.ts:33） | 真实 HTTP 状态码（409/500）+ 同形 envelope | 共享客户端需双轨处理；详见 feature-http.md 横切差异 |
| CLI/TUI 消费面 | `kimi web --remote-control` 与 TUI `/web` 命令消费 `inspectRemoteControlLock`/`buildRemoteControlUrl`（apps/kimi-code 两处） | 两纯函数已逐字移植（lock.ts:87、client.ts:124）且有测试，但无宿主消费方（example 不挂此 feature） | 无功能损失；属「不挂 example」决定的连带结果 |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| 编程面 facade | `RemoteControlRef` 使任何 feature/宿主代码可 inject 后 `status()/enable()/disable()` 编程控制隧道；v2 只有 kap-server 路由与 CLI 两个硬编码消费方 |
| `start` 注入点 | 测试无需真实 relay/登录即可全量覆盖 enable/disable/并发/失败路径（feature-remote-control.test.ts 12 案）；v2 manager 测试需 mock 模块导入 |
| facade 缺席显式语义 | feature 未安装时 REST 返回 40937 + 固定文案 `'remote control is unavailable (remote-control feature is not installed)'`；v2 无此场景 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| env `KIMI_CODE_REMOTE_CONTROL_RELAY_URL` | 支持，缺省 `https://code-rc.kimi.com`（remote-control.ts:19-28） | 逐字一致（client.ts:19-28） | 已对齐 |
| 默认 relay origin | `https://code-rc.kimi.com` | 同 | 已对齐 |
| manager/factory props | `createRemoteControlManager({ homeDir, localOrigin, localServerToken, clientVersion, relayOrigin?, stderr? })` | `createRemoteControl({ homeDir, localOrigin, localServerToken, clientVersion, relayOrigin?, stderr?, start? })`——localOrigin/localServerToken 为 `() => string` 惰性取值（kap-server 侧本就以闭包传入，语义同） | 人为设计（+start 注入点） |
| client 层 options | `pingIntervalMs?`（30s）/ `silenceTimeoutMs?`（300s）（remote-control.ts:105-106） | 同（client.ts:105-106） | 已对齐 |
| kap-server 装配参数 | localOrigin `http://<host>:<port>`、clientVersion `kimi-code/<serverVersion>`、token = `authTokenService.getToken()`（start.ts:194-199） | 由宿主经 props 注入，harness-core 自身不规定 | 人为设计（宿主端口化） |
| config 节 / flag 门控 | 无 | 无 | 已对齐 |
| 锁文件 | `<home>/server/rc.json`，含 pid/nonce/local_origin/device_id/url/started_at（lock.ts:41-43） | 逐字一致（lock.ts:41-43） | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无。
- Feature 事件：两侧均无自有 Feature 事件。client 层 `onStatus` 回调四状态（`relay_connected`/`relay_disconnected`/`device_connected`/`device_disconnected`）逐字一致（client.ts:91-95 vs remote-control.ts:91-95）。
- facade：harness-core `RemoteControlFace = { status, enable, disable }`；v2 `RemoteControlManager = { status, enable, disable, close }`——close 未入 facade（见上）。REST 面两侧同为 `GET /remote-control` + `POST /remote-control {enabled}`，状态视图 snake_case 六字段（enabled/state/url/device_id/device_name/error）与 v2 `rest-remote-control.ts` 的 zod schema 逐字段一致。

## 摘要
对齐程度极高：隧道客户端（relay 注册/管理+HTTP 双通道/重连退避/gzip/ETag/HTML 前缀改写/10MiB 与 64KB 上限）与机器级单例锁两份文件与 v2 逐字一致（diff 为空），行为分叉集中在装配层。最重要的三个差异：① manager 从 xstate2 重写为纯 TS 重检循环（状态语义等价，用户选定移植路线的一部分）；② `staticEnableError` 非 loopback 守卫未迁，且 Handoff「kap-server 未传」的记录与 v2 代码不符（start.ts:447-448 确有消费）；③ REST 错误面新增 40937/50002 且用真实 HTTP 状态码，与 kap-server 的 200+50001 风格分叉。最需关注的缺口是鉴权闭环断裂：feature-http 无 auth，开启 remote-control 即把未鉴权 server 暴露给 relay（第 39 轮在案，归 feature-http bearer auth 独立议题），以及 relay 协议双份实现的长期同步维护成本（同轮在案遗留）。
