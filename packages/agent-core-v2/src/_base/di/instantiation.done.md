# IInstantiationService（instantiationService）

- v2: `packages/agent-core-v2/src/_base/di/instantiation.ts`（约 212 行，读 interface 得出）
- 新架构: `packages/harness-core/src/composition-api/runtime.ts`（createUnit / mountRoot）

## 能力对照

- [x] 服务标识与参数装饰器注入（createDecorator / ServiceIdentifier）→ `packages/harness-core/src/composition-api/primitives.ts`（createToken / createFacadeToken / createCollection，token 分级取代装饰器元数据）
- [x] 实例创建与依赖装配（createInstance / invokeFunction）→ `packages/harness-core/src/composition-api/runtime.ts` 的 createUnit：setup 内用 useInject 声明依赖，由 kernel 装配
- [x] 作用域分层与子容器（createChild / provide / unprovide / ScopeActivation）→ `packages/harness-core/src/app/`（createApp + createFeature 的 app/session/agent 三级 Unit 挂载）
- [x] 延迟解析引用（ref / LiveRef）→ `packages/harness-core/src/composition-api/hooks.ts` 的 useInject(FacadeToken) 返回 ShallowRef，facade 到齐即填充
- [x] 统一处置（dispose / disposeAsync）→ kernel 的 useCleanup / onScopeDispose（`packages/harness-core/src/composition-api/runtime.ts`，基于 @vue/reactivity effectScope）

## 结论

全部对齐：DI 框架整体废弃，属框架性取代——VSCode 风格 instantiationService 的全部职责由 harness-core kernel 的 Unit 运行时（createUnit/mountRoot + token 注入）承担。
