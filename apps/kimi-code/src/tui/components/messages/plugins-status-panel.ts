import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';
import {
  CURATED_BADGE,
  OFFICIAL_BADGE,
  THIRD_PARTY_BADGE,
  type PluginTrustLabel,
  formatPluginSourceLabel,
  pluginTrustLabel,
} from '../../utils/plugin-source-label';

export interface PluginsListPanelInput {
  readonly plugins: readonly PluginSummary[];
}

export function buildPluginsListLines(input: PluginsListPanelInput): readonly string[] {
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const success = (text: string) => currentTheme.fg('success', text);
  const primary = (text: string) => currentTheme.fg('primary', text);
  const warning = (text: string) => currentTheme.fg('warning', text);
  if (input.plugins.length === 0) {
    return [
      muted(t('tui.messages.pluginsStatusPanel.noPlugins')),
      '',
      value(t('tui.messages.pluginsStatusPanel.installHint')),
    ];
  }
  const renderTrustBadge = (label: PluginTrustLabel): string => {
    if (label === 'official') return success(`[${OFFICIAL_BADGE}]`);
    if (label === 'curated') return primary(`[${CURATED_BADGE}]`);
    return muted(`[${THIRD_PARTY_BADGE}]`);
  };
  const lines: string[] = [];
  for (const plugin of input.plugins) {
    const enabled = plugin.enabled
      ? success(t('tui.messages.pluginsStatusPanel.enabled'))
      : muted(t('tui.messages.pluginsStatusPanel.disabled'));
    const state = plugin.state === 'ok' ? '' : ` [${plugin.state}]`;
    const version = plugin.version ?? '-';
    const diagnostics = plugin.hasErrors
      ? warning(t('tui.messages.pluginsStatusPanel.diagnosticsHint'))
      : '';
    const sourceTag = muted(`[${formatPluginSourceLabel(plugin)}]`);
    const trustBadge = ` ${renderTrustBadge(pluginTrustLabel(plugin))}`;
    lines.push(
      `${value(plugin.displayName)} (${muted(plugin.id)}) ${muted(version)} ${sourceTag}${trustBadge} | ${enabled}${state}`,
    );
    const mcp =
      plugin.mcpServerCount > 0
        ? ` | ${t('tui.messages.pluginsStatusPanel.mcpCount', {
            enabled: plugin.enabledMcpServerCount,
            total: plugin.mcpServerCount,
          })}`
        : '';
    lines.push(
      `  ${muted(t('tui.messages.pluginsStatusPanel.skillsLabel'))} ${value(String(plugin.skillCount))}${muted(mcp)}${diagnostics}`,
    );
  }
  return lines;
}


export interface PluginsInfoPanelInput {
  readonly info: PluginInfo;
}

