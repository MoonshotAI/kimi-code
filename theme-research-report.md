# 自定义主题功能调研报告

> 调研目标：为 kimi-code TUI 系统引入用户自定义主题能力，调研范围包括当前系统主题实现和上层 `pi` 项目的主题系统。
>
> 调研时间：2026-06-05

---

## 执行摘要

当前 kimi-code 的主题系统**设计良好但扩展性有限**：只有 `dark` / `light` / `auto` 三种内置选项，所有颜色硬编码在源码中，用户无法自定义。上层 `pi` 项目拥有**成熟完善的自定义主题系统**，支持 JSON 配置文件、变量引用、Schema 校验、热重载、多路径加载等。建议参考 `pi` 的架构，为 kimi-code 引入基于 `theme.json` 的自定义主题能力，同时保持当前语义化 token 和就地更新的设计优势。

---

## 一、当前系统（kimi-code）主题系统现状

### 1.1 代码位置与架构

主题系统集中在 `apps/kimi-code/src/tui/theme/`：

```
apps/kimi-code/src/tui/theme/
├── index.ts          # Theme 类型定义：'dark' | 'light' | 'auto'
├── colors.ts         # ColorPalette 接口 + darkColors / lightColors 常量
├── styles.ts         # ThemeStyles：基于 chalk 的样式辅助函数
├── bundle.ts         # KimiTUIThemeBundle = colors + styles + markdownTheme
├── pi-tui-theme.ts   # 映射为 pi-tui 的 MarkdownTheme / EditorTheme
├── detect.ts         # 终端背景检测（OSC 11、COLORFGBG）
└── terminal-background.ts  # OSC 11 响应解析
```

**三层架构**：
1. **Raw Palette**：`dark` / `light` 的原始 hex 常量（如 `dark.blue400 = '#4FA8FF'`）
2. **语义色板层**：`ColorPalette` 接口，约 20 个语义 token（`primary`、`text`、`success`、`diffAdded`、`roleUser` 等）
3. **样式/渲染层**：`ThemeStyles`（chalk 包装）+ `MarkdownTheme` / `EditorTheme`（pi-tui 适配）

### 1.2 主题定义与加载

**完全硬编码**，无外部主题文件：

```ts
// colors.ts
export const darkColors: ColorPalette = {
  primary: dark.blue400,
  accent: dark.cyan400,
  text: dark.gray100,
  textStrong: dark.gray50,
  textDim: dark.gray500,
  // ... 共 20 个语义 token
};
```

**加载流程**：
1. CLI 启动时（`run-shell.ts`）：若 `tui.toml` 配置为 `auto`，通过 OSC 11 查询终端背景色
2. TUI 状态初始化（`tui-state.ts`）：`createKimiTUIThemeBundle(theme, resolved)` 创建 bundle
3. 组件通过 `state.theme.colors` / `state.theme.styles` / `state.theme.markdownTheme` 消费

### 1.3 tui.toml 配置

```toml
# ~/.kimi-code/tui.toml
theme = "auto"  # 仅支持 "auto" | "dark" | "light"

[editor]
command = ""

[notifications]
enabled = true
notification_condition = "unfocused"

[upgrade]
auto_install = true
```

Schema 定义在 `apps/kimi-code/src/tui/config.ts`：
```ts
export const TuiThemeSchema = z.enum(['dark', 'light', 'auto']);
```

### 1.4 主题切换机制

**用户入口**：
- Slash command：`/theme`（或 `/theme dark` / `/theme light` / `/theme auto`）
- 对话框：`ThemeSelectorComponent`

**切换流程**：
1. `handleThemeCommand` → `showThemePicker` / `applyThemeChoice`
2. `saveTuiConfig` 持久化配置
3. `KimiTUI.applyTheme()` 就地更新：
   ```ts
   applyTheme(theme: Theme, resolved?: ResolvedTheme): void {
     const nextTheme = createKimiTUIThemeBundle(theme, resolved);
     Object.assign(this.state.theme.colors, nextTheme.colors);  // 关键：就地更新
     this.state.theme.styles = nextTheme.styles;
     this.state.theme.markdownTheme = nextTheme.markdownTheme;
     this.setAppState({ theme });
     this.state.ui.requestRender(true);
   }
   ```
   **关键设计**：`Object.assign` 就地更新 `colors` 对象，持有引用的组件无需重建即可看到新颜色。

**auto 模式动态追踪**：
- 启用终端主题报告监听（CSI `?996n`、`?2031h`）
- 拦截终端返回的 `ESC[?997;1n`（dark）或 `ESC[?997;2n`（light）
- 自动调用 `applyResolvedAutoTheme(resolved)` 切换色板

### 1.5 自定义主题支持评估

