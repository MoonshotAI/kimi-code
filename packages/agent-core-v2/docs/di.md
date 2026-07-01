# DI（依赖注入）与 Scope — 场景化指南

> 本文按「给 agent-core-v2 加业务功能」会遇到的场景，从最简单到最复杂，逐个引入 DI 的概念。
> 源码位于 [`src/_base/di/`](../src/_base/di/)；测试约定见 [`docs/di-testing.md`](di-testing.md)。

---

## 0. 先把 DI 当成黑盒子

写业务代码时，你只需要向这个黑盒子声明三件事：

- **我是谁** —— 一个能当 key 又能当类型的「身份」。
- **我需要谁** —— 我的依赖由谁提供。
- **我活多久** —— 我属于哪一层生命周期。

剩下的事（何时创建、是不是同一份、谁先谁后、何时销毁）都由容器负责。类只跟接口打交道，从不关心实现怎么 new。

下面每个场景只引入它所需要的那一块 DI。跟着场景走，概念会逐步叠加。

---

## 场景 1：加一个全局服务（不依赖任何人）

> 你要做的：进程级只有一个、谁都能用的基础能力，比如日志、遥测。参考 [`log`](../src/log/log.ts)。

这一步引入四块：**接口 / 身份 / 实现 / 注册**。

### 1.1 写接口，带上 `_serviceBrand`

```ts
// greet/greet.ts
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IGreeter {
  readonly _serviceBrand: undefined;   // 类型记号：告诉 DI「这是一个服务」
  hello(): string;
}

export const IGreeter: ServiceIdentifier<IGreeter> = createDecorator<IGreeter>('greeter');
```

`createDecorator(name)` 造出的 `ServiceIdentifier` 一身二任：运行时是 key 和参数装饰器，编译时携带 `IGreeter` 类型。

> ⚠️ **约束：身份名字全局唯一。** `createDecorator` 按 `name` 缓存，同名返回同一个身份。两个域用了同一个字符串就会碰撞、共享一个身份。

### 1.2 写实现类

```ts
// greet/greetService.ts
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IGreeter } from './greet';

export class Greeter implements IGreeter {
  declare readonly _serviceBrand: undefined;   // 与接口的 _serviceBrand 对应
  hello(): string { return 'hi'; }
}
```

实现类用 `declare readonly _serviceBrand: undefined;` 对应接口上的类型记号。

### 1.3 注册到一层生命周期

```ts
// greet/greetService.ts（文件顶层，import 时执行）
registerScopedService(
  LifecycleScope.App,     // 活多久：进程级
  IGreeter,                // 身份
  Greeter,                 // 实现
  InstantiationType.Eager, // 创建时机：立刻
  'greet',                 // 域名（用于排错）
);
```

绑定在哪一层是这个类的**固有属性**，在注册点决定，不在调用点决定。

### 1.4 通过 barrel 导出，让注册生效

```ts
// greet/index.ts
export * from './greet';
export * from './greetService';   // import 这一行即触发上面的 registerScopedService
```

再在包入口 [`src/index.ts`](../src/index.ts) 加一行：

```ts
export * from './greet/index';
```

于是「import 这个包」=「加载全部注册」。**没有中心装配文件**：绑定散落在各自域的实现文件里，靠 import 副作用收集。

至此，任何人都能 `accessor.get(IGreeter)` 拿到这个全局唯一的服务。

---

## 场景 2：你的服务要用别人的服务

> 你要做的：你的服务需要调用别的域的能力。参考 [`sessionService.ts`](../src/session/sessionService.ts)。

这一步引入：**构造器注入** 与 **按接口解析**。

### 2.1 用 `@IX` 在构造器上声明依赖

```ts
export class SessionService implements ISessionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly event: IEventService,
  ) {}
}
```

`@IAgentLifecycleService` 只做一件事：把「第 0 个参数需要 `IAgentLifecycleService`」记到类的元数据上。容器 new 这个类时读元数据，把依赖填好。

### 2.2 三条不可破的约束

1. **不要 `new` 带 `@IService` 依赖的类。** `new` 会绕过容器：绕过注册、绕过 scope、绕过单例缓存。要用就 `@IX` 注入，或 `accessor.get(IX)`。
2. **`@IX` 只能装饰构造器参数。** 装饰到字段/方法上会在运行时抛错。
3. **服务参数排在静态参数之后**（静态参数见场景 7）。

### 2.3 消费方按接口取，看不到实现

```ts
const session = accessor.get(ISessionService);   // 类型是 ISessionService
```

