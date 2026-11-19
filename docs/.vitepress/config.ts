import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'

const rawBase = process.env.VITEPRESS_BASE
const base = rawBase
  ? rawBase.startsWith('/')
    ? rawBase.endsWith('/') ? rawBase : `${rawBase}/`
    : `/${rawBase}/`
  : '/'

const mermaidOptimizeDeps = [
  '@braintree/sanitize-url',
  'dayjs',
  'debug',
  'cytoscape-cose-bilkent',
  'cytoscape',
]

const config = withMermaid(defineConfig({
  base,
  title: 'Kimi Code CLI Docs',
  description: 'Kimi Code CLI Documentation',

  head: [
    ['link', { rel: 'icon', type: 'image/x-icon', href: `${base}favicon.ico` }],
    ['meta', { name: 'theme-color', content: '#0a7aff' }],
  ],

  srcExclude: ['AGENTS.md', 'superpowers/**'],

  locales: {
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'Kimi Code CLI 文档',
      description: 'Kimi Code CLI 用户文档',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guides/getting-started', activeMatch: '/zh/guides/' },
          { text: '定制化', link: '/zh/customization/mcp', activeMatch: '/zh/customization/' },
          { text: '配置', link: '/zh/configuration/config-files', activeMatch: '/zh/configuration/' },
          { text: '参考手册', link: '/zh/reference/kimi-command', activeMatch: '/zh/reference/' },
          { text: '发布说明', link: '/zh/release-notes/changelog', activeMatch: '/zh/release-notes/' },
        ],
        sidebar: {
          '/zh/guides/': [
            {
              text: '指南',
              items: [
                { text: '开始使用', link: '/zh/guides/getting-started' },
                { text: '从 kimi-cli 迁移', link: '/zh/guides/migration' },
                { text: '常见使用案例', link: '/zh/guides/use-cases' },
                { text: '交互与输入', link: '/zh/guides/interaction' },
                { text: '会话与上下文', link: '/zh/guides/sessions' },
                { text: '反馈与上传内容', link: '/zh/guides/feedback' },
                { text: 'Tower 多 Agent 协作', link: '/zh/guides/tower' },
                { text: '远程环境', link: '/zh/guides/remote-environment' },
              ],
            },
            {
              text: '多端与外部接入',
              items: [
                { text: '在网页中使用', link: '/zh/guides/web' },
                { text: '在 IDE 中使用', link: '/zh/guides/ides' },
                { text: '在其他 Agent 中使用（Agent to Agent）', link: '/zh/guides/other-agents' },
              ],
            },
          ],
          '/zh/customization/': [
            {
              text: '定制化',
              items: [
                { text: 'Model Context Protocol', link: '/zh/customization/mcp' },
                { text: 'Agent Skills', link: '/zh/customization/skills' },
                { text: 'Plugins', link: '/zh/customization/plugins' },
                { text: 'Agent 与 subagent', link: '/zh/customization/agents' },
                { text: 'Hooks', link: '/zh/customization/hooks' },
                { text: '自定义主题', link: '/zh/customization/themes' },
              ],
            },
          ],
          '/zh/configuration/': [
            {
              text: '配置',
              items: [
                { text: '配置文件', link: '/zh/configuration/config-files' },
                { text: '平台与模型', link: '/zh/configuration/providers' },
                { text: '配置覆盖', link: '/zh/configuration/overrides' },
                { text: '环境变量', link: '/zh/configuration/env-vars' },
                { text: '数据路径', link: '/zh/configuration/data-locations' },
              ],
            },
          ],
          '/zh/reference/': [
            {
              text: '参考手册',
              items: [
                { text: 'kimi 命令', link: '/zh/reference/kimi-command' },
                { text: 'kimi acp 子命令', link: '/zh/reference/kimi-acp' },
                { text: '内置工具', link: '/zh/reference/tools' },
                { text: '斜杠命令', link: '/zh/reference/slash-commands' },
                { text: '键盘快捷键', link: '/zh/reference/keyboard' },
              ],
            },
          ],
          '/zh/release-notes/': [
            {
              text: '发布说明',
              items: [
                { text: '变更记录', link: '/zh/release-notes/changelog' },
              ],
            },
          ],
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Kimi Code CLI Docs',
      description: 'Kimi Code CLI User Documentation',
      themeConfig: {
        nav: [
          { text: 'Guides', link: '/en/guides/getting-started', activeMatch: '/en/guides/' },
          { text: 'Customization', link: '/en/customization/mcp', activeMatch: '/en/customization/' },
          { text: 'Configuration', link: '/en/configuration/config-files', activeMatch: '/en/configuration/' },
          { text: 'Reference', link: '/en/reference/kimi-command', activeMatch: '/en/reference/' },
          { text: 'Release Notes', link: '/en/release-notes/changelog', activeMatch: '/en/release-notes/' },
        ],
        sidebar: {
          '/en/guides/': [
            {
              text: 'Guides',
              items: [
                { text: 'Getting Started', link: '/en/guides/getting-started' },
                { text: 'Migrating from kimi-cli', link: '/en/guides/migration' },
                { text: 'Common Use Cases', link: '/en/guides/use-cases' },
                { text: 'Interaction and Input', link: '/en/guides/interaction' },
                { text: 'Sessions and Context', link: '/en/guides/sessions' },
                { text: 'Feedback and uploads', link: '/en/guides/feedback' },
                { text: 'Tower multi-agent collaboration', link: '/en/guides/tower' },
                { text: 'Remote environments', link: '/en/guides/remote-environment' },
              ],
            },
            {
              text: 'Interfaces & Integrations',
              items: [
                { text: 'Using in the Browser', link: '/en/guides/web' },
                { text: 'Using in IDEs', link: '/en/guides/ides' },
                { text: 'Using in Other Agents (Agent to Agent)', link: '/en/guides/other-agents' },
              ],
            },
          ],
          '/en/customization/': [
            {
              text: 'Customization',
              items: [
                { text: 'Model Context Protocol', link: '/en/customization/mcp' },
                { text: 'Agent Skills', link: '/en/customization/skills' },
                { text: 'Plugins', link: '/en/customization/plugins' },
                { text: 'Agents and Subagents', link: '/en/customization/agents' },
                { text: 'Hooks', link: '/en/customization/hooks' },
                { text: 'Custom Themes', link: '/en/customization/themes' },
              ],
            },
          ],
          '/en/configuration/': [
            {
              text: 'Configuration',
              items: [
                { text: 'Config Files', link: '/en/configuration/config-files' },
                { text: 'Providers and Models', link: '/en/configuration/providers' },
                { text: 'Config Overrides', link: '/en/configuration/overrides' },
                { text: 'Environment Variables', link: '/en/configuration/env-vars' },
                { text: 'Data Locations', link: '/en/configuration/data-locations' },
              ],
            },
          ],
          '/en/reference/': [
            {
              text: 'Reference',
              items: [
                { text: 'kimi Command', link: '/en/reference/kimi-command' },
                { text: 'kimi acp Subcommand', link: '/en/reference/kimi-acp' },
                { text: 'Built-in Tools', link: '/en/reference/tools' },
                { text: 'Slash Commands', link: '/en/reference/slash-commands' },
                { text: 'Keyboard Shortcuts', link: '/en/reference/keyboard' },
              ],
            },
          ],
          '/en/release-notes/': [
            {
              text: 'Release Notes',
              items: [
                { text: 'Changelog', link: '/en/release-notes/changelog' },
              ],
            },
          ],
        },
      },
    },
  },

  themeConfig: {
    outline: [2, 3],
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/MoonshotAI/kimi-code' },
    ],
  },

  buildEnd(siteConfig) {
    const outDir = siteConfig.outDir
    const skillsRoot = resolve(siteConfig.root, '../skills')
    if (existsSync(skillsRoot)) {
      const outSkillsDir = resolve(outDir, 'skills')
      mkdirSync(outSkillsDir, { recursive: true })
      for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillFile = resolve(skillsRoot, entry.name, 'SKILL.md')
        if (existsSync(skillFile)) {
          copyFileSync(skillFile, resolve(outSkillsDir, `${entry.name}.md`))
        }
      }
    }

    const legacyPages = [
      'server-api',
      'server-api-conversation',
      'server-api-sessions',
      'server-api-service',
      'server-api-files',
    ]
    for (const locale of ['en', 'zh'] as const) {
      const guideTarget = `${base}${locale}/guides/other-agents.html`
      const refDir = resolve(outDir, locale, 'reference')
      mkdirSync(refDir, { recursive: true })
      for (const slug of legacyPages) {
        const html = `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><title>Redirecting…</title><link rel="canonical" href="${guideTarget}"><meta http-equiv="refresh" content="0; url=${guideTarget}"><script>location.replace(${JSON.stringify(guideTarget)});</script></head><body><p>Redirecting to <a href="${guideTarget}">${guideTarget}</a>…</p></body></html>\n`
        writeFileSync(resolve(refDir, `${slug}.html`), html, 'utf8')
      }
      const guidesDir = resolve(outDir, locale, 'guides')
      mkdirSync(guidesDir, { recursive: true })
      const rcTarget = `${base}${locale}/guides/web.html#${locale === 'zh' ? '远程控制' : 'remote-control'}`
      writeFileSync(
        resolve(guidesDir, 'remote-control.html'),
        `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><title>Redirecting…</title><link rel="canonical" href="${rcTarget}"><meta http-equiv="refresh" content="0; url=${rcTarget}"><script>location.replace(${JSON.stringify(rcTarget)});</script></head><body><p>Redirecting to <a href="${rcTarget}">${rcTarget}</a>…</p></body></html>\n`,
        'utf8',
      )
    }
  },

  vite: {
    optimizeDeps: {
      include: mermaidOptimizeDeps.map((dep) => `mermaid > ${dep}`),
    },
    plugins: [llmstxt()],
  },
}))

if (config.vite?.optimizeDeps?.include) {
  config.vite.optimizeDeps.include = config.vite.optimizeDeps.include.filter(
    (dep) => !mermaidOptimizeDeps.includes(dep),
  )
}

export default config