| 能力 | 状态 |
|------|------|
| 内置主题 | ✅ dark / light |
| auto 动态切换 | ✅ 基于终端报告 |
| 自定义主题 | ❌ 完全不支持 |
| 外部主题文件 | ❌ 无 |
| 热重载 | ❌ 无 |
| Schema 校验 | ❌ 无 |

---

## 二、参考系统（pi）主题系统深度分析

### 2.1 代码位置与架构

pi 的主题系统采用 **"JSON 配置 + Theme 类 + 全局单例 + TUI 适配器"** 分层架构：

```
packages/coding-agent/src/modes/interactive/theme/
├── theme.ts              # 核心：Theme 类、加载、校验、ANSI 生成
├── dark.json             # 内置暗色主题
├── light.json            # 内置亮色主题
└── theme-schema.json     # JSON Schema 校验

packages/tui/src/components/
├── editor.ts             # EditorTheme 接口
├── markdown.ts           # MarkdownTheme 接口
├── select-list.ts        # SelectListTheme 接口
└── settings-list.ts      # SettingsListTheme 接口
```

**五层架构**：
1. **数据层**：JSON 主题文件定义颜色 token
2. **核心层**：`Theme` 类解析颜色为 ANSI 转义序列，提供 `fg()`/`bg()` 等方法
3. **全局层**：`globalThis[Symbol.for(...)]` 全局单例，确保多 loader 环境共享
4. **适配层**：`getMarkdownTheme()`、`getEditorTheme()` 映射为 TUI 组件接口
5. **应用层**：`interactive-mode.ts` 中通过 `theme.fg("accent", text)` 着色

### 2.2 主题定义格式（JSON）

```json
{
  "$schema": "https://raw.githubusercontent.com/.../theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "gray": 242
  },
  "colors": {
    "accent": "primary",
    "border": "#5f87ff",
    "text": "",
    ...
  },
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24"
  }
}
```