消费方只 import **接口** 和 **`IX` 身份**，从不 import 实现类。这是 DI 把「接口 → 实现」的替换权完全握在容器手里的关键。

> 如果你需要的不是「一个服务」而是「一份配置」，通常做法是把它也做成一个服务注入进来（如 `IConfigService`）；如果是「每轮一个、带参数的非单例对象」，见场景 7。

---

## 场景 3：你的服务不是全局一份

> 你要做的：每个会话一份、或每个 agent 一份。参考 [`session`](../src/session/session.ts)、[`turn`](../src/turn/turn.ts)。

这一步引入：**`LifecycleScope` 三层生命周期** 与 **父子 scope 的可见性**。

### 3.1 三层，按寿命从长到短

```ts
export enum LifecycleScope {
  App = 0,    // 进程级，全局一份
  Session = 1, // 一次会话
  Agent = 2,   // 一个 agent
}
```

数值越大，寿命越短、越靠叶子。注册时把 `scope` 换成对应层即可：

```ts
registerScopedService(LifecycleScope.Session, ISessionService, SessionService, InstantiationType.Delayed, 'session');
```

「单例」的粒度是**每个 scope 一份**：App 的 `ILogService` 全局只有一份；每个 Session scope 各有自己的 `ISessionService`。

### 3.2 子 scope 看得见父 scope，反之不行

Scope 是一棵树，`kind` 必须沿父子方向**严格递增**：

```
App (0)
 └── Session (1)
      └── Agent (2)
```

解析服务时，容器先看自己这一层，没有就**递归问父 scope**。所以一条铁律：

> **短寿命的服务可以注入长寿命的服务，反过来不行。**

- ✅ Agent 服务注入 Session / App 服务（往上找，找得到）。
- ❌ App 服务注入 Session 服务（App 创建时 Session 还不存在，且父不会往下找）。

这条规则由树的结构强制保证，不靠纪律维持。

---

## 场景 4：你的服务要释放资源

> 你要做的：服务里订阅了事件、开了定时器、持有了句柄，scope 销毁时要释放。参考 `WSBroadcastService`（[`gatewayService.ts`](../src/gateway/gatewayService.ts)）。

这一步引入：**`Disposable` / `IDisposable` 生命周期**。

```ts
import { Disposable } from '#/_base/di/lifecycle';

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  declare readonly _serviceBrand: undefined;

  constructor(@IEventService event: IEventService) {
    super();
    this._register(event.subscribe(() => { /* … */ }));   // 收集子资源
  }
}
```

- 继承 `Disposable`，用 `this._register(d)` 收集任何 `IDisposable`（事件订阅、`toDisposable(fn)` 等）。
- 容器在销毁这个服务时会自动调它的 `dispose()`，它注册过的子资源随之释放。

销毁顺序是确定的（见场景 3 的树）：**子 scope 先死，同 scope 内按构造逆序释放**（后 new 的先释放）。业务代码只声明「我活在哪一层」，从不手动释放。

---

## 场景 5：你的服务很重，想延迟初始化

> 你要做的：服务依赖多、创建贵，不想在 scope 创建时就 new。

这一步引入：**`InstantiationType.Eager` vs `Delayed`**。

```ts
// Eager：scope 创建时立刻 new
registerScopedService(LifecycleScope.App, ILogService, LogService, InstantiationType.Eager, 'log');

// Delayed：第一次被 get 时才 new
registerScopedService(LifecycleScope.App, IScopeRegistry, ScopeRegistry, InstantiationType.Delayed, 'gateway');
```

Delayed 服务返回的是一个 **Proxy**：在首次访问任意属性时才真正构造。即便还没构造好，别人提前订阅它的 `onDid…` / `onWill…` 事件也不会丢——容器会先记下监听器，实例真正出来后再回放订阅。

> 经验：无依赖、被频繁使用、或有「尽早初始化副作用」的服务用 `Eager`（如 `ILogService`）；其余默认 `Delayed`。

---

## 场景 6：在普通函数里临时用服务

> 你要做的：你不想写一个新类，只是在一个函数里临时拿一个服务用一下。或你要给外部提供一个 `ServicesAccessor`。参考 [`gatewayService.ts`](../src/gateway/gatewayService.ts)。

这一步引入：**`IInstantiationService.invokeFunction`** 与 **`ServicesAccessor`**。

```ts
const accessor: ServicesAccessor = {
  get: <T>(id: ServiceIdentifier<T>): T => instantiation.invokeFunction((a) => a.get(id)),
};
```

