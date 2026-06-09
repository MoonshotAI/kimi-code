import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

import type {
  AgentSwarmProgressMapSnapshot,
  AgentSwarmProgressMemberSnapshot,
  AgentSwarmProgressPhase,
} from '../messages/agent-swarm-progress';
import { currentTheme, type ColorToken } from '#/tui/theme';

const ELLIPSIS = '...';
const TITLE = 'Ultra Swarm Map';
const PHASE_LABEL_WIDTH = 'cancelled'.length;
const MAX_DETAILED_MEMBERS = 10;
const PULSE_INTERVAL_MS = 450;
const MEMBER_STRIP_GAP_WIDTH = 2;

export interface UltraSwarmMapOptions {
  readonly getWaves: () => readonly AgentSwarmProgressMapSnapshot[];
}

export class UltraSwarmMapComponent implements Component {
  private readonly getWaves: () => readonly AgentSwarmProgressMapSnapshot[];

  constructor(options: UltraSwarmMapOptions) {
    this.getWaves = options.getWaves;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const panelWidth = Math.max(1, width);
    const waves = this.getWaves().filter((wave) =>
      wave.toolCallActive || wave.members.length > 0
    );
    if (waves.length === 0) return [];

    const totalMembers = waves.reduce((sum, wave) => sum + wave.members.length, 0);
    const activeMembers = waves.reduce(
      (sum, wave) => sum + wave.members.filter((member) => member.phase === 'running').length,
      0,
    );
    const pulseOn = Math.floor(Date.now() / PULSE_INTERVAL_MS) % 2 === 0;
    const lines = [
      '',
      this.renderHeader(panelWidth, waves.length, totalMembers, activeMembers),
      this.renderLegend(panelWidth, pulseOn),
    ];

    waves.forEach((wave, index) => {
      lines.push(this.renderWaveHeader(panelWidth, wave, index));
      lines.push(...this.renderMemberStrip(panelWidth, wave.members, pulseOn));
      lines.push(...this.renderDetailedMembers(panelWidth, wave.members, pulseOn));
    });

    return lines.map((line) => truncateToWidth(line, panelWidth, ELLIPSIS));
  }

  private renderHeader(
    width: number,
    waveCount: number,
    memberCount: number,
    activeCount: number,
  ): string {
    const meta = `${waveCount} group${waveCount === 1 ? '' : 's'} / ${memberCount} agents / ${activeCount} active`;
    const prefix = `- ${currentTheme.boldFg('primary', TITLE)} ${currentTheme.fg('textDim', meta)} `;
    return withRule(prefix, width);
  }

  private renderLegend(width: number, pulseOn: boolean): string {
    const entries = [
      `${phaseMarker('running', pulseOn)} ${currentTheme.fg('success', 'active')}`,
      `${phaseMarker('queued', pulseOn)} ${currentTheme.fg('textDim', 'queued')}`,
      `${phaseMarker('suspended', pulseOn)} ${currentTheme.fg('warning', 'limited')}`,
      `${phaseMarker('completed', pulseOn)} ${currentTheme.fg('success', 'done')}`,
      `${phaseMarker('failed', pulseOn)} ${currentTheme.fg('error', 'failed')}`,
    ];
    return truncateToWidth(`  ${entries.join(currentTheme.fg('textMuted', ' | '))}`, width, ELLIPSIS);
  }

  private renderWaveHeader(
    width: number,
    wave: AgentSwarmProgressMapSnapshot,
    index: number,
  ): string {
    const label = cleanText(wave.description) || `Group ${index + 1}`;
    const active = wave.members.filter((member) => member.phase === 'running').length;
    const meta = `${active}/${wave.members.length} active`;
    const prefix = `  ${currentTheme.fg('primary', '-')} ${currentTheme.fg('textStrong', label)} ${currentTheme.fg('textDim', meta)} `;
    return withRule(prefix, width);
  }

