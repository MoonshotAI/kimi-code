# 纵深防御校验

## 概述

当你修复了一个由无效数据引起的 bug 时，在一个地方加校验似乎就够了。但这个单点检查可能会被不同的代码路径、重构或 mock 绕过。

**核心原则：** 在数据经过的每一层都做校验。让这个 bug 在结构上不可能发生。

## 为什么需要多层校验

单层校验："我们修了这个 bug"
多层校验："我们让这个 bug 不可能再发生"

不同层级能捕获不同问题：
- 入口校验捕获大多数 bug
- 业务逻辑校验捕获边界情况
- 环境守卫防止特定上下文的危险操作
- 调试日志在其他层级失效时提供帮助

## 四个层级

### 第 1 层：入口校验
**目的：** 在 API 边界拒绝明显无效的输入

```typescript
function createProject(name: string, workingDirectory: string) {
  if (!workingDirectory || workingDirectory.trim() === '') {
    throw new Error('workingDirectory cannot be empty');
  }
  if (!existsSync(workingDirectory)) {
    throw new Error(`workingDirectory does not exist: ${workingDirectory}`);
  }
  if (!statSync(workingDirectory).isDirectory()) {
    throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
  }
  // ... 继续处理
}
```

### 第 2 层：业务逻辑校验
**目的：** 确保数据对当前操作是合理的

```typescript
function initializeWorkspace(projectDir: string, sessionId: string) {
  if (!projectDir) {
    throw new Error('projectDir required for workspace initialization');
  }
  // ... 继续处理
}
```

### 第 3 层：环境守卫
**目的：** 防止在特定环境中执行危险操作

```typescript
async function gitInit(directory: string) {
  // 在测试中，拒绝在临时目录之外执行 git init
  if (process.env.NODE_ENV === 'test') {
    const normalized = normalize(resolve(directory));
    const tmpDir = normalize(resolve(tmpdir()));

    if (!normalized.startsWith(tmpDir)) {
      throw new Error(
        `Refusing git init outside temp dir during tests: ${directory}`
      );
    }
  }
  // ... 继续处理
}
```

### 第 4 层：调试埋点
**目的：** 记录上下文信息以便事后分析

```typescript
async function gitInit(directory: string) {
  const stack = new Error().stack;
  logger.debug('About to git init', {
    directory,
    cwd: process.cwd(),
    stack,
  });
  // ... 继续处理
}
```

## 应用模式

当你发现一个 bug 时：

1. **追踪数据流** —— 错误值从哪里产生的？在哪里被使用？
2. **标注所有检查点** —— 列出数据经过的每一个节点
3. **在每一层添加校验** —— 入口、业务逻辑、环境、调试
4. **测试每一层** —— 尝试绕过第 1 层，验证第 2 层能否捕获

## 实际案例

Bug：空的 `projectDir` 导致 `git init` 在源代码目录执行

**数据流：**
1. 测试准备 → 空字符串
2. `Project.create(name, '')`
3. `WorkspaceManager.createWorkspace('')`
4. `git init` 在 `process.cwd()` 中执行

**添加的四层防御：**
- 第 1 层：`Project.create()` 校验非空/存在/可写
- 第 2 层：`WorkspaceManager` 校验 projectDir 非空
- 第 3 层：`WorktreeManager` 在测试中拒绝在 tmpdir 之外执行 git init
- 第 4 层：git init 前记录堆栈跟踪

**结果：** 全部 1847 个测试通过，bug 不可能再复现

## 关键洞察

四个层级缺一不可。在测试过程中，每一层都捕获了其他层遗漏的 bug：
- 不同的代码路径绕过了入口校验
- mock 绕过了业务逻辑检查
- 不同平台的边界情况需要环境守卫
- 调试日志发现了结构性误用

**不要止步于一个校验点。** 在每一层都添加检查。