**51 个 color token**（分 6 组）：
- Core UI（11 个）：`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`
- Backgrounds & Content（11 个）：`selectedBg`, `userMessageBg`, `userMessageText`, `customMessageBg`, `customMessageText`, `customMessageLabel`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput`
- Markdown（10 个）：`mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`
- Tool Diffs（3 个）：`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`
- Syntax Highlighting（9 个）：`syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`
- Thinking Level Borders（6 个）：`thinkingOff` ~ `thinkingXhigh`
- Bash Mode（1 个）：`bashMode`

**颜色值支持的 4 种格式**：
| 格式 | 示例 | 说明 |
|------|------|------|
| Hex | `"#ff0000"` | 6 位 RGB |
| 256-color | `242` | xterm 256 色板索引 |
| 变量引用 | `"primary"` | 引用 `vars` 中定义的值 |
| 默认 | `""` | 使用终端默认颜色 |

### 2.3 主题加载流程

1. `loadThemeJson(name)` 按优先级查找：内置主题 → 已注册主题 → `~/.pi/agent/themes/<name>.json`
2. `parseThemeJson()` 使用 TypeBox 编译的 schema 严格校验
3. `createTheme()` 解析 `vars` 变量引用（支持递归解析和循环引用检测）
4. 按终端能力（truecolor / 256color）生成 ANSI 序列
5. `resolveThemeColors()` 将变量引用解析为最终值

### 2.4 用户自定义主题的 5 种方式

**方式一：直接创建主题文件**
```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```
在 `settings.json` 中设置：`{ "theme": "my-theme" }`

**方式二：settings.json 配置路径**
```json
{
  "themes": ["./my-themes", "!my-themes/excluded.json", "+my-themes/special.json"]
}
```
支持 `!` 排除和 `+` 重新包含模式。

**方式三：CLI 参数**
```bash
pi --theme ./path/to/theme.json
pi --theme ./themes-dir/
pi --no-themes    # 禁用所有主题发现
```

**方式四：package.json**
```json
{
  "pi": {
    "themes": ["./themes"]
  }
}
```
或直接将主题文件放在包内的 `themes/` 目录下自动发现。

**方式五：扩展动态提供**
```ts
pi.on("resources_discover", () => ({
  themePaths: ["/path/to/custom-theme.json"]
}));
```

### 2.5 主题注册/切换/渲染机制

**全局单例**：
```ts
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
export const theme: Theme = new Proxy({} as Theme, {
  get(_target, prop) {
    const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
    if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
    return (t as unknown as Record<string, unknown>)[prop];
  },
});
```

**切换 API**：
- `initTheme(themeName?, enableWatcher?)`：初始化，失败静默回退到 `dark`
- `setTheme(name, enableWatcher?)`：切换主题，失败回退到 `dark`
- `setThemeInstance(themeInstance)`：直接用内存中的 Theme 对象替换
- `setRegisteredThemes(themes[])`：注册来自 resource loader 的主题

**热重载**：
- 当 `enableWatcher=true` 且主题为自定义主题时，启动 `fs.watch`
- 100ms debounce 防抖
- 编辑主题文件后自动重新加载并触发 UI 重绘
- 内置主题不启用 watcher

**去重与冲突处理**：
`resource-loader.ts` 的 `dedupeThemes()` 按主题名去重，同名主题产生 collision diagnostic，先加载的胜出。

**渲染链路**：
1. `interactive-mode.ts` 调用 `theme.fg("accent", text)` 或 `theme.bold(text)`
2. `Theme` 类返回带 ANSI 转义序列的字符串
3. TUI 组件通过各自的 theme 接口获得着色函数
4. 组件 `render()` 输出带 ANSI 码的字符串数组

### 2.6 终端背景检测

- 优先检查 `COLORFGBG` 环境变量（高置信度）
- 支持 `detectTerminalBackground()` 通过 OSC 11 查询
- 默认回退到 `dark`

---

## 三、系统差异对比

| 维度 | kimi-code（当前） | pi（参考） |
|------|------------------|-----------|
| **主题定义** | TypeScript 硬编码常量 | JSON 配置文件 |
| **Token 数量** | ~20 个语义 token | 51 个 color token + vars |
| **颜色格式** | 仅 hex | hex / 256色 / 变量引用 / 默认 |
| **Schema 校验** | ❌ 无 | ✅ JSON Schema + TypeBox |
| **自定义方式** | ❌ 不支持 | 5 种方式（文件、配置、CLI、package.json、扩展） |
| **热重载** | ❌ 无 | ✅ fs.watch + debounce |
| **全局单例** | 通过 `TUIState` 传递 | `globalThis[Symbol]` + Proxy |
| **就地更新** | ✅ Object.assign | 替换 Theme 实例 |
| **终端检测** | ✅ OSC 11 + COLORFGBG | ✅ OSC 11 + COLORFGBG |
| **auto 动态追踪** | ✅ CSI ?2031h | 未明确 |
| **TUI 适配** | `KimiTUIThemeBundle` | `getMarkdownTheme()` / `getEditorTheme()` |
| **冲突处理** | 不适用 | 去重 + collision diagnostic |

---

## 四、建议的实现方案

基于以上调研，建议为 kimi-code 引入自定义主题能力，方案如下：

### 4.1 核心设计原则

1. **向后兼容**：`dark` / `light` / `auto` 继续作为内置选项，行为不变
2. **保持语义化 token**：沿用当前的 `ColorPalette` 接口，不盲目扩张到 51 个 token
3. **保持就地更新**：继续利用 `Object.assign` 就地更新机制，避免组件重建
4. **最小侵入**：不改动现有组件消费主题的方式

### 4.2 建议的 theme.json 格式

```json
{
  "name": "my-custom-theme",
  "displayName": "My Custom Theme",
  "colors": {
    "primary": "#4FA8FF",
    "accent": "#00D7FF",
    "text": "#E4E4E7",
    "textStrong": "#FAFAFA",
    "textDim": "#71717A",
    "success": "#4ADE80",
    "error": "#F87171",
    "warning": "#FBBF24",
    "diffAdded": "#4ADE80",
    "diffRemoved": "#F87171",
    "roleUser": "#4FA8FF",
    "roleAssistant": "#A78BFA",
    "background": "#18181B",
    "surface": "#27272A",
    "border": "#3F3F46"
  }
}
```

### 4.3 建议的文件组织

```
~/.kimi-code/
├── tui.toml              # theme = "my-custom-theme"
└── themes/
    ├── my-custom-theme.json
    └── another-theme.json
```

### 4.4 建议的 tui.toml 扩展

```toml
theme = "my-custom-theme"  # 支持 "auto" | "dark" | "light" | 自定义主题名

# 可选：自定义主题搜索路径
theme_paths = ["~/.kimi-code/themes", "./project-themes"]

[editor]
command = ""

[notifications]
enabled = true
notification_condition = "unfocused"

