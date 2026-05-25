import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import type { ColorPalette } from '../../theme/colors';

export interface PluginsListPanelInput {
  readonly colors: ColorPalette;
  readonly plugins: readonly PluginSummary[];
}

export function buildPluginsListLines(input: PluginsListPanelInput): readonly string[] {
  if (input.plugins.length === 0) {
    return ['No plugins installed.', '', 'Try: /plugins install <absolute-path>'];
  }
  const lines: string[] = [];
  for (const plugin of input.plugins) {
    const enabled = plugin.enabled ? 'enabled' : 'disabled';
    const state = plugin.state === 'ok' ? '' : ` [${plugin.state}]`;
    const version = plugin.version ?? '—';
    lines.push(`${plugin.displayName} (${plugin.id}) ${version} · ${enabled}${state}`);
    lines.push(`  skills: ${plugin.skillCount}${plugin.hasErrors ? ' · diagnostics: see /plugins info' : ''}`);
  }
  return lines;
}

export interface PluginsInfoPanelInput {
  readonly colors: ColorPalette;
  readonly info: PluginInfo;
}

export function buildPluginsInfoLines(input: PluginsInfoPanelInput): readonly string[] {
  const { info } = input;
  const lines: string[] = [
    `${info.displayName} (${info.id}) ${info.version ?? ''}`.trim(),
    `Status: ${info.enabled ? 'enabled' : 'disabled'} · state: ${info.state}`,
    `Source: ${info.source}`,
    `Root:   ${info.root}`,
  ];
  if (info.manifestPath !== undefined) lines.push(`Manifest: ${info.manifestPath}`);
  if (info.shadowedManifestPath !== undefined) {
    lines.push(`Shadowed: ${info.shadowedManifestPath} (suppressed by native manifest)`);
  }
  lines.push('');
  lines.push(`Skills (${info.manifest?.skills?.length ?? 0}):`);
  for (const dir of info.manifest?.skills ?? []) lines.push(`  · ${dir}`);

  const iface = info.manifest?.interface;
  if (iface !== undefined) {
    lines.push('');
    lines.push('Display:');
    if (iface.shortDescription !== undefined) lines.push(`  · ${iface.shortDescription}`);
    if (iface.developerName !== undefined) lines.push(`  · by ${iface.developerName}`);
    if (iface.websiteURL !== undefined) lines.push(`  · ${iface.websiteURL}`);
    if (iface.capabilities !== undefined && iface.capabilities.length > 0) {
      lines.push(`  · capabilities: ${iface.capabilities.join(', ')}`);
    }
  }

  const ignored: string[] = [];
  if (info.recognizedFields.hooks === true) ignored.push('hooks');
  if (info.recognizedFields.mcpServers === true) ignored.push('mcpServers');
  if (info.recognizedFields.apps === true) ignored.push('apps');
  if (ignored.length > 0) {
    lines.push('');
    lines.push('Recognized but not executed by Kimi:');
    for (const field of ignored) lines.push(`  · ${field}`);
  }

  if (info.diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics:');
    for (const d of info.diagnostics) {
      lines.push(`  [${d.severity}] ${d.code}: ${d.message}`);
    }
  }
  return lines;
}