export function buildPluginsInfoLines(input: PluginsInfoPanelInput): readonly string[] {
  const { info } = input;
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const success = (text: string) => currentTheme.fg('success', text);
  const warning = (text: string) => currentTheme.fg('warning', text);
  const error = (text: string) => currentTheme.fg('error', text);
  const primary = (text: string) => currentTheme.fg('primary', text);
  const status = info.enabled
    ? success(t('tui.messages.pluginsStatusPanel.enabled'))
    : muted(t('tui.messages.pluginsStatusPanel.disabled'));
  const trustLine = (() => {
    const label = pluginTrustLabel(info);
    if (label === 'official') {
      return `${muted(t('tui.messages.pluginsStatusPanel.trust'))}  ${success(OFFICIAL_BADGE)} ${muted(t('tui.messages.pluginsStatusPanel.officialDescription'))}`;
    }
    if (label === 'curated') {
      return `${muted(t('tui.messages.pluginsStatusPanel.trust'))}  ${primary(CURATED_BADGE)} ${muted(t('tui.messages.pluginsStatusPanel.curatedDescription'))}`;
    }
    return `${muted(t('tui.messages.pluginsStatusPanel.trust'))}  ${muted(THIRD_PARTY_BADGE)}`;
  })();
  const lines: string[] = [
    `${value(info.displayName)} (${muted(info.id)}) ${muted(info.version ?? '')}`.trim(),
    `${muted(t('tui.messages.pluginsStatusPanel.status'))} ${status}${muted(t('tui.messages.pluginsStatusPanel.statePrefix'))}${stateText(info.state)}`,
    trustLine,
    `${muted(t('tui.messages.pluginsStatusPanel.source'))} ${value(info.source)}`,
    `${muted(t('tui.messages.pluginsStatusPanel.root'))}   ${value(info.root)}`,
  ];
  if (info.source === 'github' && info.github !== undefined) {
    const refLabel = `${info.github.ref.kind}:${info.github.ref.value}`;
    lines.push(
      `${muted(t('tui.messages.pluginsStatusPanel.github'))} ${value(`${info.github.owner}/${info.github.repo}`)} ${muted(`@${refLabel}`)}`,
    );
    if (info.github.installedSha !== undefined) {
      lines.push(
        `${muted(t('tui.messages.pluginsStatusPanel.installedSha'))} ${value(info.github.installedSha)}`,
      );
    }
  }
  if (info.originalSource !== undefined) {
    lines.push(
      `${muted(t('tui.messages.pluginsStatusPanel.originalSource'))} ${value(info.originalSource)}`,
    );
  }
  lines.push(`${muted(t('tui.messages.pluginsStatusPanel.installedAt'))} ${value(info.installedAt)}`);
  if (info.updatedAt !== undefined && info.updatedAt !== info.installedAt) {
    lines.push(`${muted(t('tui.messages.pluginsStatusPanel.lastUpdated'))} ${value(info.updatedAt)}`);
  }
  if (info.manifestPath !== undefined) {
    const kindSuffix =
      info.manifestKind !== undefined
        ? ` ${muted(t('tui.messages.pluginsStatusPanel.manifestKind', { kind: info.manifestKind }))}`
        : '';
    lines.push(`${muted(t('tui.messages.pluginsStatusPanel.manifest'))} ${value(info.manifestPath)}${kindSuffix}`);
  }
  if (info.shadowedManifestPath !== undefined) {
    lines.push(`${muted(t('tui.messages.pluginsStatusPanel.shadowed'))} ${value(info.shadowedManifestPath)}`);
  }
  const sessionStartSkill = info.manifest?.sessionStart?.skill;
  if (sessionStartSkill !== undefined) {
    lines.push(
      `${muted(t('tui.messages.pluginsStatusPanel.sessionStart'))} ${value(sessionStartSkill)}`,
    );
  }
  if (info.manifest?.skillInstructions !== undefined) {
    lines.push(
      `${muted(t('tui.messages.pluginsStatusPanel.skillInstructions'))} ${value(t('tui.messages.pluginsStatusPanel.skillInstructionsPresent'))}`,
    );
  }
  lines.push('');
  lines.push(
    value(
      t('tui.messages.pluginsStatusPanel.skills', {
        count: info.manifest?.skills?.length ?? 0,
      }),
    ),
  );
  for (const dir of info.manifest?.skills ?? []) lines.push(`  ${muted('-')} ${value(dir)}`);

  if (info.mcpServers.length > 0) {
    lines.push('');
    lines.push(
      value(
        t('tui.messages.pluginsStatusPanel.mcpServers', {
          enabled: info.enabledMcpServerCount,
          total: info.mcpServerCount,
        }),
      ),
    );
    lines.push(
      muted(
        `  ${t('tui.messages.pluginsStatusPanel.mcpHint', { id: info.id })}`,
      ),
    );
    for (const server of info.mcpServers) {
      const enabled = server.enabled
        ? success(t('tui.messages.pluginsStatusPanel.enabled'))
        : muted(t('tui.messages.pluginsStatusPanel.disabled'));
      lines.push(`  ${muted('-')} ${value(server.name)} ${enabled} ${muted(`(${server.runtimeName})`)}`);
      if (server.transport === 'stdio') {
        const args =
          server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
        lines.push(
          `    ${muted(t('tui.messages.pluginsStatusPanel.command'))} ${value(`${server.command ?? ''}${args}`.trim())}`,
        );
        if (server.cwd !== undefined) {
          lines.push(`    ${muted(t('tui.messages.pluginsStatusPanel.cwd'))} ${value(server.cwd)}`);
        }
        if (server.envKeys !== undefined && server.envKeys.length > 0) {
          lines.push(
            `    ${muted(t('tui.messages.pluginsStatusPanel.env'))} ${value(server.envKeys.join(', '))}`,
          );
        }
      } else {
        lines.push(
          `    ${muted(t('tui.messages.pluginsStatusPanel.url'))} ${value(server.url ?? '')}`,
        );
        if (server.headerKeys !== undefined && server.headerKeys.length > 0) {
          lines.push(
            `    ${muted(t('tui.messages.pluginsStatusPanel.headers'))} ${value(server.headerKeys.join(', '))}`,
          );
        }
      }
    }
  }

  const iface = info.manifest?.interface;
  if (iface !== undefined) {
    lines.push('');
    lines.push(value(t('tui.messages.pluginsStatusPanel.display')));
    if (iface.shortDescription !== undefined) {
      lines.push(`  ${muted('-')} ${value(iface.shortDescription)}`);
    }
    if (iface.developerName !== undefined) {
      lines.push(
        `  ${muted('-')} ${value(t('tui.messages.pluginsStatusPanel.by', { name: iface.developerName }))}`,
      );
    }
    if (iface.websiteURL !== undefined) lines.push(`  ${muted('-')} ${value(iface.websiteURL)}`);
  }

  if (info.manifest?.keywords !== undefined && info.manifest.keywords.length > 0) {
    lines.push('');
    lines.push(
      muted(
        t('tui.messages.pluginsStatusPanel.keywords', {
          keywords: info.manifest.keywords.join(', '),
        }),
      ),
    );
  }

  if (info.diagnostics.length > 0) {
    lines.push('');
    lines.push(value(t('tui.messages.pluginsStatusPanel.diagnostics')));
    for (const d of info.diagnostics) {
      const paint = d.severity === 'error' ? error : d.severity === 'warn' ? warning : muted;
      lines.push(`  ${paint(`[${d.severity}]`)} ${value(d.message)}`);
    }
  }
  return lines;
}

function stateText(state: PluginInfo['state']): string {
  if (state === 'ok') return currentTheme.fg('success', state);
  return currentTheme.fg('error', state);
}
