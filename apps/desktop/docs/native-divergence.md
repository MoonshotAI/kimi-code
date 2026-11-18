# Desktop / Web 差异清单

desktop 与 web 共用 `src/renderer` 一份渲染层源码：desktop 经 Electron 壳加载（`desktop-dist/`），web 经 `vite.web.config.ts` 构建（`web-dist/`，由 kap-server 服务）。本文件只记录两个变体之间大的功能差异（绝大多数是 desktop 原生能力，web 构建不含或运行时无桥降级），每条一句话；不写实现细节、文件路径与决策经过，需要时查代码和 git log。两端已一致的能力不记录。

## 原生功能（desktop 有，web 没有）

- desktop 有应用内浏览器（含设备模拟、网站权限管理），web 没有
- desktop 有内置原生终端，web 没有
- desktop 有全局截图与图片标注，web 没有
- desktop 有网页标注（捕获页面元素/区域并评论），web 只能查看已有标注
- desktop 的浏览器工具调用可查看操作前画面，web 只显示回执编号
- desktop 的浏览器工具分组运行时可一键切到 Agent 正在控制的标签页，web 没有
- desktop 有「用 xxx 打开」（OpenIn），web 没有
- desktop 有自动更新和最低版本强制升级提示，web 没有
- desktop 有系统托盘（未读计数、关窗驻留），web 没有
- desktop 有系统原生菜单和全局唤起快捷键，web 没有
- desktop 支持自定义快捷键；web 沿用同一套默认键位但不可改，浏览器保留键（关标签、切标签等）不拦截
- desktop 有 Canary 内测通道，web 没有
- desktop 支持在设置中开启远程控制并原生管理设备，web 没有
- desktop 设置中有「休眠与息屏」三档选择器（允许休眠、阻止休眠但允许息屏、阻止休眠和息屏）和「合盖时不休眠」开关，web 没有
- desktop 有项目目录 hover 卡片，web 没有

## 平台集成差异

- desktop 新建/编辑工作区弹窗用原生目录选择器添加目录，web 用 daemon 目录浏览器（同一弹窗组件，目录选择器按平台注入）
- desktop 拖文件夹到侧栏可建工作区、拖到输入框插入路径，web 不支持
- desktop 下载走系统保存对话框，web 走浏览器默认下载
- desktop 外链默认在系统浏览器打开，PR 等部分链接支持内置浏览器，web 由浏览器自身处理
- desktop 有 Windows / Linux 自定义标题栏（Linux 可在设置切回系统标题栏），web 没有
- desktop 有 macOS 毛玻璃侧栏、Dock 图标设置、全屏侧栏贴边，web 没有
- desktop 最近工作区接入 Windows Jump List，web 没有
- desktop 支持通过 `kimi app` 唤起并在指定工作区开启新会话，web 没有

## 体验差异

- 浏览器页面（web 及远程控制网页）使用动态标签页图标并支持自定义标签页标题，desktop 窗口标题固定为 Kimi Code
- 开发构建的 desktop 侧栏有开发后端切换 pill，web 构建没有
- desktop「关于」显示内置服务版本（核心仓提交号），web 显示服务端版本号和服务器地址
- desktop 菜单/弹层用原生浮层渲染（可跨越网页层），web 用 DOM 实现
- desktop 有埋点上报，web 没有
- desktop 会在回复尾部偶尔请用户给会话评分（设置里可关闭），web 没有
- desktop 的 Hosts 设置可打开本机 SSH 配置、浏览选择密钥文件，web 需手填路径（SSH 连接与建项目两端都可用）
- composer 在 web 移动端用底部弹层，desktop 恒为桌面形态
- desktop 的 ⌘W 先关面板标签再隐藏窗口，web 由浏览器处理
- desktop 日志落盘并可从菜单或托盘一键导出诊断包（含本地崩溃转储），web 不落盘
- desktop 按登录地区切换更新源和官网链接，web 不切换
- desktop 的聊天消息链接悬停气泡有「右侧面板打开」按钮，web 只有「外部打开」
- desktop 的回答来源列表可在右侧浏览器打开页面并显示站点图标，web 在系统浏览器打开、只显示通用图标
- desktop 在聊天里点本地 HTML 文件（@ 文件提及、Markdown 文件链接）时在右侧浏览器按真实网页打开，web 仍用沙箱文件预览；内置浏览器地址栏也可输入 file:// 地址或本地绝对路径打开本地文件，设置开启后智能体也可打开
