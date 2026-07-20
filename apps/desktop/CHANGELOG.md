# kimi-code-app

## 0.0.6

### Patch Changes

- [#46](https://github.com/MoonshotAI/kimi-code-app/pull/46) [`7ac176f`](https://github.com/MoonshotAI/kimi-code-app/commit/7ac176f9a9ff71821b637d23e53e932874db63bc) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置的高级页新增应用版本与构建时间展示和手动检查更新按钮，并将页面选项整理为版本与更新、数据与隐私、诊断三组。

- [#42](https://github.com/MoonshotAI/kimi-code-app/pull/42) [`177c68c`](https://github.com/MoonshotAI/kimi-code-app/commit/177c68c90effc14aa13d8c4462c6c4fdc2058f55) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复发送首条消息进入消息流、以及切换到其它会话后，输入框不会自动聚焦的问题。

- [#41](https://github.com/MoonshotAI/kimi-code-app/pull/41) [`7d7365d`](https://github.com/MoonshotAI/kimi-code-app/commit/7d7365dd439577b6dbf380e7df40673c08e4dd05) Thanks [@liruifengv](https://github.com/liruifengv)! - 窗口标题与应用内各处的品牌名统一为「Kimi Code」。

- [#46](https://github.com/MoonshotAI/kimi-code-app/pull/46) [`7ac176f`](https://github.com/MoonshotAI/kimi-code-app/commit/7ac176f9a9ff71821b637d23e53e932874db63bc) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复设置里服务端版本错误显示为应用版本的问题，现在正确显示内嵌核心引擎的版本。

- [#37](https://github.com/MoonshotAI/kimi-code-app/pull/37) [`7c90df8`](https://github.com/MoonshotAI/kimi-code-app/commit/7c90df89815e0c56fc0cfbc2eec830cb1ffb347f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复对话中读取视频文件后播放器黑屏、无法预览内容的问题。

- [#40](https://github.com/MoonshotAI/kimi-code-app/pull/40) [`a2c4ed8`](https://github.com/MoonshotAI/kimi-code-app/commit/a2c4ed86225bd3bdcf5706f21e7a6dc337bd73ba) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复系统提醒注入把回合切断、导致连续活动被折成多行的问题，现在一整段活动正常折成一行。

- [#40](https://github.com/MoonshotAI/kimi-code-app/pull/40) [`a2c4ed8`](https://github.com/MoonshotAI/kimi-code-app/commit/a2c4ed86225bd3bdcf5706f21e7a6dc337bd73ba) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复进行中的摘要会把还在运行的工具提前计入「已完成」统计的问题。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 使用 API Key 接入 Kimi 编程模型时，会自动获取最新的模型列表。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 模型选择菜单新增提示：切换模型或思考强度会使已有的提示词缓存失效，建议新建对话以避免额外 token 消耗。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修正自动与 YOLO 权限模式的说明文案，与其实际行为一致。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复排队待发的消息被自动补发时可能携带过期附件的问题。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 思考强度改为按会话生效：每个会话保持自己的设置，切换会话或模型时互不影响。

- [#36](https://github.com/MoonshotAI/kimi-code-app/pull/36) [`58636df`](https://github.com/MoonshotAI/kimi-code-app/commit/58636dffa767ae386b7757fa6ba769c30fc5ae88) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 侧边栏多个会话同时运行时，加载动画现在保持同步转动。

- [#47](https://github.com/MoonshotAI/kimi-code-app/pull/47) [`e48bbf5`](https://github.com/MoonshotAI/kimi-code-app/commit/e48bbf5e01f2e1fb6e3d35bd11c7c5267a9ef3b3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复在符号链接目录下的问题：AGENTS.md 无法生效、文件状态读取失败。

- [#39](https://github.com/MoonshotAI/kimi-code-app/pull/39) [`7b7ff5f`](https://github.com/MoonshotAI/kimi-code-app/commit/7b7ff5f1433b8f9bec60e69f8d34f74b8dd95050) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Mac 菜单栏图标旁现在会显示未读、待审批和待回答的总数，点开托盘菜单可按会话逐条查看并直接跳转到对应会话，菜单语言跟随应用语言设置。

- [#40](https://github.com/MoonshotAI/kimi-code-app/pull/40) [`a2c4ed8`](https://github.com/MoonshotAI/kimi-code-app/commit/a2c4ed86225bd3bdcf5706f21e7a6dc337bd73ba) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 连续的思考与工具调用自动折叠成一行摘要（如「读取了 2 个文件 · 运行了 5 条命令 · 26.8s」），进行中实时展开直播、结束后自动收起，消息流更安静。

- [#35](https://github.com/MoonshotAI/kimi-code-app/pull/35) [`aeb9384`](https://github.com/MoonshotAI/kimi-code-app/commit/aeb93843770d2d0f563015d99e342cb3c0bd3c89) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 聊天中的宽表格默认保持在正文列宽内展示，被截断时右缘有渐隐提示，鼠标悬停后点右上角的按钮即可加宽，再点一次恢复。

## 0.0.5

### Patch Changes

- [#16](https://github.com/MoonshotAI/kimi-code-app/pull/16) [`004f2c1`](https://github.com/MoonshotAI/kimi-code-app/commit/004f2c18dd9710ac8818561fd6c3872265eb1c65) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复滚动时聊天消息从输入框下方透出来的问题。

- [#9](https://github.com/MoonshotAI/kimi-code-app/pull/9) [`05de3b8`](https://github.com/MoonshotAI/kimi-code-app/commit/05de3b843cc905506d948b8fafda5fc37ccca555) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复代码差异文件列表中，以点开头的隐藏文件路径标点位置错乱的问题。

- [#32](https://github.com/MoonshotAI/kimi-code-app/pull/32) [`7ca7c46`](https://github.com/MoonshotAI/kimi-code-app/commit/7ca7c463d783c66680c8bd776ec71339b005c1ab) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复深色主题搭配黑色主题色时，主要按钮白底白字看不清的问题。

- [#33](https://github.com/MoonshotAI/kimi-code-app/pull/33) [`920c389`](https://github.com/MoonshotAI/kimi-code-app/commit/920c389ecca712550eeeff593cc97836455d2100) Thanks [@chengluyu](https://github.com/chengluyu)! - 「打开方式」菜单新增 kitty 终端，可直接用它打开当前工作目录。

- [#33](https://github.com/MoonshotAI/kimi-code-app/pull/33) [`920c389`](https://github.com/MoonshotAI/kimi-code-app/commit/920c389ecca712550eeeff593cc97836455d2100) Thanks [@chengluyu](https://github.com/chengluyu)! - 「打开方式」菜单新增 VS Code Insiders，可直接用它打开当前工作目录。

- [#34](https://github.com/MoonshotAI/kimi-code-app/pull/34) [`f653b6b`](https://github.com/MoonshotAI/kimi-code-app/commit/f653b6bd248b1c93261212a3e0bcfb7789d17f4f) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计会话中的工具调用展示：每种工具都有贴合内容的专属样式，同种工具的连续调用合并为一句自然语言摘要（如“读取了 3 个文件”）并在完成后自动收起，子代理以独立卡片呈现、点击直达详情面板。

- [#32](https://github.com/MoonshotAI/kimi-code-app/pull/32) [`7ca7c46`](https://github.com/MoonshotAI/kimi-code-app/commit/7ca7c463d783c66680c8bd776ec71339b005c1ab) Thanks [@liruifengv](https://github.com/liruifengv)! - 重新设计审批与提问卡片：白色浮起圆角卡片，标题改为更大的深色纯文字；操作按钮按 1-4 从左到右排列，数字直接标在按钮上，主要操作是主题蓝实心按钮；写文件审批显示语法高亮的内容预览，编辑文件审批显示语法高亮的行级 diff，内容较多时默认 24 行内滚动、可一键放大撑满阅读；plan 的方案选项固定在计划正文下方（描述固定第二行完整显示），不会被长文淹没，还可以一键放大阅读全文；plan 文件路径渲染成链接，点击在右侧栏预览计划内容；卡片收起后点击整条即可展开；提问卡的标题就是问题本身，新增关闭按钮，选项支持 ↑↓ 方向键选择、空格勾选（多选）、Enter 确认；运行危险命令（如 rm -rf、sudo、强推）时审批卡片会显示危险提示。

- [#30](https://github.com/MoonshotAI/kimi-code-app/pull/30) [`8d0a46e`](https://github.com/MoonshotAI/kimi-code-app/commit/8d0a46e6e13bbb4e4ffba9826634749d93dc3b91) Thanks [@liruifengv](https://github.com/liruifengv)! - 读取、编辑和写入文件工具的卡片展开后显示代码内容，并按文件类型语法高亮；读取结果带真实行号。

## 0.0.4

### Patch Changes

- [#27](https://github.com/MoonshotAI/kimi-code-app/pull/27) [`c1caec3`](https://github.com/MoonshotAI/kimi-code-app/commit/c1caec399d6feef4d4f4a6d69b12605d76757e80) Thanks [@liruifengv](https://github.com/liruifengv)! - 思考过程改为在对话中内联折叠展示，流式时显示"思考中"状态和计秒，点击即可展开查看全文，思考完成后自动收起并显示用时，不再打开右侧面板。

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