`invokeFunction(fn)` 会给 `fn` 一个**只在这次调用期间有效**的 `ServicesAccessor`。

> ⚠️ **约束：accessor 只在调用期间有效。** `invokeFunction` 返回后再 `accessor.get()` 会抛 `"service accessor is only valid during the invocation"`。不要把 accessor 存起来异步用——要长期持有服务，就在构造器里注入（场景 2）。

---

## 场景 7：创建带依赖、但不是单例的对象

> 你要做的：每轮对话都要 new 一个新对象，但它也有 `@IService` 依赖。比如一个 per-turn 的执行器。

这一步引入：**`IInstantiationService.createInstance`** 与 **静态参数**。

```ts
class TurnRunner {
  constructor(
    private readonly input: string,                 // 静态参数：调用时传
    private readonly turn: number,                  // 静态参数：调用时传
    @ILogService private readonly log: ILogService, // 服务参数：容器注入
  ) {}
}

// 调用时：静态参数你传，服务参数容器填
const runner = instantiation.createInstance(TurnRunner, 'hello', 1);
```

容器把静态参数放前面、服务参数接在后面，再 `Reflect.construct` 出实例。这个对象**不会**被放进任何 scope 的单例缓存——每次都是新实例。

> 这就是「服务参数必须排在静态参数之后」的原因：容器按 `@IX` 记录的参数位置排序后依次注入。`_serviceBrand` 让编译器能在类型上区分这两类参数。

---

## 场景 8：你的服务要派生子容器 / 子 scope

> 你要做的：你的服务负责「拉起一个新会话 / 新 agent」，需要为它造一个子 scope。参考 `ScopeRegistry`（[`gatewayService.ts`](../src/gateway/gatewayService.ts)）。

这一步引入：**注入 `IInstantiationService` 本身** 与 **`createChild`**。

每个容器都把自己绑定成 `IInstantiationService`，所以你可以像注入别的服务一样注入它：

```ts
export class ScopeRegistry implements IScopeRegistry {
  declare readonly _serviceBrand: undefined;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  createSession(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const collection = new ServiceCollection();
    for (const entry of getScopedServiceDescriptors(LifecycleScope.Session)) {
      collection.set(entry.id, entry.descriptor);   // 收集 Session 这一层的描述符
    }
    const child = this.instantiation.createChild(collection);   // 派生子容器
    const accessor: ServicesAccessor = {
      get: <T>(id: ServiceIdentifier<T>): T => child.invokeFunction((a) => a.get(id)),
    };
    const handle: IScopeHandle = { id: opts.sessionId, kind: LifecycleScope.Session, accessor };
    this.sessions.set(opts.sessionId, handle);
    return Promise.resolve(handle);
  }
}
```

关键点：

- `getScopedServiceDescriptors(scope)` 能拿回注册在某一层的所有描述符，装进一个 `ServiceCollection`。
- `instantiation.createChild(collection)` 造一个子容器，它的父指针指向当前容器——于是子容器能向上解析到 App 的服务（场景 3 的可见性规则）。
- 给外部暴露时，用 `invokeFunction` 把子容器包成 `ServicesAccessor`（场景 6）。

> 更高层通常直接用 [`Scope.createChild(kind, id)`](../src/_base/di/scope.ts)（它帮你做了「筛描述符 + 建子容器」）；只有需要手动控制 `ServiceCollection` 时才像上面这样写。

---

## 场景 9：撞上循环依赖（不允许，要重构）

> 业务规则：**不允许循环依赖。** 容器会拒绝它；撞上时的正确处理是重构，不是让它跑通。

### 9.1 容器会拒绝同步成环

A 创建中要 B，B 创建中又要 A——容器会抛 `CyclicDependencyError`，`path` 形如 `['A', 'B', 'A']`。自环（A 依赖自己）同样会被拒绝。这不是 bug，是保护机制：它在告诉你「这两个服务的职责划错了」。

### 9.2 为什么不允许

- scope 分层让正常依赖天然是 DAG（Agent → Session → App 向上找），一个环几乎总是设计味道。
- 靠「让环刚好能跑」会把构造顺序变成隐式约定，难调试、难排错。

所以 v2 的立场是：**依赖图必须是无环的。**

### 9.3 撞上时怎么重构

按优先级考虑：

