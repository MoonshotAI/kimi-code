# IHostClock（hostClock）

- v2: `packages/agent-core-v2/src/os/interface/hostClock.ts`（约 11 行，读 interface 得出）
- 新架构: 无统一服务（分散为各 feature 的注入时钟端口）

## 能力对照

- [x] 当前时间（now()）→ 结构取代：按消费域就近注入——`packages/harness-core/src/features/dateChange/feature.ts` 的 CreateDateChangeProps.now（缺省 `() => new Date()`），`packages/harness-core/src/features/cron/internal/clock.ts` 的 ClockSources.wallNow（支持 KIMI_CRON_CLOCK 文件钟/调试钟）
- [x] 时区（timeZone()）→ `packages/harness-core/src/features/dateChange/feature.ts` 的 CreateDateChangeProps.timeZone（缺省 Intl.DateTimeFormat().resolvedOptions().timeZone）
- [x] 宿主注入可替换（v2 由宿主注册时钟实现）→ 两个注入端口均为 props 可选参数，测试与宿主可直接传入假钟，注入点比统一服务更靠近消费方

## 结论

全部对齐：统一时钟服务被「各 feature 声明时钟注入端口」的结构取代，wall 时间与本地时区两个能力点均有承载且更可测；时间消费方（cron 调度、日期提醒）均已核实走注入钟，无第三个隐藏消费方。
归属判定：v2 该服务仅有的两个消费面（日期提醒与定时任务）已全覆盖，其余时间调用点在新栈直接走 `new Date()`/`Date.now()`，不属于本服务能力面。
