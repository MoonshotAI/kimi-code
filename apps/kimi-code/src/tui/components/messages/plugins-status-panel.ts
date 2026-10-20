import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

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
      muted('No plugins installed.'),
      '',
      value('Run /plugins to install one.'),
    ];
  }
  const renderTrustBadge = (label: PluginTrustLabel): string => {
    if (label === 'official') return success(`[${OFFICIAL_BADGE}]`);
    if (label === 'curated') return primary(`[${CURATED_BADGE}]`);
    return muted(`[${THIRD_PARTY_BADGE}]`);
  };
  const lines: string[] = [];
  for (const plugin of input.plugins) {
    const enabled = plugin.enabled ? success('enabled') : muted('disabled');
    const state = plugin.state === 'ok' ? '' : ` [${plugin.state}]`;
    const version = plugin.version ?? '-';
    const diagnostics = plugin.hasErrors ? warning(' | diagnostics: see /plugins info') : '';
    const sourceTag = muted(`[${formatPluginSourceLabel(plugin)}]`);
    const trustBadge = ` ${renderTrustBadge(pluginTrustLabel(plugin))}`;
    lines.push(
      `${value(plugin.displayName)} (${muted(plugin.id)}) ${muted(version)} ${sourceTag}${trustBadge} | ${enabled}${state}`,
    );
    const mcp =
      plugin.mcpServerCount > 0
        ? ` | ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount} mcp`
        : '';
    lines.push(`  ${muted('skills:')} ${value(String(plugin.skillCount))}${muted(mcp)}${diagnostics}`);
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
  const status = info.enabled ? success('enabled') : muted('disabled');
  const trustLine = (() => {
    const label = pluginTrustLabel(info);
    if (label === 'official') {
      return `${muted('Trust:')}  ${success(OFFICIAL_BADGE)} ${muted('(Kimi-built and -maintained)')}`;
    }
    if (label === 'curated') {
      return `${muted('Trust:')}  ${primary(CURATED_BADGE)} ${muted('(Kimi-reviewed, upstream-maintained)')}`;
    }
    return `${muted('Trust:')}  ${muted(THIRD_PARTY_BADGE)}`;
  })();
  const lines: string[] = [
    `${value(info.displayName)} (${muted(info.id)}) ${muted(info.version ?? '')}`.trim(),
    `${muted('Status:')} ${status} | ${muted('state:')} ${stateText(info.state)}`,
    trustLine,
    `${muted('Source:')} ${value(info.source)}`,
    `${muted('Root:')}   ${value(info.root)}`,
  ];
  if (info.source === 'github' && info.github !== undefined) {
    const refLabel = `${info.github.ref.kind}:${info.github.ref.value}`;
    lines.push(`${muted('GitHub:')} ${value(`${info.github.owner}/${info.github.repo}`)} ${muted(`@${refLabel}`)}`);
    if (info.github.installedSha !== undefined) {
      lines.push(`${muted('Installed SHA:')} ${value(info.github.installedSha)}`);
    }
  }
  if (info.originalSource !== undefined) lines.push(`${muted('Original source:')} ${value(info.originalSource)}`);
  lines.push(`${muted('Installed at:')} ${value(info.installedAt)}`);
  if (info.updatedAt !== undefined && info.updatedAt !== info.installedAt) {
    lines.push(`${muted('Last updated:')} ${value(info.updatedAt)}`);
  }
  if (info.manifestPath !== undefined) {
    const kindSuffix = info.manifestKind !== undefined ? ` ${muted(`(${info.manifestKind})`)}` : '';
    lines.push(`${muted('Manifest:')} ${value(info.manifestPath)}${kindSuffix}`);
  }
  if (info.shadowedManifestPath !== undefined) {
    lines.push(`${muted('Shadowed:')} ${value(info.shadowedManifestPath)}`);
  }
  const sessionStartSkill = info.manifest?.sessionStart?.skill;
  if (sessionStartSkill !== undefined) {
    lines.push(`${muted('Session start:')} ${value(sessionStartSkill)}`);
  }
  if (info.manifest?.skillInstructions !== undefined) {
    lines.push(`${muted('Skill instructions:')} ${value('present')}`);
  }
  lines.push('');
  lines.push(value(`Skills (${info.manifest?.skills?.length ?? 0}):`));
  for (const dir of info.manifest?.skills ?? []) lines.push(`  ${muted('-')} ${value(dir)}`);

  if (info.mcpServers.length > 0) {
    lines.push('');
    lines.push(value(`MCP servers (${info.enabledMcpServerCount}/${info.mcpServerCount} enabled):`));
    lines.push(muted(`  Enabled by default; disable with /plugins mcp disable ${info.id} <server>.`));
    for (const server of info.mcpServers) {
      const enabled = server.enabled ? success('enabled') : muted('disabled');
      lines.push(`  ${muted('-')} ${value(server.name)} ${enabled} ${muted(`(${server.runtimeName})`)}`);
      if (server.transport === 'stdio') {
        const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
        lines.push(`    ${muted('command:')} ${value(`${server.command ?? ''}${args}`.trim())}`);
        if (server.cwd !== undefined) lines.push(`    ${muted('cwd:')} ${value(server.cwd)}`);
        if (server.envKeys !== undefined && server.envKeys.length > 0) {
          lines.push(`    ${muted('env:')} ${value(server.envKeys.join(', '))}`);
        }
      } else {
        lines.push(`    ${muted('url:')} ${value(server.url ?? '')}`);
        if (server.headerKeys !== undefined && server.headerKeys.length > 0) {
          lines.push(`    ${muted('headers:')} ${value(server.headerKeys.join(', '))}`);
        }
      }
    }
  }

  const iface = info.manifest?.interface;
  if (iface !== undefined) {
    lines.push('');
    lines.push(value('Display:'));
    if (iface.shortDescription !== undefined) lines.push(`  ${muted('-')} ${value(iface.shortDescription)}`);
    if (iface.developerName !== undefined) lines.push(`  ${muted('-')} ${value(`by ${iface.developerName}`)}`);
    if (iface.websiteURL !== undefined) lines.push(`  ${muted('-')} ${value(iface.websiteURL)}`);
  }

  if (info.manifest?.keywords !== undefined && info.manifest.keywords.length > 0) {
    lines.push('');
    lines.push(muted(`Keywords: ${info.manifest.keywords.join(', ')}`));
  }

  if (info.diagnostics.length > 0) {
    lines.push('');
    lines.push(value('Diagnostics:'));
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
