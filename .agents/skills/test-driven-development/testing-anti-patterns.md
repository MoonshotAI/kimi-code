# 测试反模式

**在以下情况加载此参考：** 编写或修改测试、添加 mock、或想在生产代码中添加仅测试用方法时。

## 概述

测试必须验证真实行为，而非 mock 行为。Mock 是隔离的手段，不是被测试的对象。

**核心原则：** 测试代码做了什么，而非 mock 做了什么。

**严格遵循 TDD 可以防止这些反模式。**

## 铁律

```
1. 绝不测试 mock 行为
2. 绝不在生产类中添加仅测试用的方法
3. 绝不在不理解依赖的情况下使用 mock
```

## 反模式 1：测试 Mock 行为

**违规做法：**
```typescript
// ❌ 差：测试 mock 是否存在
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

**为什么这是错误的：**
- 你在验证 mock 能工作，而非组件能工作
- mock 存在时测试通过，不存在时失败
- 对真实行为一无所知

**你的人类伙伴的纠正：** "我们是在测试 mock 的行为吗？"

**正确做法：**
```typescript
// ✅ 好：测试真实组件或不要 mock 它
test('renders sidebar', () => {
  render(<Page />);  // 不要 mock sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// 或者如果必须 mock sidebar 来隔离：
// 不要对 mock 做断言——测试 Page 在 sidebar 存在时的行为
```

### 门控函数

```
在对任何 mock 元素做断言之前：
  问："我是在测试真实组件行为还是仅仅测试 mock 的存在？"

  如果是测试 mock 的存在：
    停下——删除断言或取消 mock

  改为测试真实行为
```

## 反模式 2：在生产代码中添加仅测试用方法

**违规做法：**
```typescript
// ❌ 差：destroy() 仅在测试中使用
class Session {
  async destroy() {  // 看起来像生产 API！
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... 清理
  }
}

// 在测试中
afterEach(() => session.destroy());
```

**为什么这是错误的：**
- 生产类被仅测试用的代码污染
- 如果在生产环境中意外调用会很危险
- 违反 YAGNI 和关注点分离
- 混淆了对象生命周期和实体生命周期

**正确做法：**
```typescript
// ✅ 好：测试工具处理测试清理
// Session 没有 destroy()——它在生产中是无状态的

// 在 test-utils/ 中
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// 在测试中
afterEach(() => cleanupSession(session));
```

### 门控函数

```
在向生产类添加任何方法之前：
  问："这只被测试使用吗？"

  如果是：
    停下——不要添加
    放到测试工具中

  问："这个类是否拥有此资源的生命周期？"

  如果否：
    停下——这个方法不属于这个类
```

## 反模式 3：不理解依赖就使用 Mock

**违规做法：**
```typescript
// ❌ 差：Mock 破坏了测试逻辑
test('detects duplicate server', () => {
  // Mock 阻止了测试依赖的配置写入！
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // 应该抛异常——但不会！
});
```

**为什么这是错误的：**
- 被 mock 的方法有测试依赖的副作用（写入配置）
- "保险起见"过度 mock 破坏了实际行为
- 测试因错误的原因通过或莫名其妙地失败

**正确做法：**
```typescript
// ✅ 好：在正确的层级 mock
test('detects duplicate server', () => {
  // Mock 慢的部分，保留测试需要的行为
  vi.mock('MCPServerManager'); // 只 mock 慢的服务器启动

  await addServer(config);  // 配置被写入
  await addServer(config);  // 检测到重复 ✓
});
```

### 门控函数

```
在 mock 任何方法之前：
  停下——先不要 mock

  1. 问："真实方法有什么副作用？"
  2. 问："这个测试是否依赖这些副作用？"
  3. 问："我完全理解这个测试需要什么吗？"

  如果依赖副作用：
    在更底层 mock（实际的慢操作/外部操作）
    或使用保留必要行为的测试替身
    而非测试依赖的高层方法

  如果不确定测试依赖什么：
    先用真实实现运行测试
    观察实际需要发生什么
    然后在正确的层级添加最少的 mock

  危险信号：
    - "我 mock 一下保险"
    - "这可能慢，还是 mock 掉吧"
    - 不理解依赖链就 mock
```

## 反模式 4：不完整的 Mock

**违规做法：**
```typescript
// ❌ 差：部分 mock——只包含你认为需要的字段
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // 缺失：下游代码使用的 metadata
};

// 之后：代码访问 response.metadata.requestId 时崩溃
```

**为什么这是错误的：**
- **部分 mock 隐藏了结构假设** — 你只 mock 了你知道的字段
- **下游代码可能依赖你没包含的字段** — 静默失败
- **测试通过但集成失败** — mock 不完整，真实 API 完整
- **虚假的信心** — 测试对真实行为什么也没证明

**铁律：** Mock 真实存在的完整数据结构，而非只包含你当前测试用到的字段。

**正确做法：**
```typescript
// ✅ 好：镜像真实 API 的完整性
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // 真实 API 返回的所有字段
};
```

### 门控函数

```
在创建 mock 响应之前：
  检查："真实 API 响应包含哪些字段？"

  操作：
    1. 从文档/示例中查看实际 API 响应
    2. 包含系统下游可能消费的所有字段
    3. 验证 mock 完全匹配真实响应的结构

  关键：
    如果你在创建 mock，你必须理解完整的结构
    部分 mock 在代码依赖遗漏字段时会静默失败

  不确定时：包含所有文档记录的字段
```

## 反模式 5：集成测试作为事后补充

**违规做法：**
```
✅ 实现完成
❌ 没写测试
"准备好测试了"
```

**为什么这是错误的：**
- 测试是实现的一部分，不是可选的后续
- TDD 本可以防止这种情况
- 没有测试就不能声称完成

**正确做法：**
```
TDD 循环：
1. 编写失败的测试
2. 实现使其通过
3. 重构
4. 然后才声称完成
```

## 当 Mock 变得过于复杂时

**警告信号：**
- Mock 的 setup 比测试逻辑还长
- 为了让测试通过而 mock 一切
- Mock 缺少真实组件拥有的方法
- Mock 变更时测试就坏了

**你的人类伙伴的问题：** "我们这里真的需要用 mock 吗？"

**考虑：** 使用真实组件的集成测试往往比复杂的 mock 更简单

## TDD 如何防止这些反模式

**TDD 有帮助的原因：**
1. **先写测试** → 迫使你思考你到底在测什么
2. **看它失败** → 确认测试测的是真实行为，不是 mock
3. **最少实现** → 仅测试用方法不会混入
4. **真实依赖** → 你在 mock 之前看到测试实际需要什么

**如果你在测试 mock 行为，你违反了 TDD** — 你在没有先用真实代码让测试失败的情况下就加了 mock。

## 快速参考

| 反模式 | 修复方式 |
|--------|----------|
| 对 mock 元素做断言 | 测试真实组件或取消 mock |
| 生产代码中的仅测试用方法 | 移到测试工具中 |
| 不理解就 mock | 先理解依赖，最少 mock |
| 不完整的 mock | 完整镜像真实 API |
| 测试作为事后补充 | TDD——先写测试 |
| 过于复杂的 mock | 考虑集成测试 |

## 危险信号

- 断言检查 `*-mock` test ID
- 方法仅在测试文件中被调用
- Mock setup 占测试的 >50%
- 移除 mock 测试就失败
- 无法解释为什么需要 mock
- "保险起见" mock 掉

## 底线

**Mock 是隔离的工具，不是被测试的对象。**

如果 TDD 揭示你在测试 mock 行为，你已经走偏了。

修复方法：测试真实行为，或质疑为什么要 mock。
