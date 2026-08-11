# @moonshot-ai/app-ui

Source-only presentational component library for the Kimi web apps. `exports`
points at `./src/*`, so the consumer's bundler transpiles it (no prebuild step);
`vue` is a peer dependency. Import components as named exports
(`import { Button, Icon } from '@moonshot-ai/app-ui'`).

消费方 Vite 必须：

1. `import '@moonshot-ai/app-ui/style.css'` 一次（设计 tokens）。
2. unplugin-icons 注册 `kimi` collection（组件内 `~icons/kimi/*`）：
   ```ts
   import Icons from 'unplugin-icons/vite';
   import { FileSystemIconLoader } from 'unplugin-icons/loaders';
   Icons({ compiler: 'vue3', customCollections: {
     kimi: FileSystemIconLoader('<path-to-icons>', svg => svg.replace(/^<svg /, '<svg fill="currentColor" ')),
   }});
   ```
3. 组件用 `<html data-color-scheme>` 切换主题；消费方负责设置该属性。
4. `app.provide(IconResolverKey, name => Component | undefined)`，把 `<Icon name>`
   桥到消费方自己的 icon registry（`IconResolverKey` 与 `Component` 类型分别从
   `@moonshot-ai/app-ui` / `vue` 导入）。`<Icon>` 本身不持有 registry，未
   provide 或对未注册名时渲染为空，不抛错。
5. 若消费方需要直接读取「当前打开的 Dialog 数量」（例如根级 capture 阶段的
   Esc 让位给已开 Dialog），`import { openDialogCount } from '@moonshot-ai/app-ui'`；
   `<Dialog>` 会随 `open` 自动增减该 `ref`，无需手动维护。
