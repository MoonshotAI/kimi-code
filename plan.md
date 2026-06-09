# 主题系统重构 + 自定义主题实施计划

## 目标

1. **重构主题系统为 pi 模式**：全局 Theme 单例，组件通过方法调用获取颜色，切换主题时所有组件（包括历史消息）即时变色。
2. **支持自定义主题**：用户通过 `theme.json` 文件定义颜色，在 `tui.toml` 中引用。

---

## 架构设计

### 核心变化：从 "数据传递" 到 "方法调用"

| 维度 | 当前（数据传递） | 目标（pi 模式） |
|------|-----------------|----------------|
| 组件获取颜色 | `chalk.hex(this.colors.primary)(text)` | `theme.fg('primary', text)` |
| 颜色载体 | `ColorPalette` 对象在各组件间传递 | 全局 `Theme` 单例，组件直接 import |
| 主题切换 | `Object.assign` 就地更新 `colors` 对象 | 替换/更新全局 Theme 实例的 palette |
| 历史消息变色 | ❌ 构造函数缓存了字符串值或预染色了 Text | ✅ 每次 `render()` 调用 Theme 方法读取当前 palette |

### Theme 类设计

```ts
// theme/theme.ts
export class Theme {
  private _palette: ColorPalette;

  constructor(palette: ColorPalette) {
    this._palette = palette;
  }

  get palette(): ColorPalette { return this._palette; }
  setPalette(palette: ColorPalette): void { this._palette = palette; }

  /** Raw hex color string */
  color(token: ColorToken): string { return this._palette[token]; }

  // Foreground
  fg(token: ColorToken, text: string): string { return chalk.hex(this._palette[token])(text); }
  boldFg(token: ColorToken, text: string): string { return chalk.bold.hex(this._palette[token])(text); }
  dimFg(token: ColorToken, text: string): string { return chalk.dim.hex(this._palette[token])(text); }
  italicFg(token: ColorToken, text: string): string { return chalk.italic.hex(this._palette[token])(text); }

  // Standalone styles
  bold(text: string): string { return chalk.bold(text); }
  dim(text: string): string { return chalk.dim(text); }
  italic(text: string): string { return chalk.italic(text); }
  underline(text: string): string { return chalk.underline(text); }
  strikethrough(text: string): string { return chalk.strikethrough(text); }

  // MarkdownTheme — lazily created, reads current palette on each call
  get markdownTheme(): MarkdownTheme {
    return createMarkdownTheme();
  }
  get editorTheme(): EditorTheme {
    return createEditorTheme();
  }
}

// 全局单例（就地更新，不替换实例）
export const currentTheme = new Theme(darkColors);
```

### MarkdownTheme 闭包模式

```ts
// theme/pi-tui-theme.ts
import { currentTheme } from './theme.js';

export function createMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => chalk.bold.hex(currentTheme.color('text'))(stripHash(text)),
    link: (text) => chalk.hex(currentTheme.color('primary'))(text),
    // ... 每次调用读取 currentTheme.color('xxx')，即时反映主题变化
  };
}
```

旧组件持有的旧 `MarkdownTheme` 实例，在 `render()` 调用其方法时，闭包读取 `currentTheme.color(...)`，自动使用新主题颜色。

---

## 阶段 1：Theme 核心层重构（5 个文件）

### 1.1 新增 `theme/theme.ts` — Theme 类 + 全局单例

