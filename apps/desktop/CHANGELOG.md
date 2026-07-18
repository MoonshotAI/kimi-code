# kimi-code-app

## 0.0.3

### Patch Changes

- [#26](https://github.com/MoonshotAI/kimi-code-app/pull/26) [`034c432`](https://github.com/MoonshotAI/kimi-code-app/commit/034c432d3f849323730271b330870d568c6d6472) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持自动更新：发现新版本后侧栏会出现更新提示，点击下载、下载完成后重启即可完成升级。

- [#22](https://github.com/MoonshotAI/kimi-code-app/pull/22) [`38f6ac6`](https://github.com/MoonshotAI/kimi-code-app/commit/38f6ac6a2298bb4383ee740dc6c502433b6a65fc) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复按 Esc 的连坐打断：关闭弹窗、问答卡或输入框下拉菜单时，不再同时打断正在输出的会话。

- [#24](https://github.com/MoonshotAI/kimi-code-app/pull/24) [`015c299`](https://github.com/MoonshotAI/kimi-code-app/commit/015c299235c22e1a7150ac9c074abc22ef04c19c) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复使用过程中可能突然弹出主进程错误弹窗的问题；桌面端运行日志现在会保存到本地文件，便于排查问题。

- [#25](https://github.com/MoonshotAI/kimi-code-app/pull/25) [`50be936`](https://github.com/MoonshotAI/kimi-code-app/commit/50be93649c1f5727131e92e72a5947aa3fdf0cb9) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计输入框里的模型选择器及下拉面板：展开有弹出动画、箭头翻转，思考等级切换与设置页统一为滑动分段控件，支持下拉内方向键选择，键盘操作有清晰的焦点提示。

- [#23](https://github.com/MoonshotAI/kimi-code-app/pull/23) [`a7d3961`](https://github.com/MoonshotAI/kimi-code-app/commit/a7d396196d35d339e378ab2d4bc2d51a0d070346) Thanks [@liruifengv](https://github.com/liruifengv)! - Add an "open in" control to the chat header: open the current workspace in a detected editor or terminal (VS Code, Cursor, Zed, Finder, Terminal, iTerm2, Ghostty, Warp, Xcode on macOS), with a matching default-app select in Settings.

- [#19](https://github.com/MoonshotAI/kimi-code-app/pull/19) [`d857232`](https://github.com/MoonshotAI/kimi-code-app/commit/d85723243253b50e803a07c15975af9cbc62f527) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计会话搜索弹窗：关键词高亮更柔和，空结果或无会话时展示占位提示。

- [#21](https://github.com/MoonshotAI/kimi-code-app/pull/21) [`d8b150f`](https://github.com/MoonshotAI/kimi-code-app/commit/d8b150f28584f6fb385cb118285f95bf2d5bcfd2) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计模型选择弹窗，并统一所有弹窗的版式：标题栏、搜索框（支持一键清除）、列表与底部快捷键栏采用同一套样式，当前选择以中性底色和对勾标记，键盘上下选择时列表自动跟随滚动。

## 0.0.2

### Patch Changes

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 应用图标更换为新的蓝色机器人标识。

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 侧边栏顶部的品牌标识更换为新的机器人形象，眨眼和左右看的动效保留。

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 系统状态栏图标改为单色剪影，自动适配浅色和深色菜单栏。

- [#17](https://github.com/MoonshotAI/kimi-code-app/pull/17) [`993afae`](https://github.com/MoonshotAI/kimi-code-app/commit/993afaeab2a96bfb70bfd5aeaf87cad7002d1351) Thanks [@liruifengv](https://github.com/liruifengv)! - 新增系统托盘常驻图标，点击托盘图标弹出菜单，可显示主窗口或退出应用。

## 0.0.1

### Patch Changes

- [#13](https://github.com/MoonshotAI/kimi-code-app/pull/13) [`810eeeb`](https://github.com/MoonshotAI/kimi-code-app/commit/810eeebc1ec8ad5d9b934309d789f905570d43b6) Thanks [@chengluyu](https://github.com/chengluyu)! - 聊天输入框关闭浏览器自动填充和拼写检查，输入时不再出现自动填充建议和拼写红线。

- [#2](https://github.com/MoonshotAI/kimi-code-app/pull/2) [`29cf4a6`](https://github.com/MoonshotAI/kimi-code-app/commit/29cf4a6af5bd16d102db2343c71a052e5e00e3e4) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复暗色主题下行内代码看不清的问题，正文文字提亮，侧边栏配色更沉稳。

- [#12](https://github.com/MoonshotAI/kimi-code-app/pull/12) [`e683222`](https://github.com/MoonshotAI/kimi-code-app/commit/e68322298ef432825c899a4e1d8b6fffd4855f2b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复同一文件夹因路径写法不同（大小写、斜杠差异）而重复显示为多个工作空间的问题。

- [#8](https://github.com/MoonshotAI/kimi-code-app/pull/8) [`7eb005f`](https://github.com/MoonshotAI/kimi-code-app/commit/7eb005fed49a18bf26262defb78160c5c60e66b2) Thanks [@liruifengv](https://github.com/liruifengv)! - 新建对话的空页面现在会展示 Kimi 复古电脑动画，并随明暗主题自动变色。

- [#14](https://github.com/MoonshotAI/kimi-code-app/pull/14) [`62609d2`](https://github.com/MoonshotAI/kimi-code-app/commit/62609d214afc05472ae51d8e7863db846e73e196) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复新建会话等待页顶部无法拖拽窗口的问题。

- [#14](https://github.com/MoonshotAI/kimi-code-app/pull/14) [`62609d2`](https://github.com/MoonshotAI/kimi-code-app/commit/62609d214afc05472ae51d8e7863db846e73e196) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复窗口左上角红绿灯与侧栏开关按钮的对齐问题：红绿灯垂直位置偏低，按钮与红绿灯间距过近。

- [#12](https://github.com/MoonshotAI/kimi-code-app/pull/12) [`e683222`](https://github.com/MoonshotAI/kimi-code-app/commit/e68322298ef432825c899a4e1d8b6fffd4855f2b) Thanks [@liruifengv](https://github.com/liruifengv)! - 工作空间列表和添加工作空间的目录选择中不再显示 git 分支信息。

- [#7](https://github.com/MoonshotAI/kimi-code-app/pull/7) [`be9ccd9`](https://github.com/MoonshotAI/kimi-code-app/commit/be9ccd9ec8522ae5bb9994c87ea438ceb9529695) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复会话列表在回答过程中随每一步频繁跳动重排的问题。
