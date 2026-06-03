import { defineAdditionalConfig } from "vitepress";

export default defineAdditionalConfig({
  lang: 'zh-Hans',
  description: 'Kimi Code 文档',
  themeConfig: {
    sidebar: [
      {
        text: 'Kimi Code',
        items: [
          { text: '产品概览', link: '/' },
          { text: '最新动态', link: '/kimi-code/whats-new' },
          { text: '社区倡议', link: '/kimi-code/community-guidelines' },
          { text: '常见问题', link: '/kimi-code/faq' },
          { text: '错误参考', link: '/kimi-code/error-reference' },
        ],
      },
      {
        text: 'Kimi Code CLI',
        items: [
          { text: '📢 版本升级', link: '/kimi-code-cli/cli-migration' },
          {
            text: '指南',
            collapsed: false,
            items: [
              { text: '开始使用', link: '/kimi-code-cli/getting-started' },
              { text: '交互与输入', link: '/kimi-code-cli/interaction' },
              { text: '会话与上下文', link: '/kimi-code-cli/sessions' },
              { text: '常见使用案例', link: '/kimi-code-cli/use-cases' },
            ],
          },
          {
            text: '配置',
            collapsed: false,
            items: [
              { text: '配置文件', link: '/kimi-code-cli/configuration/configuration-files' },
              { text: '配置覆盖', link: '/kimi-code-cli/configuration/overrides-and-precedence' },
              { text: '环境变量', link: '/kimi-code-cli/configuration/environment-variables' },
              { text: '平台与模型', link: '/kimi-code-cli/configuration/providers-and-models' },
              { text: '数据路径', link: '/kimi-code-cli/configuration/data-locations' },
            ],
          },
          {
            text: '定制化',
            collapsed: false,
            items: [
              { text: 'Agent 与子 Agent', link: '/kimi-code-cli/customization/sub-agents' },
              { text: 'Hooks', link: '/kimi-code-cli/customization/hooks' },
              { text: 'MCP', link: '/kimi-code-cli/customization/mcp' },
              { text: 'Plugins', link: '/kimi-code-cli/customization/plugins' },
              { text: '官方插件', link: '/kimi-code-cli/customization/datasource' },
              { text: 'Agent Skills', link: '/kimi-code-cli/customization/skills' },
            ],
          },
          {
            text: '参考手册',
            collapsed: true,
            items: [
              { text: 'kimi 命令', link: '/kimi-code-cli/reference/kimi-command' },
              { text: '斜杠命令', link: '/kimi-code-cli/reference/slash-commands' },
              { text: '内置工具', link: '/kimi-code-cli/reference/tools' },
              { text: '键盘快捷键', link: '/kimi-code-cli/reference/keyboard-shortcuts' },
            ],
          },
        ],
      },
      {
        text: 'Kimi Code for VS Code',
        items: [
          { text: '快速开始', link: '/kimi-code-for-vscode/getting-started' },
          { text: '核心操作', link: '/kimi-code-for-vscode/core-operations' },
          { text: '配置', link: '/kimi-code-for-vscode/configuration' },
          { text: '定制化', link: '/kimi-code-for-vscode/customization' },
        ],
      },
      {
        text: '在更多第三方工具中使用',
        items: [
          { text: 'JetBrains', link: '/third-party-tools/jetbrains' },
          { text: 'Zed', link: '/third-party-tools/zed' },
          { text: 'Zsh', link: '/third-party-tools/zsh' },
          { text: '在其他 coding agent 中使用', link: '/third-party-tools/other-coding-agents' },
        ],
      },
    ],
  },
});