```ts
import chalk from 'chalk';
import type { ColorPalette } from './colors';
import { darkColors } from './colors';
import { createMarkdownTheme } from './pi-tui-theme';
import { createEditorTheme } from './pi-tui-theme';
import type { MarkdownTheme, EditorTheme } from '@earendil-works/pi-tui';

export type ColorToken = keyof ColorPalette;

export class Theme {
  private _palette: ColorPalette;
  private _markdownTheme?: MarkdownTheme;
  private _editorTheme?: EditorTheme;

  constructor(palette: ColorPalette) {
    this._palette = palette;
  }

  get palette(): ColorPalette { return this._palette; }

  setPalette(palette: ColorPalette): void {
    this._palette = palette;
    this._markdownTheme = undefined;
    this._editorTheme = undefined;
  }

  color(token: ColorToken): string {
    return this._palette[token];
  }

  fg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token])(text);
  }

  boldFg(token: ColorToken, text: string): string {
    return chalk.bold.hex(this._palette[token])(text);
  }

  dimFg(token: ColorToken, text: string): string {
    return chalk.dim.hex(this._palette[token])(text);
  }

  italicFg(token: ColorToken, text: string): string {
    return chalk.italic.hex(this._palette[token])(text);
  }

  underlineFg(token: ColorToken, text: string): string {
    return chalk.underline.hex(this._palette[token])(text);
  }

  bold(text: string): string { return chalk.bold(text); }
  dim(text: string): string { return chalk.dim(text); }
  italic(text: string): string { return chalk.italic(text); }
  underline(text: string): string { return chalk.underline(text); }
  strikethrough(text: string): string { return chalk.strikethrough(text); }

  get markdownTheme(): MarkdownTheme {
    if (!this._markdownTheme) this._markdownTheme = createMarkdownTheme();
    return this._markdownTheme;
  }

  get editorTheme(): EditorTheme {
    if (!this._editorTheme) this._editorTheme = createEditorTheme();
    return this._editorTheme;
  }
}

export const currentTheme = new Theme(darkColors);
```

### 1.2 `theme/colors.ts` — 保留 ColorPalette，增加自定义主题支持

```ts
// 新增：自定义主题加载
import { loadCustomTheme } from './custom-theme-loader';

export async function getColorPalette(theme: ThemeName): Promise<ColorPalette> {
  if (theme === 'light') return lightColors;
  if (theme === 'dark') return darkColors;
  if (theme === 'auto') {
    const detected = await detectTerminalTheme();
    return detected === 'light' ? lightColors : darkColors;
  }
  // 自定义主题
  return (await loadCustomTheme(theme)) ?? darkColors;
}
```

### 1.3 `theme/styles.ts` — 删除或简化

当前 `ThemeStyles` 几乎没被组件使用。重构后组件直接调用 `theme.fg()` 等方法，不再需要 `ThemeStyles`。

**方案**：删除 `styles.ts`，将其功能整合到 `Theme` 类中。如果某些代码确实使用了 `state.theme.styles`，改为使用 `currentTheme`。

### 1.4 `theme/bundle.ts` — 删除

`KimiTUIThemeBundle` 不再存在。`TUIState.theme` 改为 `Theme` 实例。

### 1.5 `theme/index.ts` — 公共 API 重写

```ts
export { currentTheme, Theme } from './theme';
export type { ColorToken } from './theme';
export { darkColors, lightColors, getColorPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { detectTerminalTheme } from './detect';

export type BuiltInTheme = 'dark' | 'light' | 'auto';
export type ThemeName = BuiltInTheme | string;

export function isBuiltInTheme(value: string): value is BuiltInTheme {
  return value === 'dark' || value === 'light' || value === 'auto';
}
```

---

## 阶段 2：自定义主题加载器（2 个新文件）

### 2.1 `theme/custom-theme-loader.ts`

```ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ColorPalette, darkColors } from './colors';
import { getDataDir } from '#/utils/paths';

export const CustomThemeSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  colors: z.record(z.string()).optional(),
});

const hexColorRegex = /^#[0-9a-fA-F]{6}$/;

export function getCustomThemesDir(): string {
  return join(getDataDir(), 'themes');
}

export async function loadCustomTheme(name: string): Promise<ColorPalette | null> {
  try {
    const content = await readFile(join(getCustomThemesDir(), `${name}.json`), 'utf-8');
    const parsed = CustomThemeSchema.parse(JSON.parse(content));

    const errors: string[] = [];
    for (const [key, value] of Object.entries(parsed.colors ?? {})) {
      if (!hexColorRegex.test(value)) {
        errors.push(`colors.${key}: "${value}" is not a valid hex color`);
      }
    }
    if (errors.length > 0) {
      console.warn(`Theme "${name}" has invalid colors:\n${errors.join('\n')}`);
    }

    const validColors = Object.fromEntries(
      Object.entries(parsed.colors ?? {}).filter(([, v]) => hexColorRegex.test(v)),
    );
    return { ...darkColors, ...validColors };
  } catch {
    return null;
  }
}

export async function listCustomThemes(): Promise<string[]> {
  try {
    const entries = await readdir(getCustomThemesDir(), { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => e.name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
```

### 2.2 `theme/theme-schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/moonshot-ai/kimi-code/blob/main/apps/kimi-code/src/tui/theme/theme-schema.json",
  "title": "Kimi Code Custom Theme",
  "type": "object",
  "required": ["name"],
  "properties": {
    "$schema": { "type": "string" },
    "name": { "type": "string", "minLength": 1 },
    "displayName": { "type": "string" },
    "colors": {
      "type": "object",
      "properties": {
        "primary": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "accent": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "text": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "textStrong": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "textDim": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "textMuted": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "border": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "borderFocus": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "success": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "warning": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "error": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "diffAdded": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "diffRemoved": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "diffAddedStrong": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "diffRemovedStrong": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "diffGutter": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "diffMeta": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "roleUser": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "roleAssistant": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "roleThinking": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "roleTool": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "status": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }
      },
      "additionalProperties": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }
    }
  },
  "additionalProperties": false
}
```

---

## 阶段 3：配置层扩展（2 个文件）

### 3.1 `tui/config.ts`

```ts
export const TuiThemeSchema = z.string(); // 从 z.enum 改为任意字符串

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  // ...
});
```

### 3.2 `tui/types.ts`

```ts
import type { ThemeName } from './theme';

export interface AppState {
  // ...
  theme: ThemeName;
  // ...
}
```

---

## 阶段 4：TUI 状态与切换逻辑（4 个文件）

### 4.1 `tui/tui-state.ts`

```ts
import { currentTheme, type Theme } from './theme/theme';

export interface TUIState {
  // ...
  theme: Theme;  // 从 KimiTUIThemeBundle 改为 Theme
  // ...
}

export function createTUIState(options: KimiTUIOptions): TUIState {
  // 启动时已通过 run-shell.ts 设置好 currentTheme 的 palette
  // 这里直接使用全局单例
  const theme = currentTheme;
  
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  
  // 组件不再需要传 colors，它们自己 import currentTheme
  const todoPanel = new TodoPanelComponent();
  const editor = new CustomEditor(ui);
  const footer = new FooterComponent({ ...initialAppState }, () => ui.requestRender());
  
  return {
    // ...
    theme,
    // ...
  };
}
```

### 4.2 `cli/run-shell.ts`

启动时异步解析主题，设置全局 `currentTheme`：

```ts
import { currentTheme, getColorPalette, isBuiltInTheme } from '#/tui/theme';

async function initTheme(themeName: ThemeName): Promise<void> {
  const palette = await getColorPalette(themeName);
  currentTheme.setPalette(palette);
}

