/**
 * Simplified Chinese translations for slash commands.
 *
 * Mirrors the `en` `commands` namespace key-for-key. Command names /
 * identifiers stay untranslated — only human-readable text is localized.
 */

import type { MessageTree } from '../../i18n';

export const commands: MessageTree = {
  descriptions: {
    yolo: '切换自动批准模式',
    auto: '切换自动权限模式',
    permission: '选择权限模式',
    settings: '打开 TUI 设置',
    plan: '切换计划模式',
    swarm: '切换蜂群模式，或在蜂群模式下运行单个任务',
    model: '切换 LLM 模型',
    provider: '管理 AI 提供方（添加 / 删除 / 刷新）',
    btw: '向分叉的旁路智能体提问',
    help: '显示可用命令和快捷键',
    new: '在当前工作区开启全新会话',
    sessions: '浏览并恢复会话',
    tasks: '浏览后台任务',
    mcp: '显示 MCP 服务器状态',
    plugins: '管理插件',
    experiments: '管理实验性功能',
    reload: '重新加载会话，并应用 config.toml 设置及 tui.toml 界面偏好',
    'reload-tui': '仅重新加载 tui.toml 界面偏好',
    compact: '压缩对话上下文',
    goal: '启动或管理自主目标',
    init: '分析代码库并生成 AGENTS.md',
    fork: '分叉当前会话',
    title: '设置或显示会话标题',
    usage: '显示会话令牌 + 上下文窗口 + 套餐配额',
    status: '显示当前会话和运行时状态',
    feedback: '发送反馈以改进 Kimi Code',
    undo: '从记录中撤回上一条提示',
    editor: '设置 Ctrl-G 使用的外部编辑器',
    theme: '设置终端界面主题',
    logout: '登出已配置的提供方',
    login: '选择平台并进行认证',
    'export-md': '将当前会话导出为 Markdown 文件',
    'export-debug-zip': '将当前会话导出为调试 ZIP 压缩包',
    web: '在 Web UI 中打开当前会话并退出终端',
    exit: '退出应用程序',
    version: '显示版本信息',
  },
  args: {
    goal: {
      status: '显示当前目标',
      pause: '暂停当前目标',
      resume: '恢复已暂停的目标',
      cancel: '取消并移除当前目标',
      replace: '用新目标替换当前目标',
      next: '排入后续目标',
      manage: '管理后续目标',
    },
    swarm: {
      on: '开启蜂群模式',
      off: '关闭蜂群模式',
    },
  },
  help: {
    title: '帮助',
    dismiss: '· Esc / Enter / q 取消 · ↑↓ 滚动',
    showing: '显示第 {start}-{end} 项，共 {total} 项',
    greeting: 'Kimi 已就绪，随时为你效劳！发送消息即可开始。',
    keyboardShortcuts: '键盘快捷键',
    slashCommands: '斜杠命令',
    shortcuts: {
      planMode: '切换计划模式',
      externalEditor: '在外部编辑器中编辑（$VISUAL / $EDITOR）',
      toolOutput: '切换工具输出展开',
      steer: '引导 — 在流式输出时插入后续消息',
      newline: '插入换行',
      interrupt: '中断流式输出 / 清空输入',
      exit: '退出（输入为空时）',
      closeDialogs: '关闭对话框 / 中断流式输出',
      history: '浏览输入历史',
      submit: '提交',
    },
  },
};
