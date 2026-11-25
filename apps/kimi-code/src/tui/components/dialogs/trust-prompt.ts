import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import type { WorkspaceTrustInfo } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { ListMouseTracker } from '#/tui/utils/mouse-regions';
import { pageView } from '#/tui/utils/paging';

export type TrustPromptChoice = 'trust' | 'distrust';

export interface TrustPromptOptions {
  readonly info: WorkspaceTrustInfo;
  readonly getAvailableRows?: () => number;
  readonly onSelect: (choice: TrustPromptChoice) => void;
}

const OPTIONS: readonly { value: TrustPromptChoice; label: string }[] = [
  { value: 'trust', label: 'Trust and continue' },
  { value: 'distrust', label: 'Exit' },
];

export class TrustPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;
  private disclosureIndex = 0;
  private disclosurePageSize = 1;
  private disclosureBodyLength = 0;
  private canConfirm = true;
  private readonly mouse = new ListMouseTracker<number>();

  constructor(private readonly opts: TrustPromptOptions) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onSelect('distrust');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(OPTIONS.length - 1, this.selectedIndex + 1);
      return;
    }
    const previousPage = matchesKey(data, Key.left) || matchesKey(data, Key.pageUp);
    const nextPage = matchesKey(data, Key.right) || matchesKey(data, Key.pageDown);
    if (previousPage || nextPage) {
      this.disclosureIndex = Math.max(
        0,
        this.disclosureIndex + (previousPage ? -1 : 1) * this.disclosurePageSize,
      );
      return;
    }
    if (this.canConfirm && (matchesKey(data, Key.enter) || matchesKey(data, Key.space))) {
      this.opts.onSelect(OPTIONS[this.selectedIndex]!.value);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.mouse.handle(event, {
      focused: this.focused,
      canActivate: this.canConfirm,
      onWheel: (delta) => (delta === 0 ? false : this.pageDisclosure(delta < 0 ? -1 : 1)),
      onHover: (index) => {
        if (this.selectedIndex === index) return false;
        this.selectedIndex = index;
        return true;
      },
      onActivate: (index) => {
        this.selectedIndex = index;
        const option = OPTIONS[index];
        if (option !== undefined) this.opts.onSelect(option.value);
      },
    });
  }

  private pageDisclosure(direction: -1 | 1): boolean {
    if (this.disclosureBodyLength <= this.disclosurePageSize) return false;
    const current = pageView(this.disclosureBodyLength, this.disclosureIndex, this.disclosurePageSize);
    const nextPage = Math.max(0, Math.min(current.pageCount - 1, current.page + direction));
    if (nextPage === current.page) return false;
    this.disclosureIndex = nextPage * Math.max(1, Math.floor(this.disclosurePageSize));
    return true;
  }

  render(width: number): string[] {
    this.mouse.reset();
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const availableRows = Math.max(0, Math.floor(this.opts.getAvailableRows?.() ?? Infinity));
    const header = [
      rule,
      currentTheme.boldFg('primary', ' Trust this project?'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc exit'),
      '',
    ];
    const body = [
      ...wrap(this.opts.info.projectRoot, 1, width, 'textStrong'),
      '',
      ...this.renderDisclosure(width),
    ];
    const footer = [
      ...wrap(
        'Trust is remembered for this project, including future project config changes.',
        1,
        width,
        'textMuted',
      ),
      ...wrap('Tool approvals follow your permission settings.', 1, width, 'textMuted'),
      '',
    ];
    const optionRows: number[] = [];
    for (const [i, option] of OPTIONS.entries()) {
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const label = selected
        ? currentTheme.boldFg('primary', option.label)
        : currentTheme.fg('text', option.label);
      optionRows.push(footer.length);
      footer.push(currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) + label);
    }
    footer.push(rule);
    this.canConfirm = header.length + footer.length + 2 <= availableRows;
    if (!this.canConfirm) {
      this.disclosureBodyLength = 0;
      return [header[1]!, ' Enlarge terminal to review sources. Esc exit.']
        .slice(0, availableRows)
        .map((line) => truncateToWidth(line, width));
    }
    this.disclosureBodyLength = body.length;
    const needsPaging = header.length + body.length + footer.length > availableRows;
    this.disclosurePageSize = needsPaging
      ? availableRows - header.length - footer.length - 1
      : body.length;
    const page = pageView(body.length, this.disclosureIndex, this.disclosurePageSize);
    this.disclosureIndex = page.start;
    const lines = [...header, ...body.slice(page.start, page.end)];
    while (lines.length < header.length + this.disclosurePageSize) lines.push('');
    if (page.pageCount > 1)
      lines.push(currentTheme.fg('textMuted', ` ←→ page · ${page.page + 1} / ${page.pageCount}`));
    for (const [i, row] of optionRows.entries()) {
      this.mouse.add(lines.length + row, lines.length + row + 1, i);
    }
    lines.push(...footer);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderDisclosure(width: number): string[] {
    const {
      gatedMcpServers,
      gatedAdditionalDirs,
      additionalDirSources,
      instructionSources,
      warnings,
    } = this.opts.info;
    const lines: string[] = [];
    if (gatedMcpServers.length > 0) {
      lines.push(
        ...wrap(
          `Start ${gatedMcpServers.length} MCP ${
            gatedMcpServers.length === 1 ? 'server' : 'servers'
          } automatically`,
          1,
          width,
          'warning',
        ),
      );
      const origins = [...new Set(gatedMcpServers.map((server) => server.origin))];
      lines.push(
        ...wrap(
          `Config: ${origins.map((path) => relativize(this.opts.info.projectRoot, path)).join(', ')}`,
          3,
          width,
          'textMuted',
        ),
        '',
      );
    }
    if (gatedAdditionalDirs.length > 0) {
      lines.push(
        ...wrap(
          `Access ${gatedAdditionalDirs.length} ${
            gatedAdditionalDirs.length === 1 ? 'folder' : 'folders'
          } outside this project`,
          1,
          width,
          'warning',
        ),
      );
      if (additionalDirSources.length > 0) {
        lines.push(
          ...wrap(
            `Config: ${additionalDirSources
              .map((path) => relativize(this.opts.info.projectRoot, path))
              .join(', ')}`,
            3,
            width,
            'textMuted',
          ),
        );
      }
      lines.push('');
    }
    if (instructionSources.paths.length > 0) {
      const hasInstructions =
        instructionSources.agentsMdPaths.length > 0 || instructionSources.skills.length > 0;
      const subject = hasInstructions
        ? instructionSources.agentProfiles.length > 0
          ? 'instructions and agent profiles'
          : 'instructions'
        : 'agent profiles';
      lines.push(...wrap(`Load project ${subject}`, 1, width, 'text'));
      lines.push(
        ...wrap(
          `Check: ${instructionSources.paths.map((path) => relativize(this.opts.info.projectRoot, path)).join(' · ')}`,
          3,
          width,
          'textMuted',
        ),
        '',
      );
    }
    for (const warning of warnings) lines.push(...wrap(warning, 1, width, 'warning'));
    if (lines.length === 0)
      lines.push(
        ...wrap('No project integrations or instructions to activate.', 1, width, 'textMuted'),
        '',
      );
    return lines;
  }
}

function wrap(text: string, indent: number, width: number, color: ColorToken): string[] {
  return wrapTextWithAnsi(sanitizeForDisplay(text), Math.max(1, width - indent)).map(
    (line) => `${' '.repeat(indent)}${currentTheme.fg(color, line)}`,
  );
}

function relativize(projectRoot: string, path: string): string {
  const normalizedDir = projectRoot.replaceAll('\\', '/');
  const normalizedPath = path.replaceAll('\\', '/');
  const prefix = normalizedDir.endsWith('/') ? normalizedDir : `${normalizedDir}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function sanitizeForDisplay(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    result += char;
  }
  return result;
}