// 在启动流程中：
await initTheme(tuiConfig.theme);
```

### 4.3 `tui/kimi-tui.ts` — `applyTheme`

```ts
async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
  const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
  currentTheme.setPalette(palette);
  
  this.state.theme = currentTheme;
  this.setAppState({ theme: themeName });
  this.updateEditorBorderHighlight();
  this.state.ui.requestRender(true);
}
```

### 4.4 终端主题追踪

```ts
refreshTerminalThemeTracking(): void {
  this.stopTerminalThemeTracking();
  if (!isBuiltInTheme(this.state.appState.theme) || this.state.appState.theme !== 'auto') return;
  // ...
}
```

自定义主题下禁用终端主题追踪。

---

## 阶段 5：组件层重构（~30 个文件）

### 迁移模式

所有 `chalk.hex(colors.xxx)` 调用替换为 `theme.xxx()` 方法调用。常见映射：

| 原代码 | 新代码 |
|--------|--------|
| `chalk.hex(colors.primary)(text)` | `theme.fg('primary', text)` |
| `chalk.hex(colors.primary).bold(text)` | `theme.boldFg('primary', text)` |
| `chalk.bold.hex(colors.text)(text)` | `theme.boldFg('text', text)` |
| `chalk.hex(colors.textDim)(text)` | `theme.fg('textDim', text)` |
| `chalk.hex(colors.textDim).italic(text)` | `theme.italicFg('textDim', text)` |
| `chalk.dim(text)` | `theme.dim(text)` |
| `chalk.italic(text)` | `theme.italic(text)` |
| `chalk.bold(text)` | `theme.bold(text)` |
| `colors.primary` | `theme.color('primary')` |

### 5.1 Chrome 层组件（保存 `colors` 引用，render 时读取）

这些组件已经在 `render()` 时实时读取颜色，只需替换调用方式：

| 文件 | 改动 |
|------|------|
| `components/chrome/footer.ts` | 删除 `setColors` / `this.colors`，`render()` 中所有 `chalk.hex(this.colors.xxx)` → `theme.fg('xxx', ...)` |
| `components/chrome/todo-panel.ts` | 删除 `setColors` / `this.colors`，`render()` 中替换调用 |
| `components/chrome/welcome.ts` | 删除 `this.colors`，`render()` 中替换 |
| `components/editor/custom-editor.ts` | 检查颜色使用方式，替换为 theme 调用 |
| `components/dialogs/session-picker.ts` | 删除 `this.colors`，替换调用 |
| `components/dialogs/model-selector.ts` | 替换调用 |
| `components/dialogs/feedback-input-dialog.ts` | 替换调用 |
| `components/dialogs/custom-registry-import.ts` | 替换调用 |
| `components/dialogs/goal-start-permission-prompt.ts` | 替换调用 |
| `components/panes/btw-panel.ts` | 替换调用 |

### 5.2 消息层组件（构造函数缓存/预染色）

这些组件需要重构，不再在构造函数中缓存颜色值或预染色 Text：

#### `components/messages/user-message.ts`

```ts
// 重构前：
constructor(text: string, colors: ColorPalette, images?: ImageAttachment[]) {
  this.color = colors.roleUser;
  this.textComponent = new Text(chalk.hex(colors.roleUser).bold(text), 0, 0);
  this.imageThumbnails = images?.map(img => new ImageThumbnail(img, colors)) ?? [];
}
render(width) {
  const bullet = chalk.hex(this.color).bold(USER_MESSAGE_BULLET);
  const textLines = this.textComponent.render(contentWidth);
}

// 重构后：
constructor(text: string, images?: ImageAttachment[]) {
  this.text = text;
  this.imageThumbnails = images?.map(img => new ImageThumbnail(img)) ?? [];
}
render(width) {
  const bullet = theme.boldFg('roleUser', USER_MESSAGE_BULLET);
  const bulletWidth = visibleWidth(bullet);
  const contentWidth = Math.max(1, width - bulletWidth);
  
  // 使用 Text 组件处理换行，但 render 时传入当前染色文本
  const coloredText = theme.boldFg('roleUser', this.text);
  const textLines = new Text(coloredText, 0, 0).render(contentWidth);
  
  // ...
}
```

#### `components/messages/assistant-message.ts`

```ts
// 重构前：
constructor(markdownTheme: MarkdownTheme, colors: ColorPalette, showBullet = true) {
  this.markdownTheme = markdownTheme;
  this.bulletColor = colors.roleAssistant;
  this.contentContainer = new Container();
}