[upgrade]
auto_install = true
```

### 4.5 建议的实现步骤

1. **定义自定义主题加载器**：在 `apps/kimi-code/src/tui/theme/` 下新增 `custom-theme-loader.ts`
   - 从 `~/.kimi-code/themes/` 加载 `.json` 主题文件
   - 将 JSON 颜色映射为 `ColorPalette` 对象
   - 缺失的颜色回退到 `darkColors`

2. **扩展 `Theme` 类型和解析**：
   - `Theme = 'dark' | 'light' | 'auto' | string`（string 表示自定义主题名）
   - `getColorPalette(theme)` 增加自定义主题分支

3. **扩展 `tui.toml` Schema**：
   - `theme` 字段从 `z.enum` 改为 `z.string()`
   - 可选新增 `theme_paths` 配置

4. **扩展主题切换逻辑**：
   - `applyTheme()` 和 `createKimiTUIThemeBundle()` 支持自定义主题
   - 自定义主题加载失败时回退到 `dark`

5. **（可选）热重载**：
   - 对自定义主题启用 `fs.watch`
   - 文件变更时自动重新加载并触发 `requestRender(true)`

6. **（可选）JSON Schema**：
   - 为主题 JSON 提供 Schema 文件，支持编辑器自动补全和校验

7. **（可选）主题选择器扩展**：
   - `ThemeSelectorComponent` 扫描 `~/.kimi-code/themes/` 目录，列出可用自定义主题

### 4.6 需要特别注意的点

| 注意点 | 说明 |
|--------|------|
| **颜色格式兼容性** | 当前系统使用 hex 字符串，pi 支持 hex/256色/变量引用。若引入变量引用需新增解析逻辑。建议一期仅支持 hex。 |
| **MarkdownTheme / EditorTheme 映射** | `pi-tui-theme.ts` 中 `createMarkdownTheme` 和 `createEditorTheme` 依赖 `ColorPalette`。自定义主题需确保这些映射正确。 |
| **就地更新的边界** | `Object.assign` 更新 `colors` 对象可以工作，但如果自定义主题的颜色 token 集合与内置不同，需确保所有组件消费的颜色都有回退值。 |
| **终端主题追踪的兼容性** | 当用户选择自定义主题时，应禁用 `auto` 模式的终端主题追踪，避免冲突。 |
| **配置迁移** | 现有用户的 `tui.toml` 中 `theme = "auto"` 等值应继续有效，无需迁移。 |

---

## 五、关键文件清单

### 当前系统需修改的文件

| 文件 | 修改内容 |
|------|----------|
| `apps/kimi-code/src/tui/theme/index.ts` | 扩展 `Theme` 类型支持自定义主题名 |
| `apps/kimi-code/src/tui/theme/colors.ts` | 定义自定义主题回退机制 |
| `apps/kimi-code/src/tui/theme/bundle.ts` | `createKimiTUIThemeBundle` 支持自定义主题加载 |
| `apps/kimi-code/src/tui/theme/custom-theme-loader.ts` | **新增**：自定义主题加载器 |
| `apps/kimi-code/src/tui/config.ts` | 扩展 `TuiConfigFileSchema`，`theme` 改为 `z.string()` |
| `apps/kimi-code/src/tui/tui-state.ts` | 初始化时加载自定义主题 |
| `apps/kimi-code/src/tui/kimi-tui.ts` | `applyTheme` 支持自定义主题 |
| `apps/kimi-code/src/tui/commands/config.ts` | `handleThemeCommand` 支持自定义主题名 |
| `apps/kimi-code/src/tui/components/dialogs/theme-selector.ts` | 列出可用自定义主题 |

### pi 项目可供参考的文件

| 文件 | 参考价值 |
|------|----------|
| `packages/coding-agent/src/modes/interactive/theme/theme.ts` | Theme 类实现、加载流程、ANSI 生成 |
| `packages/coding-agent/src/modes/interactive/theme/dark.json` | 主题 JSON 文件格式参考 |
| `packages/coding-agent/src/modes/interactive/theme/theme-schema.json` | JSON Schema 定义参考 |
| `packages/coding-agent/src/core/resource-loader.ts` | 主题发现、去重、冲突处理 |
| `packages/coding-agent/src/config.ts` | `getThemesDir()` 等路径配置 |
| `packages/coding-agent/src/core/settings-manager.ts` | `getTheme()` / `setTheme()` API |

---

## 六、结论

引入自定义主题功能是**可行且有价值**的。pi 项目的主题系统提供了成熟的参考实现，但 kimi-code 的当前架构更简洁（~20 token vs 51 token），建议**保持精简**而非全盘复制。

**推荐的一期 MVP 范围**：
1. 支持用户将自定义主题 JSON 文件放在 `~/.kimi-code/themes/` 目录
2. 在 `tui.toml` 的 `theme` 字段中使用自定义主题名
3. 自定义主题只需定义部分颜色，缺失的自动回退到 `darkColors`
4. `/theme` 命令和主题选择器列出可用自定义主题

**二期可扩展**：
- 主题热重载
- JSON Schema 校验
- `theme_paths` 配置支持多目录
- 变量引用（`vars`）支持
- package.json / 扩展动态提供主题