1. **抽出第三个服务 C。** 把 A、B 互相需要的那部分逻辑提到 C，让 A、B 都依赖 C，而不是互相依赖。这是最常见的解。
2. **用事件解耦。** 如果 A 只是想知道 B 的某个变化，让 B 通过 `IEventService` 发事件、A 订阅，而不是 A 直接持有 B 的引用。
3. **重新划分 scope。** 也许其中一个本不该在这一层——它其实该更短或更长寿命，移动后环自然消失。

### 9.4 关于 Delayed 破环（遗留逃生舱，禁用）

容器里有一个遗留机制：当环里的某一边注册为 `Delayed`（场景 5）时，Proxy 能让这个「软循环」不同步炸开。**业务上禁止使用它来绕过循环依赖**——它存在是为了兼容历史代码，不是给你的设计兜底的。撞上 `CyclicDependencyError` 时，按 9.3 重构。

---

## 场景 10：给服务写测试

> 你要做的：让测试走和生产一样的路径——按接口解析、依赖由容器注入。

这一步引入：**两个测试 harness**。详见 [`docs/di-testing.md`](di-testing.md)，这里只给选择标准：

| 测什么 | 用哪个 harness | 怎么取 SUT |
|---|---|---|
| 单个服务的行为（单元） | `TestInstantiationService`（扁平容器） | `ix.set(ISut, new SyncDescriptor(Sut))` 后 `ix.get(ISut)` |
| 跨 scope 接线 / 服务活在哪一层 | `createScopedTestHost`（scope 树） | `host.<scope>.accessor.get(ISut)` |

核心规则：**按接口解析被测对象，绝不 `new` 带 `@IService` 依赖的实现类**——否则 `registerScopedService(IX → Impl)` 这条绑定在测试里根本没跑过。

---

## 附录 A：接口速查

| 接口 | 出现场景 | 作用 |
|---|---|---|
| `createDecorator<T>(name)` → `ServiceIdentifier<T>` | 1 | 造身份（运行时 key + 编译时类型 + 参数装饰器） |
| `@IService` | 2, 7 | 在构造器参数上声明依赖 |
| `registerScopedService(scope, id, ctor, type, domain)` | 1, 3, 5 | 把实现绑定到一层生命周期 |
| `ServicesAccessor.get(IX)` | 2, 6 | 按接口解析实例 |
| `IInstantiationService.invokeFunction(fn, …)` | 6, 8 | 在函数里临时拿到 accessor |
| `IInstantiationService.createInstance(ctor, …args)` | 7 | 创建非单例对象并注入依赖 |
| `IInstantiationService.createChild(collection)` | 8 | 派生子容器 |
| `getScopedServiceDescriptors(scope)` | 8 | 取回注册在某一层的所有描述符 |
| `Disposable` / `DisposableStore` / `IDisposable` | 4 | 资源管理与销毁 |
| `Scope` / `LifecycleScope` | 3, 8 | 生命周期树 |
| `SyncDescriptor` | （测试/底层） | 把「构造器 + 静态参数」打包成待 new 描述符 |

> 遗留导出（v2 不用，知道即可）：`refineServiceDecorator` 是 VS Code 遗留的 DI 工具，v2 的 src/test 零引用，统一走 `registerScopedService`。

## 附录 B：红线汇总

1. 不 `new` 带 `@IService` 依赖的类——用 `@IX` 注入或 `accessor.get(IX)`。
2. `@IX` 只能装饰构造器参数；服务参数排在静态参数之后。
3. 接口和实现都带 `_serviceBrand`。
4. 身份名字全局唯一。
5. 父 scope 的服务不依赖子 scope 的服务（运行时也解析不到）。
6. **不写循环依赖**——容器会抛 `CyclicDependencyError`；撞上时按场景 9 重构，不用 Delayed 绕过。
7. `ServicesAccessor` 只在 `invokeFunction` 调用期间有效，不存起来异步用。
8. 注册写在实现文件顶层；测试里用 `_clearScopedRegistryForTests()` 后显式重注册，不依赖生产 import 顺序。

## 附录 C：新增一个服务的标准动作

1. **契约**：`src/<domain>/<domain>.ts` 写接口（带 `_serviceBrand`）+ `createDecorator` 身份。
2. **实现**：`src/<domain>/<domain>Service.ts` 写类，`@IX` 声明依赖，文件顶层 `registerScopedService(scope, IX, Impl, type, '<domain>')`。
3. **barrel**：`src/<domain>/index.ts` re-export 契约和实现。
4. **入口**：`src/index.ts` 加一行 `export * from './<domain>/index';`。
5. **测试**：`test/<domain>/` 用 `TestInstantiationService` 或 `createScopedTestHost`，按接口解析。