// 重构后：
constructor(showBullet = true) {
  this.showBullet = showBullet;
  this.contentContainer = new Container();
}
updateContent(text: string): void {
  this.contentContainer.clear();
  this.contentContainer.addChild(new Markdown(text.trim(), 0, 0, currentTheme.markdownTheme));
}
render(width) {
  const p = i === 0 && this.showBullet
    ? theme.fg('roleAssistant', STATUS_BULLET)
    : MESSAGE_INDENT;
}
```

#### `components/messages/thinking.ts`

```ts
// 重构前：
constructor(text: string, colors: ColorPalette) {
  this.color = colors.roleThinking;
  this.textComponent = new Text(this.styled(text), 0, 0);
}
styled(text: string): string {
  return chalk.hex(this.color).italic(text);
}

// 重构后：
constructor(text: string) {
  this.text = text;
  this.textComponent = new Text('', 0, 0);
}
setText(text: string): void {
  this.text = text;
  this.textComponent.setText(theme.italicFg('roleThinking', text));
}
render(width) {
  // textComponent 已包含染色文本
  return this.textComponent.render(width);
}
```

#### `components/messages/status-message.ts`

```ts
// 重构前：
constructor(content: string, colors: ColorPalette, color?: string) {
  super();
  const text = color === undefined
    ? chalk.hex(colors.textDim)(content)
    : chalk.hex(color)(content);
  this.addChild(new Text(`  ${text}`, 0, 0));
}

// 重构后：
constructor(content: string, color?: string) {
  super();
  this.content = content;
  this.overrideColor = color;
  this.textComponent = new Text('', 0, 0);
  this.addChild(this.textComponent);
}
render(width) {
  const colored = this.overrideColor
    ? chalk.hex(this.overrideColor)(this.content)
    : theme.fg('textDim', this.content);
  this.textComponent.setText(`  ${colored}`);
  return super.render(width);
}
```

> 注意：`StatusMessageComponent` 是 `Container` 的子类。如果它的 `render()` 已经被父类处理了，可能需要调整。或者干脆不用 `Container` 继承，改为直接 `Component`。

#### `components/messages/notice-message.ts`

类似 `StatusMessageComponent` 的重构方式。

#### `components/messages/skill-activation.ts`

```ts
// 重构前：
constructor(name: string, args: string, colors: ColorPalette) {
  const head = chalk.hex(colors.primary).bold('▶ Activated skill: ') + chalk.hex(colors.roleUser).bold(name);
  this.addChild(new Text(head, 0, 0));
  // ...
}

// 重构后：
constructor(name: string, args: string) {
  this.name = name;
  this.args = args;
}
render(width) {
  const head = theme.boldFg('primary', '▶ Activated skill: ') + theme.boldFg('roleUser', this.name);
  // ...
}
```

#### `components/messages/plan-box.ts`

```ts
// 重构前：
constructor(plan: string, markdownTheme: MarkdownTheme) {
  this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme);
}

// 重构后：
constructor(plan: string) {
  this.plan = plan;
}
render(width) {
  const markdown = new Markdown(this.plan.trim(), 0, 0, currentTheme.markdownTheme);
  // ...
}
```

#### `components/media/image-thumbnail.ts`

```ts
// 重构前：
constructor(attachment: ImageAttachment, colors: ColorPalette) {
  this.addChild(new Text(chalk.hex(colors.accent)(attachment.placeholder), 0, 0));
}

// 重构后：
constructor(attachment: ImageAttachment) {
  this.attachment = attachment;
}
render(width) {
  return new Text(theme.fg('accent', this.attachment.placeholder), 0, 0).render(width);
}
```

#### `components/media/diff-preview.ts`

```ts
// 重构前：
export function createDiffStyles(colors: ColorPalette) {
  return {
    add: (s) => chalk.hex(colors.diffAdded)(s),
    // ...
  };
}

