# IEventService（eventService）

- v2: `packages/agent-core-v2/src/app/event/event.ts`（约 16 行，读 interface 与 eventService.ts 得出；App 级 Event2 发布/订阅总线）
- 新架构: `packages/harness-core/src/composition-api/hooks.ts`（useFire/useOn）+ `packages/harness-core/src/composition-api/runtime.ts`（事件沿 unit lineage 投递）

## 能力对照

- [x] publish(event) 全局发布 → useFire()（hooks.ts）；app 句柄侧另有 AppEvent 发射（`packages/harness-core/src/app/app.ts` 的 emit）
- [x] subscribe(handler) 全量订阅（v2 onDidPublish/subscribe 同语义）→ useOn('*', handler)（hooks.ts）；宿主侧 app.on(type|'*', handler)（app.ts）
- [x] 按类型订阅（Event2.type 字符串）→ useOn(type, handler)（hooks.ts；listeners 按 type 分桶，runtime.ts 的 deliver）
- [x] 等待事件发生（等待钩子完成的异步面）→ app.wait / node.wait / useWait（app.ts、runtime.ts、hooks.ts，支持 match/timeoutMs/signal）
- [x] 持久化事件再发布（v2 中 ModelCatalogChanged 等经 IEventService 广播）→ 各 feature 以 RuntimeEvent 类型化 fire（如 `capability.changed`、`config.changed`），durable store 事件经 `useForward` 注入运行时树（`packages/harness-core/src/app/units.ts`）

## 结论

全部对齐——App 级发布/订阅由 kernel 事件机制结构取代，类型化事件、通配订阅与事件等待均有等价承载。
