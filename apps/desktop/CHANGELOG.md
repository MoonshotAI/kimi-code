# kimi-code-app

## 0.0.12

### Patch Changes

- [#138](https://github.com/MoonshotAI/kimi-code-app/pull/138) [`1825bec`](https://github.com/MoonshotAI/kimi-code-app/commit/1825bec3ed322da312b51361d605c896c3c0331b) - 会话图标选择器新增聊天气泡、警灯、工具箱等 20 个常用 emoji，均可按中英文关键词搜索。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 附件过多时输入框的附件列表限高滚动：新增附件自动滚动到可见位置，并显示附件总数。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 输入框中的附件支持一键清空。

- [#128](https://github.com/MoonshotAI/kimi-code-app/pull/128) [`949f00f`](https://github.com/MoonshotAI/kimi-code-app/commit/949f00fdb470a44908d27bb5f6c0802b278686f0) - 移除了内置服务器的访问令牌校验，启动时不再可能弹出要求输入服务器密码的对话框。

- [#132](https://github.com/MoonshotAI/kimi-code-app/pull/132) [`9a5e75b`](https://github.com/MoonshotAI/kimi-code-app/commit/9a5e75ba3d54687048e58d8b151a1a04e24cd15a) - 新增内置终端。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 修复附件预览右上角关闭按钮点不动的问题，预览支持按 Esc 关闭。

- [#130](https://github.com/MoonshotAI/kimi-code-app/pull/130) [`170784e`](https://github.com/MoonshotAI/kimi-code-app/commit/170784e30b9b3f829cb1b2ba51be138f889df7b9) - 修复查找栏当前匹配项的高亮描边偏移、不能完整包裹高亮区域的问题。

- [#135](https://github.com/MoonshotAI/kimi-code-app/pull/135) [`266a14d`](https://github.com/MoonshotAI/kimi-code-app/commit/266a14d449e1274a6326fc259eac94426fcbadb2) - 修复排队中的长消息显示为空白气泡的问题。

- [#136](https://github.com/MoonshotAI/kimi-code-app/pull/136) [`7feb33b`](https://github.com/MoonshotAI/kimi-code-app/commit/7feb33b6d4779f588019405697e34964508d0475) - 修复 Windows 任务栏错误显示 Electron 图标和名称的问题。

- [#113](https://github.com/MoonshotAI/kimi-code-app/pull/113) [`10f5f88`](https://github.com/MoonshotAI/kimi-code-app/commit/10f5f88fc4592ddd13592c48eefaea4027cddbdf) - 修复行内数学公式（$…$）无法渲染的问题。

- [#126](https://github.com/MoonshotAI/kimi-code-app/pull/126) [`b05e7a3`](https://github.com/MoonshotAI/kimi-code-app/commit/b05e7a3b3fd5a1e5c73c90c9b39bdcc0fde65fff) - 修复置顶会话行上状态徽章的提示和整行提示会同时弹出的问题。

- [#144](https://github.com/MoonshotAI/kimi-code-app/pull/144) [`7a1fd22`](https://github.com/MoonshotAI/kimi-code-app/commit/7a1fd229fd410ace774921276013a3d4a35ee0d8) - 图片附件预览改为从缩略图位置平滑放大打开，支持滚轮缩放查看细节。

- [#137](https://github.com/MoonshotAI/kimi-code-app/pull/137) [`d434457`](https://github.com/MoonshotAI/kimi-code-app/commit/d434457110402b5a24abd0bb905f5414ba4e6d35) - 修复子 Agent 详情中的操作卡顿、错误跳转、通知及运行状态显示问题。

- [#136](https://github.com/MoonshotAI/kimi-code-app/pull/136) [`7feb33b`](https://github.com/MoonshotAI/kimi-code-app/commit/7feb33b6d4779f588019405697e34964508d0475) - 将托盘菜单入口更名为“打开 Kimi Code”。

- [#127](https://github.com/MoonshotAI/kimi-code-app/pull/127) [`2a60c73`](https://github.com/MoonshotAI/kimi-code-app/commit/2a60c735485d900f7211a8d5a3466e71e0a5414c) - 历史会话中的计划现在会显示完整正文、评审状态、所选方案和反馈。

- [#137](https://github.com/MoonshotAI/kimi-code-app/pull/137) [`d434457`](https://github.com/MoonshotAI/kimi-code-app/commit/d434457110402b5a24abd0bb905f5414ba4e6d35) - 子 Agent 和 Swarm 详情支持按需恢复完整消息流，并减少流式更新时的卡顿。

- [#126](https://github.com/MoonshotAI/kimi-code-app/pull/126) [`b05e7a3`](https://github.com/MoonshotAI/kimi-code-app/commit/b05e7a3b3fd5a1e5c73c90c9b39bdcc0fde65fff) - 修复鼠标悬停在带状态徽章的会话行时标题被遮住一截的问题。

- [#137](https://github.com/MoonshotAI/kimi-code-app/pull/137) [`d434457`](https://github.com/MoonshotAI/kimi-code-app/commit/d434457110402b5a24abd0bb905f5414ba4e6d35) - 修复打开子 Agent 详情面板时页面卡顿的问题。

- [#140](https://github.com/MoonshotAI/kimi-code-app/pull/140) [`484ad78`](https://github.com/MoonshotAI/kimi-code-app/commit/484ad78c83e34aa98035d3b85d903ff41e1965a0) - 重构用量显示逻辑

- [#143](https://github.com/MoonshotAI/kimi-code-app/pull/143) [`57037ca`](https://github.com/MoonshotAI/kimi-code-app/commit/57037cac8bc03b6652ef7a8be97fd3763bc7f71b) - 修复鼠标快速划过对话目录时目录闪烁展开的问题。

- [#101](https://github.com/MoonshotAI/kimi-code-app/pull/101) [`7d96d40`](https://github.com/MoonshotAI/kimi-code-app/commit/7d96d40cfb81cd25f88a0fe4050d9193bc8ff86e) - 对话每轮回复结束后展示本轮修改的文件汇总，可展开查看每个文件的增删行数。

- [#142](https://github.com/MoonshotAI/kimi-code-app/pull/142) [`28c2780`](https://github.com/MoonshotAI/kimi-code-app/commit/28c2780188a3224573756913ddb68665e9ee3b88) - 统一输入框与已发送消息中附件的样式：图片和视频显示为缩略图、文件显示为胶囊，待发送附件列表收进输入框内。

- [#141](https://github.com/MoonshotAI/kimi-code-app/pull/141) [`56a37f6`](https://github.com/MoonshotAI/kimi-code-app/commit/56a37f6e51b63b91232577bb22b6504d74ea7a58) - 统一界面中文件与工具调用数量的数字显示。

- [#139](https://github.com/MoonshotAI/kimi-code-app/pull/139) [`7538b76`](https://github.com/MoonshotAI/kimi-code-app/commit/7538b7627bd1744ef92764b4cfc3ecb996f653b5) - 优化下载更新弹窗

- [`a8eef0e`](https://github.com/MoonshotAI/kimi-code-app/commit/a8eef0eda2f260dc2b2f1e05b7b65ec3bdecd578) - 更新弹窗加宽，更新内容较多时改为在内容区内滚动，不再把弹窗撑得很长。

## 0.0.11

### Patch Changes

- [#112](https://github.com/MoonshotAI/kimi-code-app/pull/112) [`9abb793`](https://github.com/MoonshotAI/kimi-code-app/commit/9abb79383e310d9feb153f378c77a3a30e6f244f) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复其他会话在后台运行任务时，当前会话也跟着变卡的问题。

- [#123](https://github.com/MoonshotAI/kimi-code-app/pull/123) [`8140820`](https://github.com/MoonshotAI/kimi-code-app/commit/8140820d5958044b2b80233da45d948db6814a84) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复 Windows 桌面快捷方式图标显示偏小的问题。

- [#123](https://github.com/MoonshotAI/kimi-code-app/pull/123) [`8140820`](https://github.com/MoonshotAI/kimi-code-app/commit/8140820d5958044b2b80233da45d948db6814a84) Thanks [@liruifengv](https://github.com/liruifengv)! - Windows 桌面端采用与应用界面一致的自定义标题栏和菜单栏。

- [#120](https://github.com/MoonshotAI/kimi-code-app/pull/120) [`15d9f7e`](https://github.com/MoonshotAI/kimi-code-app/commit/15d9f7ef526d7062434eac15390fc01930cccb7e) Thanks [@chengluyu](https://github.com/chengluyu)! - 收紧输入框「权限」与「模式」按钮及下拉菜单的文字排版：按钮与选项名称字号调小，菜单描述字重减轻、行高收紧。

- [#125](https://github.com/MoonshotAI/kimi-code-app/pull/125) [`e64c302`](https://github.com/MoonshotAI/kimi-code-app/commit/e64c3027328bf62f25d79caff5c9620847b6bfb8) Thanks [@liruifengv](https://github.com/liruifengv)! - 助手自我介绍改为 Kimi Code 桌面端身份，回复排版指引适配桌面聊天界面。

- [#118](https://github.com/MoonshotAI/kimi-code-app/pull/118) [`fab5444`](https://github.com/MoonshotAI/kimi-code-app/commit/fab54442863fe3de96875ebe730a2fe2b0d02481) Thanks [@liruifengv](https://github.com/liruifengv)! - 「帮助」菜单新增「性能录制」。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复新建的空文件在改动面板中被误报为“没有行级改动”的问题。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 改动面板的代码差异视图支持语法高亮，代码字号调整为比正文小一号。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复文件预览的代码字号与改动视图不一致的问题。

- [#111](https://github.com/MoonshotAI/kimi-code-app/pull/111) [`934f3c8`](https://github.com/MoonshotAI/kimi-code-app/commit/934f3c8a6fc5241b1175dc669f1b014754696b4e) Thanks [@chengluyu](https://github.com/chengluyu)! - 文件预览的代码内容支持完整语法高亮，与改动视图一致。

- [#102](https://github.com/MoonshotAI/kimi-code-app/pull/102) [`66a6db6`](https://github.com/MoonshotAI/kimi-code-app/commit/66a6db69bdd205fd0af2d7c1422a027b7276c2ad) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复消息中的待办列表（`- [ ]`）同时显示圆点和复选框的问题。

- [#102](https://github.com/MoonshotAI/kimi-code-app/pull/102) [`66a6db6`](https://github.com/MoonshotAI/kimi-code-app/commit/66a6db69bdd205fd0af2d7c1422a027b7276c2ad) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复关闭毛玻璃侧栏后启动时仍会闪一下毛玻璃的问题。

- [#121](https://github.com/MoonshotAI/kimi-code-app/pull/121) [`51017fe`](https://github.com/MoonshotAI/kimi-code-app/commit/51017fec5f0c6fbf3465dc9c75fc3793923a4c18) Thanks [@chengluyu](https://github.com/chengluyu)! - 所有弹出菜单改为毛玻璃质感。

- [#107](https://github.com/MoonshotAI/kimi-code-app/pull/107) [`7b361d4`](https://github.com/MoonshotAI/kimi-code-app/commit/7b361d427a07fc411cfbe994c7e9968a1b5f0334) Thanks [@liruifengv](https://github.com/liruifengv)! - 输入框内容较多时不再显示右侧滚动条。

- [#122](https://github.com/MoonshotAI/kimi-code-app/pull/122) [`44e36e1`](https://github.com/MoonshotAI/kimi-code-app/commit/44e36e11b0b3b351b1c6a9fce9268e3ff068bfd1) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 不足 1 秒的耗时不再显示 <1s 字样。

- [#129](https://github.com/MoonshotAI/kimi-code-app/pull/129) [`d6b75e6`](https://github.com/MoonshotAI/kimi-code-app/commit/d6b75e6ce63152b290701c6db8424a414428f2be) Thanks [@liruifengv](https://github.com/liruifengv)! - 补充本地化文案。

- [#116](https://github.com/MoonshotAI/kimi-code-app/pull/116) [`41970aa`](https://github.com/MoonshotAI/kimi-code-app/commit/41970aa2276c25f82b1056d40214ed8ee9637ecd) Thanks [@liruifengv](https://github.com/liruifengv)! - 消息发送后的加载动画从月亮换成小蓝，并随阶段显示「请求中…」「工作中…」文案。

- [#114](https://github.com/MoonshotAI/kimi-code-app/pull/114) [`ac59b69`](https://github.com/MoonshotAI/kimi-code-app/commit/ac59b699a0c680682a684142bc149c49c1f9e9c8) Thanks [@chengluyu](https://github.com/chengluyu)! - 文本输入框（搜索框、输入区、重命名等）支持系统原生右键菜单：macOS 上有查找（Look Up）、撤销、重做、剪切、拷贝、粘贴、全选。

- [#129](https://github.com/MoonshotAI/kimi-code-app/pull/129) [`d6b75e6`](https://github.com/MoonshotAI/kimi-code-app/commit/d6b75e6ce63152b290701c6db8424a414428f2be) Thanks [@liruifengv](https://github.com/liruifengv)! - 「新建对话」统一更名为「新建会话」（英文界面为 New Session）。

- [#120](https://github.com/MoonshotAI/kimi-code-app/pull/120) [`15d9f7e`](https://github.com/MoonshotAI/kimi-code-app/commit/15d9f7ef526d7062434eac15390fc01930cccb7e) Thanks [@chengluyu](https://github.com/chengluyu)! - 修正「逐条确认」权限在下拉菜单中颜色偏淡的问题，与其他菜单项颜色一致。

- [#120](https://github.com/MoonshotAI/kimi-code-app/pull/120) [`15d9f7e`](https://github.com/MoonshotAI/kimi-code-app/commit/15d9f7ef526d7062434eac15390fc01930cccb7e) Thanks [@chengluyu](https://github.com/chengluyu)! - 权限模式增加专属图标，逐条确认、自动通过、完全自主在输入框工具栏和下拉菜单中都有对应图标。

- [#115](https://github.com/MoonshotAI/kimi-code-app/pull/115) [`f1179ac`](https://github.com/MoonshotAI/kimi-code-app/commit/f1179acec210d38c1e9d243c98d1ebcba29dc3e5) Thanks [@liruifengv](https://github.com/liruifengv)! - 移除桌面宠物「小蓝」（View 菜单里的 Kimi Pet 开关与桌面浮窗）。

- [#124](https://github.com/MoonshotAI/kimi-code-app/pull/124) [`6e6b539`](https://github.com/MoonshotAI/kimi-code-app/commit/6e6b5391ffb4c6d3016eb861a99171c5d8ab8908) Thanks [@chengluyu](https://github.com/chengluyu)! - 添加附件、置顶和取消置顶按钮恢复旧版图标样式。

- [#104](https://github.com/MoonshotAI/kimi-code-app/pull/104) [`41cc40a`](https://github.com/MoonshotAI/kimi-code-app/commit/41cc40a3b068e4d77e3b114a249f619c0ab81094) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复使用全选快捷键时会同时选中两侧边栏内容的问题。

- [#112](https://github.com/MoonshotAI/kimi-code-app/pull/112) [`9abb793`](https://github.com/MoonshotAI/kimi-code-app/commit/9abb79383e310d9feb153f378c77a3a30e6f244f) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复切换会话时对话界面先闪现顶部消息再滚动到底部的问题。

- [#117](https://github.com/MoonshotAI/kimi-code-app/pull/117) [`d4e51b2`](https://github.com/MoonshotAI/kimi-code-app/commit/d4e51b29319f084205b840f8904e6d6914cb19f3) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复从访达/Dock 启动时读取不到本机终端环境（如 gh、rclone 等命令行工具）的问题。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复 Windows 重复启动应用时打开多个实例的问题。

- [#112](https://github.com/MoonshotAI/kimi-code-app/pull/112) [`9abb793`](https://github.com/MoonshotAI/kimi-code-app/commit/9abb79383e310d9feb153f378c77a3a30e6f244f) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复长时间运行的会话输出越多越卡的问题。

- [#107](https://github.com/MoonshotAI/kimi-code-app/pull/107) [`7b361d4`](https://github.com/MoonshotAI/kimi-code-app/commit/7b361d427a07fc411cfbe994c7e9968a1b5f0334) Thanks [@liruifengv](https://github.com/liruifengv)! - 开始新会话前的输入框加高到三行。

- [#114](https://github.com/MoonshotAI/kimi-code-app/pull/114) [`ac59b69`](https://github.com/MoonshotAI/kimi-code-app/commit/ac59b699a0c680682a684142bc149c49c1f9e9c8) Thanks [@chengluyu](https://github.com/chengluyu)! - 新增对话内容搜索：按 Cmd+F（macOS）或 Ctrl+F 在对话右上角调出搜索框，显示匹配数量并支持上/下一条跳转定位。

- [#123](https://github.com/MoonshotAI/kimi-code-app/pull/123) [`8140820`](https://github.com/MoonshotAI/kimi-code-app/commit/8140820d5958044b2b80233da45d948db6814a84) Thanks [@liruifengv](https://github.com/liruifengv)! - Windows 标题栏图标随主题切换，并为托盘使用白底品牌图标。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - Windows 任务栏右键菜单支持新建会话和打开最近工作区。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 「用其他应用打开」支持 Windows。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复 Windows 下的通知功能。

- [#110](https://github.com/MoonshotAI/kimi-code-app/pull/110) [`c13cef5`](https://github.com/MoonshotAI/kimi-code-app/commit/c13cef5811c368f2b8018484cd38ba2cdb58065a) Thanks [@liruifengv](https://github.com/liruifengv)! - 优化 Windows 托盘功能。

## 0.0.10

### Patch Changes

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 新建文件夹按钮的图标换成 Kimi 动画版：悬停时加号旋转跳动一次。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 新建聊天图标换上悬停动画版本：鼠标移入时加号会旋转跳动一次（侧栏与折叠态快捷按钮均生效）。

- [#92](https://github.com/MoonshotAI/kimi-code-app/pull/92) [`4de4c9c`](https://github.com/MoonshotAI/kimi-code-app/commit/4de4c9c0ffe3f46f4dd9859216e66c0851026428) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置里新增应用图标选项，程序坞图标可固定为浅色、深色或跟随系统自动切换。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 归档图标换新为 Kimi 设计系统图标。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 会话菜单里的「归档」不再使用红色警示样式，避免误以为归档会删除会话。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持在后台自动下载新版本，下载完成后从侧边栏的更新入口重启即可更新；可在设置 → 高级中开启。

- [#86](https://github.com/MoonshotAI/kimi-code-app/pull/86) [`991b34b`](https://github.com/MoonshotAI/kimi-code-app/commit/991b34bdc5d8532c04f34bac98e7d4e8a27a04ac) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 过长的用户消息默认折叠为渐隐预览，点击可展开或收起。

- [#98](https://github.com/MoonshotAI/kimi-code-app/pull/98) [`9d462ec`](https://github.com/MoonshotAI/kimi-code-app/commit/9d462ecb8bcbbb6f81803c7e7e301f454e686e4c) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 排队中的长消息也会折叠为渐隐预览，点击可展开或收起。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - Swarm 与 Goal 的确认弹窗补上规范标题，说明文字移至正文，与其他确认弹窗一致。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一「Copy session ID」在标题栏菜单与会话菜单中的大小写，两处文案一致。

- [#93](https://github.com/MoonshotAI/kimi-code-app/pull/93) [`c0fede2`](https://github.com/MoonshotAI/kimi-code-app/commit/c0fede246d68abf1f6e01eff943d4d06e4710aac) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置页新增供应商管理，支持手动添加、从模型目录或私有注册表导入第三方 API 供应商。

- [#92](https://github.com/MoonshotAI/kimi-code-app/pull/92) [`4de4c9c`](https://github.com/MoonshotAI/kimi-code-app/commit/4de4c9c0ffe3f46f4dd9859216e66c0851026428) Thanks [@chengluyu](https://github.com/chengluyu)! - macOS 深色模式下程序坞图标自动切换为深色样式，可在设置中直接预览并选择图标外观。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 深色模式图标换成带环形山的满月版本。

- [#106](https://github.com/MoonshotAI/kimi-code-app/pull/106) [`aec4ef0`](https://github.com/MoonshotAI/kimi-code-app/commit/aec4ef0e9f9a5f4daf9154bb44b410ec49f66db8) Thanks [@chengluyu](https://github.com/chengluyu)! - 放大输入框发送与停止按钮的图标，更加醒目。

- [#89](https://github.com/MoonshotAI/kimi-code-app/pull/89) [`bc5cf88`](https://github.com/MoonshotAI/kimi-code-app/commit/bc5cf8825956b5828609159205b752b0c86ad7dc) Thanks [@wbxl2000](https://github.com/wbxl2000)! - Esc 和输入框停止按钮只终止当前回复，不再一并停止后台任务（后台任务可从任务面板单独终止）。

- [#89](https://github.com/MoonshotAI/kimi-code-app/pull/89) [`bc5cf88`](https://github.com/MoonshotAI/kimi-code-app/commit/bc5cf8825956b5828609159205b752b0c86ad7dc) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 终止回复后再按一次 Esc 可撤销刚发出的消息并放回输入框，被终止的回复下方新增「已手动终止」分割线标记。

- [#88](https://github.com/MoonshotAI/kimi-code-app/pull/88) [`35ed68f`](https://github.com/MoonshotAI/kimi-code-app/commit/35ed68f1aa89a484c7be27a45659a08008fbc638) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复技能、MCP 等工具调用把「工作中」折叠打断的问题，待办、目标、子代理、提问等卡片在结束后也会一并折入。

- [#100](https://github.com/MoonshotAI/kimi-code-app/pull/100) [`02b134d`](https://github.com/MoonshotAI/kimi-code-app/commit/02b134de92d6c0df4dcb4deb6020ec32f7cb9bf8) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复发送消息后同一条用户消息偶尔显示两遍的问题。

- [#82](https://github.com/MoonshotAI/kimi-code-app/pull/82) [`7a3772b`](https://github.com/MoonshotAI/kimi-code-app/commit/7a3772b89e5dc2a5c013a8a2f6cb4b2b1fa848f9) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复窗口全屏时点击关闭按钮变成全黑屏幕的问题。

- [#106](https://github.com/MoonshotAI/kimi-code-app/pull/106) [`aec4ef0`](https://github.com/MoonshotAI/kimi-code-app/commit/aec4ef0e9f9a5f4daf9154bb44b410ec49f66db8) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复发送按钮底部被遮挡一点的问题。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - 字体大小设置改为「小 / 中 / 大 / 特大」四档，界面与消息文字随所选档位整体缩放。

- [#96](https://github.com/MoonshotAI/kimi-code-app/pull/96) [`11a593b`](https://github.com/MoonshotAI/kimi-code-app/commit/11a593b4b83efbf77e308d15f000a2c0077d92d0) Thanks [@wbxl2000](https://github.com/wbxl2000)! - goal 模式下自动续跑的轮次会在对话中标注「目标续跑」，方便分清每轮是谁发起的。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复斜杠菜单中 /goal 命令的描述只显示「resume」的问题，现在会展示完整的用法说明。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - Goal 目标图标换新为 Kimi 设计系统的准星图标。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 拖拽把手图标换新为 Kimi 设计系统图标。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 更多组件的悬停反馈统一为模式自适应洗色：下拉选择器选项、设置导航与字号步进、归档列表、按钮与 Pill、移动端列表项等，暗色下悬停不再压暗。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 界面图标大面积换新为 Kimi 设计系统图标：动作、箭头、文件、状态、置顶、侧栏开关等 40 余处视觉风格统一。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - 界面配色切换为 kimi.com 线上配色，状态颜色保持原有配色以保证文字对比度。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - macOS 版侧栏换用原生毛玻璃材质，视力敏感的用户可在设置中关闭。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 修正弹出菜单的悬停反馈：暗色下背景改为提亮而非压暗，菜单图标默认降一档显示、悬停时与标签同步提亮。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 单行动作菜单的标签字号由 12px 提升为 13px，更易读。

- [#92](https://github.com/MoonshotAI/kimi-code-app/pull/92) [`4de4c9c`](https://github.com/MoonshotAI/kimi-code-app/commit/4de4c9c0ffe3f46f4dd9859216e66c0851026428) Thanks [@chengluyu](https://github.com/chengluyu)! - 更新应用图标为新版品牌标识，包括系统托盘与界面内的品牌标志。

- [#85](https://github.com/MoonshotAI/kimi-code-app/pull/85) [`d976662`](https://github.com/MoonshotAI/kimi-code-app/commit/d976662a0cfc607e735cc43cd40316c07c79f755) Thanks [@liruifengv](https://github.com/liruifengv)! - 登录界面暂时下线「输入设备码」的备用登录方式（该路径存在问题），保留浏览器一键授权，并新增完整授权链接的复制入口，修复后会恢复。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 权限模式指示换上表意图标：手动审批为手掌、YOLO 为警告标志、全自动为机器人。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一各界面权限模式的顺序为「逐条确认 → 自动通过 → 完全自主」，颜色警示也随之统一：完全自主始终是最高的红色警示级别。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 播放 / 暂停图标换新为 Kimi 设计系统图标（修复暂停图标发灰的问题）。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复发送按钮悬停没有过渡动画的问题。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮的悬停渐变更清晰可感（时长与幅度上调）。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮在输入为空时显示禁用态；启用态改用深灰（反转）填充而非主题色。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮的颜色与禁用态变化加入过渡动画，不再瞬变。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 发送按钮的禁用/启用切换过渡更平滑（时长上调至 260ms）。

- [#85](https://github.com/MoonshotAI/kimi-code-app/pull/85) [`d976662`](https://github.com/MoonshotAI/kimi-code-app/commit/d976662a0cfc607e735cc43cd40316c07c79f755) Thanks [@liruifengv](https://github.com/liruifengv)! - 未登录时点击发送会弹出登录引导，输入框下方的模型位置改为登录入口，点击直接弹出登录窗口。没有工作空间时点击发送会先提示选择工作空间，不再直接弹出目录选择器，取消操作会保留已输入的内容。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一英文界面按钮与菜单文案的大小写规范：New Chat 改为 New chat，外观选项 Moon Bright / Moon Dark 改为 Moon bright / Moon dark。

- [#97](https://github.com/MoonshotAI/kimi-code-app/pull/97) [`a818544`](https://github.com/MoonshotAI/kimi-code-app/commit/a818544df0453a8a935c1fa033eaa35ea07000bc) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 支持为会话设置 Emoji 图标（选择器可搜索、显示最近使用），在会话选项菜单选择「设置 Emoji…」或点击标题前的 Emoji 即可使用。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置导航的 Advanced 图标换为 Kimi 显微镜图标。

- [#84](https://github.com/MoonshotAI/kimi-code-app/pull/84) [`add8d70`](https://github.com/MoonshotAI/kimi-code-app/commit/add8d70410354d29826d666e5eee52cb77031f60) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置导航中的「Keyboard Shortcuts」更名为「Hotkeys」（中文为「快捷键」），标签不再折行。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置导航图标更新：General 换为列表带圆点的滑杆图标，Agent 换为机器人图标。

- [#103](https://github.com/MoonshotAI/kimi-code-app/pull/103) [`2529693`](https://github.com/MoonshotAI/kimi-code-app/commit/25296933069fce9d3f508bbeffd027bdbdcd2ec4) Thanks [@chengluyu](https://github.com/chengluyu)! - 侧边栏「新建会话」和「搜索」的快捷键提示改为鼠标悬停时才显示。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 侧栏开关换上 Kimi 左侧栏图标：悬停时箭头飞入并停留在图标中，不再按开合状态切换图形。

- [#106](https://github.com/MoonshotAI/kimi-code-app/pull/106) [`aec4ef0`](https://github.com/MoonshotAI/kimi-code-app/commit/aec4ef0e9f9a5f4daf9154bb44b410ec49f66db8) Thanks [@chengluyu](https://github.com/chengluyu)! - 停止输出按钮改用中性灰底色并去掉红色边框。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - Swarm 模式及子任务工具调用的图标换为 Kimi 任务网络图标。

- [#94](https://github.com/MoonshotAI/kimi-code-app/pull/94) [`e445851`](https://github.com/MoonshotAI/kimi-code-app/commit/e4458519a63f5fb0ddb35948b3be9a555830a87b) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 后台任务完成、失败或超时时，对话里会显示对应的通知卡片，可展开查看详情和输出文件路径。

- [#90](https://github.com/MoonshotAI/kimi-code-app/pull/90) [`43624a3`](https://github.com/MoonshotAI/kimi-code-app/commit/43624a3ea1dea64ce2b732fe5ae0dba22112799a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置中的浅色 / 深色主题切换选项加上对应图标。

- [#105](https://github.com/MoonshotAI/kimi-code-app/pull/105) [`a9d175f`](https://github.com/MoonshotAI/kimi-code-app/commit/a9d175fd117eba180bd71217b3a9abe71e4efc5b) Thanks [@chengluyu](https://github.com/chengluyu)! - 模型选择下拉中的 thinking 分组标签改为首字母大写的 Thinking，与界面其他位置保持一致。

- [#91](https://github.com/MoonshotAI/kimi-code-app/pull/91) [`17ef185`](https://github.com/MoonshotAI/kimi-code-app/commit/17ef185e03c5809e0ab600f15c462fcde3de20c3) Thanks [@OwenXu27](https://github.com/OwenXu27)! - 界面边框统一为更细的发丝线，列表选中态与消息气泡改为中性配色。

- [#95](https://github.com/MoonshotAI/kimi-code-app/pull/95) [`aeaae1c`](https://github.com/MoonshotAI/kimi-code-app/commit/aeaae1cdd9bf94eeadcc32b58f8d0925afe26f3f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 耗时显示不再出现小数秒和原始毫秒，整分钟、整小时省略多余的零（如 6m0s 显示为 6m）。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 更新弹窗增加「以后自动下载并安装更新」勾选项，下载过程中可切换为后台下载。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 更新弹窗现在会显示新版本的中英双语更新说明。

- [#87](https://github.com/MoonshotAI/kimi-code-app/pull/87) [`3e9e1c3`](https://github.com/MoonshotAI/kimi-code-app/commit/3e9e1c30ea441be3c0fc4a39009bb5185b0b7030) Thanks [@liruifengv](https://github.com/liruifengv)! - 更新弹窗的更新说明现在按新功能、优化、修复等小节分组展示。

## 0.0.9

### Patch Changes

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 设置弹窗的导航栏与内容区之间补上细分隔线，浅色模式下两侧不再难以区分。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 深色模式下设置页的下拉框、字号步进器等字段控件现在比卡片背景再浅一级，控件更清晰可辨。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - App 菜单移除「打开服务日志」项，并为「重试连接」项补充英文文案。

- [#77](https://github.com/MoonshotAI/kimi-code-app/pull/77) [`a24ac7b`](https://github.com/MoonshotAI/kimi-code-app/commit/a24ac7b644498b0becca002b881c525feda4e134) Thanks [@liruifengv](https://github.com/liruifengv)! - 回答提问后，转录中会以回执卡展示你选中的选项；跳过的问题显示为一行简洁的未作答记录。

- [#80](https://github.com/MoonshotAI/kimi-code-app/pull/80) [`44d5398`](https://github.com/MoonshotAI/kimi-code-app/commit/44d539830d304a0c61573d7fce000bcbede4ca7b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复流式输出中展开或收起思考、工具调用等内容时对话视图抖动的问题：展开或收起时当前行保持原位，内容离开底部后会显示「新消息」提示，收起后按位置自动恢复；展开正在输出中的思考或工具时会跟随输出继续滚动。修复写入、编辑工具展开的代码高亮在流式过程中持续闪烁的问题，以及已完成的思考块在其他内容流式时错误播放呼吸动画的问题。点击目录或「新消息」按钮的定位也更准确。等待回复的月亮动画保持恒定速度。

- [#78](https://github.com/MoonshotAI/kimi-code-app/pull/78) [`a3fab4d`](https://github.com/MoonshotAI/kimi-code-app/commit/a3fab4d9ed88f308993a9928819754bed2c481a8) Thanks [@chengluyu](https://github.com/chengluyu)! - 输入区域与上方任务胶囊采用更协调的圆角、尺寸与轻量焦点反馈，操作区域更整洁。

- [#55](https://github.com/MoonshotAI/kimi-code-app/pull/55) [`189e780`](https://github.com/MoonshotAI/kimi-code-app/commit/189e780091151cb65c2d2ce90b3c57031c8d6473) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 新会话页的工作区选择器改为附着在输入框卡片下方的浅灰卡片，输入框边框保持完整；选择面板按「最近的文件夹」分组展示，下方空间不足时自动向上展开。

- [#81](https://github.com/MoonshotAI/kimi-code-app/pull/81) [`fcbb4e8`](https://github.com/MoonshotAI/kimi-code-app/commit/fcbb4e83eba32e96ce7bc30c8062887f8be6ef02) Thanks [@liruifengv](https://github.com/liruifengv)! - 界面提示中的“daemon”统一改为“服务器”，空列表等场景改为直接提示暂无内容。

- [#77](https://github.com/MoonshotAI/kimi-code-app/pull/77) [`a24ac7b`](https://github.com/MoonshotAI/kimi-code-app/commit/a24ac7b644498b0becca002b881c525feda4e134) Thanks [@liruifengv](https://github.com/liruifengv)! - 计划、审批与提问卡片的视觉更收敛：圆角与阴影减小，提问选项的勾选标记改为与首行文字对齐，卡片操作按钮统一靠左，多步提问的「返回」更名为「上一题」，问题前的分类标签不再显示。计划内容滚动时，顶部会出现柔和的阴影分隔。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 桌面端窗口标题保持静态 Kimi Code，避免运行中的 spinner 符号进入 Dock 菜单。

- [#79](https://github.com/MoonshotAI/kimi-code-app/pull/79) [`e8024fb`](https://github.com/MoonshotAI/kimi-code-app/commit/e8024fb5f14b36f5dc9a1ff9e359c53df9bf6239) Thanks [@chengluyu](https://github.com/chengluyu)! - 拖拽面板宽度到极限时，光标会变为仅剩可拖方向的样式，提示更明确。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 桌面端 Dock 图标根据未读/待处理消息总数显示数字 badge。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复深色模式下差异视图的中性标记与空状态图标、文件预览的下载按钮悬停几乎不可见的问题。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复深色模式下界面层次颠倒的问题：代码块、工具输出、输入框等重要内容现在比侧边栏等界面元素更亮，主次更分明。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复在设置中退出登录后界面仍显示已登录的问题，现在退出后账号状态会立即刷新。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复设置页外观选项（Moon Bright / Moon Dark）在空间不足时文字折行、分段控件被撑高的问题。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复深色模式下设置弹窗的层次问题：设置分组现在比窗口背景浅一级，内容更突出。

- [#81](https://github.com/MoonshotAI/kimi-code-app/pull/81) [`fcbb4e8`](https://github.com/MoonshotAI/kimi-code-app/commit/fcbb4e83eba32e96ce7bc30c8062887f8be6ef02) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复部分模型上下文容量显示不准确的问题。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复首次启动引导在开发环境反复弹出的问题：引导完成状态改为主进程持久化存储，开发版与正式版共享，不再受 dev 端口变化影响。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 统一 onboarding 欢迎页品牌文案大小写为 Kimi Code。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 重做首次启动引导：语言与外观偏好、Kimi 账号登录合并为两步向导，未登录不再拦截主界面，之后可在设置中随时登录。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置页的账户区新增「套餐用量」，登录 Kimi 账号后可查看额度使用情况和加油包余额。

- [#81](https://github.com/MoonshotAI/kimi-code-app/pull/81) [`fcbb4e8`](https://github.com/MoonshotAI/kimi-code-app/commit/fcbb4e83eba32e96ce7bc30c8062887f8be6ef02) Thanks [@liruifengv](https://github.com/liruifengv)! - 发送消息时附带的视频现在会直接以视频形式传给模型，内容理解更准确。

- [#76](https://github.com/MoonshotAI/kimi-code-app/pull/76) [`14c197a`](https://github.com/MoonshotAI/kimi-code-app/commit/14c197ae20b32331e216b9a2876b0a699e5837d1) Thanks [@liruifengv](https://github.com/liruifengv)! - 在侧边栏设置入口旁添加「内部测试」标识。

- [#79](https://github.com/MoonshotAI/kimi-code-app/pull/79) [`e8024fb`](https://github.com/MoonshotAI/kimi-code-app/commit/e8024fb5f14b36f5dc9a1ff9e359c53df9bf6239) Thanks [@chengluyu](https://github.com/chengluyu)! - 拖拽调整左右侧面板宽度时更流畅，不再出现明显卡顿。

- [#74](https://github.com/MoonshotAI/kimi-code-app/pull/74) [`3adc4c5`](https://github.com/MoonshotAI/kimi-code-app/commit/3adc4c544f6294541cd9c9f09a28c1b29181ad7a) Thanks [@chengluyu](https://github.com/chengluyu)! - 统一了界面分隔线的颜色与粗细，代码块、图片缩略图等内容卡片的边框更纤细。

- [#72](https://github.com/MoonshotAI/kimi-code-app/pull/72) [`bae2c0a`](https://github.com/MoonshotAI/kimi-code-app/commit/bae2c0ae9011d5b9bfb4f4df609cda7a7818914b) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复窗口在最大化或全屏状态下关闭后、下次启动仍以全屏大小打开的问题，现在会恢复上次的正常窗口尺寸。

## 0.0.8

### Patch Changes

- [#68](https://github.com/MoonshotAI/kimi-code-app/pull/68) [`cddc1e3`](https://github.com/MoonshotAI/kimi-code-app/commit/cddc1e355202f6ff4081038ad557cb247382d725) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置的账户页改版：登录状态以卡片展示，未登录时可直接点击登录。

- [#65](https://github.com/MoonshotAI/kimi-code-app/pull/65) [`ae7a176`](https://github.com/MoonshotAI/kimi-code-app/commit/ae7a176157448e258e327f1229c4c7463af69cb5) Thanks [@liruifengv](https://github.com/liruifengv)! - 新增自定义键盘快捷键：为打开设置（⌘,）、收起侧边栏（⌘B）、归档当前会话、侧边聊天、打开文件夹、在默认应用中打开等操作加了默认快捷键，发送和换行也可在设置 → 键盘快捷键中自由重绑。

- [#69](https://github.com/MoonshotAI/kimi-code-app/pull/69) [`9c0169d`](https://github.com/MoonshotAI/kimi-code-app/commit/9c0169d784fab2e2ce13e12c6cc4ecef1232cf89) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复发送图片后缩略图先闪一下裂图再加载出来的问题。

- [#59](https://github.com/MoonshotAI/kimi-code-app/pull/59) [`8b718fd`](https://github.com/MoonshotAI/kimi-code-app/commit/8b718fd57ededde0e029d8321ef187ae29c9add8) Thanks [@chengluyu](https://github.com/chengluyu)! - 目标状态从全宽横条改为与待办、子 Agent 一致的小 pill，点击在停靠面板中查看目标详情并进行暂停、继续、取消操作。

- [#66](https://github.com/MoonshotAI/kimi-code-app/pull/66) [`261cd20`](https://github.com/MoonshotAI/kimi-code-app/commit/261cd203b608f72091a507f38811cd88356d3ab0) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置里的三个通知开关合并为一个「系统通知」总开关（默认开启），「提示音」开关改为控制通知是否随附系统提示音。

- [#71](https://github.com/MoonshotAI/kimi-code-app/pull/71) [`eb28f92`](https://github.com/MoonshotAI/kimi-code-app/commit/eb28f92b714dacbeecae9e31fff173f999cb0f53) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复桌面宠物更新后默认开启的问题，现在默认保持隐藏，可从菜单 View → Kimi Pet 手动开启。

- [#64](https://github.com/MoonshotAI/kimi-code-app/pull/64) [`c2d2470`](https://github.com/MoonshotAI/kimi-code-app/commit/c2d2470e97116013ba44015aad34451464f53118) Thanks [@chengluyu](https://github.com/chengluyu)! - 支持置顶会话：悬停会话行点图钉按钮、从会话菜单置顶，或直接把会话拖进侧栏顶部「置顶」区，拖回原工作区即可取消置顶。置顶区内可拖拽调整顺序，悬停可查看会话所属的工作区和路径。

- [#68](https://github.com/MoonshotAI/kimi-code-app/pull/68) [`cddc1e3`](https://github.com/MoonshotAI/kimi-code-app/commit/cddc1e355202f6ff4081038ad557cb247382d725) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置中移除了「显示对话目录」和「合并所有可用 Skills」开关以及账户页的引导入口，对话目录改为始终显示。

- [#68](https://github.com/MoonshotAI/kimi-code-app/pull/68) [`cddc1e3`](https://github.com/MoonshotAI/kimi-code-app/commit/cddc1e355202f6ff4081038ad557cb247382d725) Thanks [@liruifengv](https://github.com/liruifengv)! - 设置弹窗的标题移到左侧栏顶部，各区块标题字号与卡片对齐更统一。

- [#71](https://github.com/MoonshotAI/kimi-code-app/pull/71) [`eb28f92`](https://github.com/MoonshotAI/kimi-code-app/commit/eb28f92b714dacbeecae9e31fff173f999cb0f53) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持系统级全局快捷键唤起应用窗口，默认 Cmd+Shift+Space（macOS）/ Ctrl+Shift+Space（其他系统），可在设置的键盘快捷键中自定义。

- [#70](https://github.com/MoonshotAI/kimi-code-app/pull/70) [`3d6b2d6`](https://github.com/MoonshotAI/kimi-code-app/commit/3d6b2d6f60e737ce0af29edc495195d2a20e2ffa) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复透明背景的图片在聊天和文件预览中看不见的问题，白色、黑色内容在亮色和暗色主题下都清晰可见。

## 0.0.7

### Patch Changes

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 应用菜单新增「设置…」（快捷键 Cmd/Ctrl+,）和「检查更新…」:检查到有新版本时可直接下载,结果通过原生弹窗反馈。

- [#44](https://github.com/MoonshotAI/kimi-code-app/pull/44) [`e6c96c7`](https://github.com/MoonshotAI/kimi-code-app/commit/e6c96c74d727eb9c7206fbf8533cbb9e582fe8d0) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复 macOS 上会话菜单打开后，点击窗口顶部拖拽区域（聊天标题栏、侧栏标题栏等）无法关闭菜单的问题。

- [#51](https://github.com/MoonshotAI/kimi-code-app/pull/51) [`2cb8bc2`](https://github.com/MoonshotAI/kimi-code-app/commit/2cb8bc2486d6c80f0d5b4ca316510d277693ac53) Thanks [@liruifengv](https://github.com/liruifengv)! - macOS 上支持 Cmd+W 关闭窗口：关窗后应用隐藏在后台驻留，从 Dock 或托盘重新打开即时响应。

- [#57](https://github.com/MoonshotAI/kimi-code-app/pull/57) [`6fdf4bc`](https://github.com/MoonshotAI/kimi-code-app/commit/6fdf4bc68490ee963d4284596c3fb24440fa523f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 定时提醒消息重新排版：标题、原始 cron 表达式、触发状态收进气泡右上方的一行浅灰标签（任务 ID 移到悬停提示），气泡下方只保留触发时间。

- [#54](https://github.com/MoonshotAI/kimi-code-app/pull/54) [`10dc455`](https://github.com/MoonshotAI/kimi-code-app/commit/10dc455ea1588bbddf9d48399bba552b72768c7f) Thanks [@liruifengv](https://github.com/liruifengv)! - 新增桌面宠物「小蓝」（仅 macOS）：官方动态形象常驻桌面，平时会眨眼、左顾右盼，点一下会随机做动作，可以拖到任意位置，View 菜单可开关。

- [#63](https://github.com/MoonshotAI/kimi-code-app/pull/63) [`aeebb44`](https://github.com/MoonshotAI/kimi-code-app/commit/aeebb44c913f8684238a6696ca9f8aff3e329dc3) Thanks [@liruifengv](https://github.com/liruifengv)! - 支持把文件夹直接拖到侧边栏创建工作区，可一次拖入多个。

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 系统菜单新增「文件」菜单:新建会话(⌘N)可直接使用,新建窗口(⇧⌘N)、打开文件夹…(⌘O)先行展示(功能后续接入),「关闭窗口」(⌘W)移至该菜单。

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复系统菜单中「关于」「退出」等菜单项显示为内部包名 kimi-code-app 的问题,现在正确显示 Kimi Code。

- [#58](https://github.com/MoonshotAI/kimi-code-app/pull/58) [`a3c0f09`](https://github.com/MoonshotAI/kimi-code-app/commit/a3c0f097dbeca0ad8c075e84357d412949e24621) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复多个输入框在中文输入法下按回车确认候选词会直接提交的问题，涉及会话与工作空间重命名、会话搜索、提问与审批回复、模型选择和添加工作空间。

- [#62](https://github.com/MoonshotAI/kimi-code-app/pull/62) [`946c196`](https://github.com/MoonshotAI/kimi-code-app/commit/946c1968c9d9c8d4a1eb33ea0d3ee233025819dd) Thanks [@liruifengv](https://github.com/liruifengv)! - 系统菜单新增「帮助」菜单,可直接打开 Kimi Code 文档和控制台(网页)。

- [#63](https://github.com/MoonshotAI/kimi-code-app/pull/63) [`aeebb44`](https://github.com/MoonshotAI/kimi-code-app/commit/aeebb44c913f8684238a6696ca9f8aff3e329dc3) Thanks [@liruifengv](https://github.com/liruifengv)! - 新建工作区后，侧边栏会以选中底色标出该工作区行；切换会话或发出第一条消息后恢复。

- [#45](https://github.com/MoonshotAI/kimi-code-app/pull/45) [`48f01c4`](https://github.com/MoonshotAI/kimi-code-app/commit/48f01c46be88a9967937aecf49433a996969efe2) Thanks [@chengluyu](https://github.com/chengluyu)! - 会话标题右侧菜单、工作区菜单和对话菜单打开时，加入与模型切换器一致的弹出动画。

- [#49](https://github.com/MoonshotAI/kimi-code-app/pull/49) [`96d9890`](https://github.com/MoonshotAI/kimi-code-app/commit/96d9890d22999d1a1c64c899cc46dc171d1349ac) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复新增工作区在侧栏被排到最后的问题，新增后会显示在最上面。

- [#61](https://github.com/MoonshotAI/kimi-code-app/pull/61) [`4e114e9`](https://github.com/MoonshotAI/kimi-code-app/commit/4e114e993cc95aa69ba71b665b4f63dd959814e7) Thanks [@liruifengv](https://github.com/liruifengv)! - 移除设置中的黑色主题色选项，界面主题色统一为蓝色。

- [#45](https://github.com/MoonshotAI/kimi-code-app/pull/45) [`48f01c4`](https://github.com/MoonshotAI/kimi-code-app/commit/48f01c46be88a9967937aecf49433a996969efe2) Thanks [@chengluyu](https://github.com/chengluyu)! - 右键点击侧栏中的对话项时，可打开与 ⋯ 按钮相同的会话菜单。

- [#56](https://github.com/MoonshotAI/kimi-code-app/pull/56) [`4086a24`](https://github.com/MoonshotAI/kimi-code-app/commit/4086a24a0ab64a0ef6f2f75d5829a381ab78289f) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 修复会话运行中界面卡顿、操作响应缓慢的问题，会话和历史较多时改善尤其明显。

- [#50](https://github.com/MoonshotAI/kimi-code-app/pull/50) [`a142fae`](https://github.com/MoonshotAI/kimi-code-app/commit/a142faeec1bc283dbf9ce9f560f66c62836d655e) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复等待审批或回答问题期间思考计时仍在走、且最终时长计入等待时间的问题。

- [#52](https://github.com/MoonshotAI/kimi-code-app/pull/52) [`4496406`](https://github.com/MoonshotAI/kimi-code-app/commit/4496406cfe43172b8d91e8b58a3e65334ce1f47a) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 每轮回复结束后，思考过程、工具调用等中间内容自动折叠成一行「已工作 Ns」，消息流只保留最终正文，点击该行可展开查看完整过程。

- [#43](https://github.com/MoonshotAI/kimi-code-app/pull/43) [`f9f6a4c`](https://github.com/MoonshotAI/kimi-code-app/commit/f9f6a4c9268be2ce3f9fbc0641e402043bc4de53) Thanks [@chengluyu](https://github.com/chengluyu)! - 修复工具调用行里小写字母降部（如 j、p、g、y）被截断显示不全的问题。

- [#51](https://github.com/MoonshotAI/kimi-code-app/pull/51) [`2cb8bc2`](https://github.com/MoonshotAI/kimi-code-app/commit/2cb8bc2486d6c80f0d5b4ca316510d277693ac53) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复点击托盘菜单或系统通知中的会话无法跳转打开的问题。

- [#53](https://github.com/MoonshotAI/kimi-code-app/pull/53) [`57b0b4c`](https://github.com/MoonshotAI/kimi-code-app/commit/57b0b4c0bdf5afa952be65024fdbcf3d22631130) Thanks [@wbxl2000](https://github.com/wbxl2000)! - 发送的图片和视频在消息气泡里显示为圆角缩略图，不再显示文件名；点击弹出浮窗预览，视频可直接播放。

- [#49](https://github.com/MoonshotAI/kimi-code-app/pull/49) [`96d9890`](https://github.com/MoonshotAI/kimi-code-app/commit/96d9890d22999d1a1c64c899cc46dc171d1349ac) Thanks [@liruifengv](https://github.com/liruifengv)! - 修复点击正在运行的会话后，其所在工作区在侧栏突然跳到最上面的问题。

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
