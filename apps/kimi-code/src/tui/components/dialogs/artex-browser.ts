import {
  Container,
  Key,
  matchesKey,
  type Focusable,
  type Terminal,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

export type ArtexBrowserTab = 'graph' | 'findings' | 'assets' | 'traffic' | 'coverage';

const TAB_LABELS: Record<ArtexBrowserTab, string> = {
  graph: 'Graph',
  findings: 'Findings',
  assets: 'Assets/Scope',
  traffic: 'Traffic',
  coverage: 'Coverage',
};

const TABS: readonly ArtexBrowserTab[] = [
  'graph',
  'findings',
  'assets',
  'traffic',
  'coverage',
];

export interface ArtexBrowserProps {
  readonly tab: ArtexBrowserTab;
  readonly summary: string;
  readonly detail: string;
  readonly statusLine: string;
  readonly onTab: (tab: ArtexBrowserTab) => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

export class ArtexBrowserApp extends Container implements Focusable {
  focused = false;

  private props: ArtexBrowserProps;
  private readonly terminal: Terminal;

  constructor(props: ArtexBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
  }

  setProps(props: ArtexBrowserProps): void {
    this.props = props;
    this.invalidate();
  }

  handleInput(data: string): void {
    const key = printableChar(data);
    if (key === undefined) {
      if (matchesKey(data, Key.escape)) {
        this.props.onClose();
      }
      return;
    }
    if (key === 'q' || key === 'Q') {
      this.props.onClose();
      return;
    }
    if (key === 'r' || key === 'R') {
      this.props.onRefresh();
      return;
    }
    const index = Number(key) - 1;
    if (index >= 0 && index < TABS.length) {
      this.props.onTab(TABS[index]!);
    }
  }

  override render(width: number): string[] {
    const theme = currentTheme;
    const rows = Math.max(1, this.terminal.rows);
    const lines: string[] = [];
    lines.push(theme.boldFg('text', 'ARTEX dashboard'));
    lines.push(this.props.statusLine);
    const tabRow = TABS.map((tab, index) => {
      const active = tab === this.props.tab;
      const label = `${index + 1}:${TAB_LABELS[tab]}`;
      return active ? theme.fg('primary', label) : theme.fg('textMuted', label);
    }).join('  ');
    lines.push(tabRow);
    lines.push('');
    lines.push(theme.boldFg('text', TAB_LABELS[this.props.tab]));
    lines.push(this.props.summary);
    lines.push('');
    const detailBudget = Math.max(0, rows * width - lines.join('\n').length - 80);
    lines.push(this.props.detail.slice(0, detailBudget));
    lines.push('');
    lines.push(theme.fg('textMuted', '1-5 tab · r refresh · Esc/Q close'));
    while (lines.length < rows) lines.push('');
    return lines.slice(0, rows);
  }
}