  private renderMemberStrip(
    width: number,
    members: readonly AgentSwarmProgressMemberSnapshot[],
    pulseOn: boolean,
  ): string[] {
    if (members.length === 0) return [];

    const initialPrefix = '    ';
    const continuationPrefix = '    ';
    const availableWidth = Math.max(1, width - visibleWidth(initialPrefix));
    const markersPerLine = Math.max(1, Math.floor((availableWidth + 1) / MEMBER_STRIP_GAP_WIDTH));
    const lines: string[] = [];

    for (let index = 0; index < members.length; index += markersPerLine) {
      const chunk = members
        .slice(index, index + markersPerLine)
        .map((member) => phaseMarker(member.phase, pulseOn))
        .join(' ');
      lines.push(`${index === 0 ? initialPrefix : continuationPrefix}${chunk}`);
    }

    return lines;
  }

  private renderDetailedMembers(
    width: number,
    members: readonly AgentSwarmProgressMemberSnapshot[],
    pulseOn: boolean,
  ): string[] {
    const visibleMembers =
      members.length <= MAX_DETAILED_MEMBERS
        ? members
        : members
            .toSorted((a, b) => phasePriority(a.phase) - phasePriority(b.phase) || a.id.localeCompare(b.id))
            .slice(0, MAX_DETAILED_MEMBERS);
    const lines = visibleMembers.map((member) => this.renderMemberLine(width, member, pulseOn));

    if (members.length > visibleMembers.length) {
      const hidden = members.length - visibleMembers.length;
      lines.push(currentTheme.fg('textDim', truncateToWidth(`    ... ${hidden} more agents`, width, ELLIPSIS)));
    }

    return lines;
  }

  private renderMemberLine(
    width: number,
    member: AgentSwarmProgressMemberSnapshot,
    pulseOn: boolean,
  ): string {
    const marker = phaseMarker(member.phase, pulseOn);
    const id = currentTheme.fg('primary', member.id);
    const phase = currentTheme.fg(phaseColor(member.phase), phaseLabel(member.phase).padEnd(PHASE_LABEL_WIDTH));
    const itemLabel = cleanText(member.itemText);
    const modelLabel = cleanText(member.latestModelText);
    const label =
      itemLabel.length > 0
        ? itemLabel
        : modelLabel.length > 0
          ? modelLabel
          : member.agentId ?? 'worker';
    const prefix = `    ${marker} ${id} ${phase} `;
    const labelWidth = Math.max(1, width - visibleWidth(prefix));
    return prefix + currentTheme.fg('text', truncateToWidth(label, labelWidth, ELLIPSIS));
  }
}

function withRule(prefix: string, width: number): string {
  const ruleWidth = Math.max(0, width - visibleWidth(prefix));
  return truncateToWidth(prefix + currentTheme.fg('border', '-'.repeat(ruleWidth)), width, ELLIPSIS);
}

function phaseMarker(phase: AgentSwarmProgressPhase, pulseOn: boolean): string {
  switch (phase) {
    case 'running':
      return currentTheme.fg(pulseOn ? 'success' : 'textMuted', '●');
    case 'completed':
      return currentTheme.fg('success', '✓');
    case 'failed':
      return currentTheme.fg('error', '×');
    case 'suspended':
      return currentTheme.fg('warning', '!');
    case 'cancelled':
      return currentTheme.fg('warning', '-');
    case 'pending':
    case 'queued':
      return currentTheme.fg('textMuted', '○');
  }
}

function phaseLabel(phase: AgentSwarmProgressPhase): string {
  if (phase === 'pending') return 'queued';
  return phase;
}

function phaseColor(phase: AgentSwarmProgressPhase): ColorToken {
  switch (phase) {
    case 'running':
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'suspended':
    case 'cancelled':
      return 'warning';
    case 'pending':
    case 'queued':
      return 'textDim';
  }
}

function phasePriority(phase: AgentSwarmProgressPhase): number {
  switch (phase) {
    case 'running':
      return 0;
    case 'suspended':
      return 1;
    case 'failed':
      return 2;
    case 'pending':
    case 'queued':
      return 3;
    case 'cancelled':
      return 4;
    case 'completed':
      return 5;
  }
}

function cleanText(value: string | undefined): string {
  return (value ?? '').replaceAll(/\s+/g, ' ').trim();
}