// 重构后：
export function createDiffStyles() {
  return {
    add: (s) => theme.fg('diffAdded', s),
    // ...
  };
}
```

### 5.3 其他需要检查的组件

| 文件 | 说明 |
|------|------|
| `components/messages/tool-renderers/*.ts` | 各类工具输出渲染器，检查颜色使用 |
| `components/messages/goal-panel.ts` | Goal 相关消息 |
| `components/messages/cron-message.ts` | Cron 消息 |
| `components/messages/background-agent-status.ts` | 后台 Agent 状态 |
| `components/messages/usage-panel.ts` | Usage 面板 |
| `components/chrome/device-code-box.ts` | 设备码登录框 |
| `components/messages/goal-markers.ts` | Goal 标记 |

### 5.4 `kimi-tui.ts` 中创建组件的调用点

所有 `new XxxComponent(..., this.state.theme.colors, ...)` 改为 `new XxxComponent(...)`，删除 `colors` 参数。

---

## 阶段 6：命令与交互（2 个文件）

### 6.1 `tui/commands/config.ts`

```ts
async function showThemePicker(tui: KimiTUI): Promise<void> {
  const customThemes = await listCustomThemes();
  const choices = [
    { id: 'auto', label: 'Auto', description: 'Follow terminal' },
    { id: 'dark', label: 'Dark', description: 'Dark color scheme' },
    { id: 'light', label: 'Light', description: 'Light color scheme' },
    ...customThemes.map(name => ({ id: name, label: name, description: 'Custom theme' })),
  ];
  // ...
}
```

### 6.2 `tui/components/dialogs/theme-selector.ts`

同样扩展选项列表，包含自定义主题。

---

## 测试计划

### 单元测试

1. **Theme 类**
   - `new Theme(darkColors).color('primary')` → `'#4FA8FF'`
   - `theme.fg('primary', 'hi')` → 包含正确 ANSI 码
   - `theme.setPalette(lightColors)` 后，`theme.color('primary')` → `'#1565C0'`
   - `theme.boldFg('primary', 'hi')` → bold + 正确颜色

2. **custom-theme-loader**
   - `loadCustomTheme('existing')` → 合并后的 ColorPalette
   - `loadCustomTheme('missing')` → null
   - `loadCustomTheme('bad-hex')` → 过滤非法值，回退 dark
   - `listCustomThemes()` → 返回文件名列表

3. **pi-tui-theme**
   - `createMarkdownTheme().heading('text')` → 使用当前 theme 颜色
   - `currentTheme.setPalette(lightColors)` 后，同一 `markdownTheme` 实例调用 `heading()` → 使用 light 颜色

### 集成测试

1. 启动 TUI，主题正确加载
2. 切换主题（dark → light），Footer、Editor 即时变色
3. 发送消息后切换主题，历史消息的子弹头、文本颜色同步更新
4. 自定义主题加载，部分字段覆盖生效，缺失字段回退 dark
5. 自定义主题文件不存在，静默回退 dark
6. `/theme` 命令列出所有自定义主题
7. 自定义主题下终端背景报告不触发自动切换

### 手动测试

1. 逐个检查所有消息类型（user、assistant、thinking、status、notice、skill、tool、plan）在主题切换后的颜色
2. Markdown 渲染（代码块、链接、引用）颜色正确
3. Editor 边框高亮颜色正确
4. 对话框（session picker、model selector）颜色正确

---

## 文件修改总览

### 删除（3 个文件）

| 文件 | 原因 |
|------|------|
| `theme/styles.ts` | 功能合并到 Theme 类 |
| `theme/bundle.ts` | KimiTUIThemeBundle 不再存在 |

### 新增（5 个文件）

| 文件 | 说明 |
|------|------|
| `theme/theme.ts` | Theme 类 + 全局单例 |
| `theme/custom-theme-loader.ts` | 自定义主题加载器 |
| `theme/theme-schema.json` | JSON Schema |
| `examples/custom-theme.json` | 示例主题 |

### 修改（~25 个文件）

| 文件 | 改动 |
|------|------|
| `theme/index.ts` | 导出 Theme 类、全局单例、ThemeName 类型 |
| `theme/colors.ts` | `getColorPalette` 支持自定义主题（async） |
| `theme/pi-tui-theme.ts` | 闭包读取 `currentTheme.color()` 而非捕获 colors 引用 |
| `tui/config.ts` | `TuiThemeSchema` 改为 `z.string()` |
| `tui/types.ts` | `AppState.theme` 改为 `ThemeName` |
| `tui/tui-state.ts` | `theme` 字段改为 `Theme`，组件构造删除 colors 参数 |
| `tui/kimi-tui.ts` | `applyTheme` 改为设置全局 Theme palette，遍历组件逻辑调整 |
| `cli/run-shell.ts` | 启动时异步初始化全局 Theme |
| `components/chrome/footer.ts` | 删除 colors 缓存，改用 theme 方法 |
| `components/chrome/todo-panel.ts` | 同上 |
| `components/chrome/welcome.ts` | 同上 |
| `components/editor/custom-editor.ts` | 同上 |
| `components/dialogs/session-picker.ts` | 同上 |
| `components/dialogs/model-selector.ts` | 同上 |
| `components/messages/user-message.ts` | 重构：不预染色 Text，render 时动态染色 |
| `components/messages/assistant-message.ts` | 重构：删除 bulletColor 缓存，使用 theme.markdownTheme |
| `components/messages/thinking.ts` | 重构：删除 color 缓存，setText 时动态染色 |
| `components/messages/status-message.ts` | 重构：不预染色 Container 子组件 |
| `components/messages/notice-message.ts` | 重构：同上 |
| `components/messages/skill-activation.ts` | 重构：render 时动态染色 |
| `components/messages/plan-box.ts` | 重构：render 时创建 Markdown |
| `components/media/image-thumbnail.ts` | 重构：render 时动态染色 |
| `components/media/diff-preview.ts` | 重构：使用 theme 方法 |
| `components/panes/btw-panel.ts` | 替换颜色调用 |
| `tui/commands/config.ts` | `/theme` 命令列出自定义主题 |

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 组件重构遗漏，某些颜色仍使用旧值 | 高 | 全局搜索 `chalk.hex(colors.` 和 `colors.` 确保全部替换；集成测试逐个检查 |
| `Text` 组件缓存失效导致性能下降 | 低 | 消息组件文本量小，换行计算开销可忽略；Chrome 层组件本来就在 render 时动态计算 |
| `Markdown` 组件每次 render 重建导致性能下降 | 低 | `AssistantMessageComponent` 的 `updateContent` 只在内容变化时调用；`PlanBox` 类似 |
| `Container.addChild` / `clear` 模式被破坏 | 中 | `StatusMessageComponent` / `NoticeMessageComponent` 改为不再继承 Container，或调整 render 逻辑 |
| 自定义主题加载失败 | 中 | 所有路径回退 `darkColors` |
| `theme-schema.json` 与 Zod Schema 不同步 | 低 | 维护契约：新增 token 时两边同时更新 |

---

## 验收标准

- [ ] `dark` / `light` / `auto` 行为与之前一致
- [ ] 主题切换后，所有已渲染组件（包括历史消息）即时变色
- [ ] `tui.toml` 支持 `theme = "my-custom-theme"`
- [ ] 自定义主题 JSON 只定义部分字段时，其余回退 dark
- [ ] 自定义主题文件不存在时，静默回退 dark
- [ ] 非法 hex 值被过滤，合法值生效，用户收到 warning
- [ ] `/theme` 命令和主题选择器列出所有自定义主题
- [ ] 编辑器打开 `theme.json` 时自动补全字段并校验格式
- [ ] 所有现有测试通过
