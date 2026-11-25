import { Key, matchesKey, type Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';

import {
  ScreenTakeoverView,
  fitLineExactly,
  handleScrollViewerKey,
  scrollFooterHints,
  type FramedScrollPane,
} from '#/tui/components/chrome/screen-takeover-view';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type {
  SubagentActivityRecord,
  SubToolCallActivity,
} from '#/tui/controllers/subagent-activity-store';
import { currentTheme, type ColorPalette } from '#/tui/theme';
import type { ToolCallBlockData } from '#/tui/types';

import { AssistantMessageComponent } from '../messages/assistant-message';
import { ThinkingComponent } from '../messages/thinking';
import { extractKeyArgument } from '../messages/tool-call';
import { pickChip } from '../messages/tool-renderers/chip';
import { pickResultRenderer } from '../messages/tool-renderers/registry';
import { STATUS_LABEL, statusColor } from './task-output-viewer';

export interface AgentActivityViewerProps {
  readonly taskId: string;
  readonly info: BackgroundTaskInfo | undefined;
  readonly record: SubagentActivityRecord | undefined;
  readonly onClose: () => void;
}

type FooterAction = 'toggle-expand' | 'close';

export class AgentActivityViewer extends ScreenTakeoverView {
  private props: AgentActivityViewerProps;
  private expanded = false;
  private lines: string[] = [];
  private lastCacheKey = '';
  private lastPalette: ColorPalette | undefined;
  private readonly pane: FramedScrollPane;

  constructor(props: AgentActivityViewerProps, terminal: Terminal) {
    super(terminal);
    this.props = props;
    this.pane = this.mountSinglePane<FooterAction>({
      follow: 'end',
      initialPosition: 'end',
      renderHeader: (width) => this.renderHeader(width),
      renderContent: (width) => this.renderContent(width),
      footerHints: () =>
        scrollFooterHints('PgUp/PgDn', 'Q/Esc', 'close', [
          {
            key: 'Ctrl+O',
            label: this.expanded ? 'collapse' : 'expand',
            action: 'toggle-expand',
          },
        ]),
      onFooterAction: (action) => {
        if (action === 'toggle-expand') {
          this.toggleExpanded();
          return;
        }
        this.props.onClose();
      },
    });
  }

  setProps(next: AgentActivityViewerProps): void {
    this.props = next;
    this.lastCacheKey = '';
    this.invalidate();
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.lastCacheKey = '';
    this.invalidate();
  }

  handleInput(data: string): void {
    const handled = handleScrollViewerKey(this.pane.scrollView, data, {
      onClose: () => this.props.onClose(),
      onExtraKey: (input) => {
        if (!matchesKey(input, Key.ctrl('o'))) return false;
        this.toggleExpanded();
        return true;
      },
    });
    if (handled) this.invalidate();
  }

  private cacheKey(innerWidth: number): string {
    const record = this.props.record;
    return [
      String(innerWidth),
      this.expanded ? 'x' : 'c',
      record?.agentId ?? '',
      String(record?.version ?? -1),
      String(this.props.info?.detached ?? ''),
    ].join('|');
  }

  private renderContent(width: number): string[] {
    const innerWidth = Math.max(1, width);
    const key = this.cacheKey(innerWidth);
    const palette = currentTheme.palette;
    if (key !== this.lastCacheKey || palette !== this.lastPalette) {
      this.lines = this.buildLines(innerWidth).map((raw) => fitLineExactly(raw, innerWidth));
      this.lastCacheKey = key;
      this.lastPalette = palette;
    }
    return this.lines;
  }

  private buildLines(innerWidth: number): string[] {
    const record = this.props.record;
    if (record === undefined) {
      const message =
        this.props.info?.detached === false ? 'Waiting for activity…' : '[no activity recorded]';
      return [currentTheme.dim(`${MESSAGE_INDENT}${message}`)];
    }

    const out: string[] = [];
    for (const step of record.steps) {
      out.push(currentTheme.dim(`── step ${String(step.step)} ──`));
      if (step.retrying !== undefined) {
        out.push(currentTheme.fg('warning', `${MESSAGE_INDENT}↻ ${step.retrying}`));
      }
      if (step.thinkingTail !== undefined && step.thinkingTail.trim().length > 0) {
        const thinking = new ThinkingComponent(step.thinkingTail);
        out.push(
          currentTheme.dim(`${MESSAGE_INDENT}Thinking`),
          ...thinking.renderRowDetail(innerWidth),
        );
      }
      if (step.textTail.trim().length > 0) {
        const message = new AssistantMessageComponent();
        message.updateContent(step.textTail);
        out.push(...message.render(innerWidth));
      }
      for (const call of step.toolCalls) {
        out.push(this.buildToolCallHeader(call));
        out.push(...this.renderToolCallBody(call, innerWidth));
      }
      out.push('');
    }

    if (record.error !== undefined && record.error.length > 0) {
      out.push(currentTheme.fg('error', 'Failed'));
      const message = new AssistantMessageComponent();
      message.updateContent(record.error);
      out.push(...message.render(innerWidth));
    } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
      out.push(currentTheme.boldFg('primary', 'Result'));
      const message = new AssistantMessageComponent();
      message.updateContent(record.resultSummary);
      out.push(...message.render(innerWidth));
    }

    if (out.length === 0 && record.status === 'running') {
      out.push(currentTheme.dim(`${MESSAGE_INDENT}Waiting for activity…`));
    }
    return out;
  }

  private buildToolCallHeader(call: SubToolCallActivity): string {
    let bullet: string;
    if (call.status === 'error') {
      bullet = currentTheme.fg('error', '✗ ');
    } else if (call.status === 'done') {
      bullet = currentTheme.fg('success', STATUS_BULLET);
    } else {
      bullet = currentTheme.fg('text', STATUS_BULLET);
    }
    const verb = call.status === 'running' ? 'Using' : 'Used';
    const name = currentTheme.boldFg('primary', call.name);
    const keyArg = extractKeyArgument(call.name, call.args);
    const argStr = keyArg === null || keyArg.length === 0 ? '' : currentTheme.dim(` (${keyArg})`);

    let chipStr = '';
    if (call.result !== undefined) {
      const provider = pickChip(call.name);
      const text = provider?.(this.toToolCallBlockData(call), call.result) ?? '';
      if (text.length > 0) {
        chipStr =
          call.result.is_error === true
            ? currentTheme.fg('error', ` · ${text}`)
            : currentTheme.dim(` · ${text}`);
      }
    }
    return `${bullet}${verb} ${name}${argStr}${chipStr}`;
  }

  private renderToolCallBody(call: SubToolCallActivity, innerWidth: number): string[] {
    if (call.result === undefined) {
      return call.liveOutputTail === undefined || call.liveOutputTail.length === 0
        ? []
        : [currentTheme.dim(`${MESSAGE_INDENT}│ ${call.liveOutputTail}`)];
    }
    if (call.name === 'ReadMediaFile' && call.result.is_error !== true) {
      return [currentTheme.dim(`${MESSAGE_INDENT}[media output omitted]`)];
    }
    const components = pickResultRenderer(call.name)(
      this.toToolCallBlockData(call),
      call.result,
      { expanded: this.expanded },
    );
    const out: string[] = [];
    for (const component of components) {
      out.push(...component.render(innerWidth));
    }
    return out;
  }

  private toToolCallBlockData(call: SubToolCallActivity): ToolCallBlockData {
    return { id: call.id, name: call.name, args: call.args };
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ' Agent activity ');
    const record = this.props.record;
    const info = this.props.info;
    const segments: string[] = [];

    if (record !== undefined) {
      const label =
        record.description !== undefined && record.description.length > 0
          ? `${record.agentName} › ${record.description}`
          : record.agentName;
      segments.push(currentTheme.boldFg('text', label));
    } else {
      segments.push(currentTheme.boldFg('text', this.props.taskId));
    }
    const status = info?.status ?? record?.status;
    if (status === 'cancelled') {
      segments.push(currentTheme.fg('error', 'cancelled'));
    } else if (status !== undefined) {
      segments.push(currentTheme.fg(statusColor(status), STATUS_LABEL[status]));
    }
    if (record !== undefined && record.steps.length > 0) {
      const from = record.steps[0]!.step;
      const to = record.steps.at(-1)!.step;
      let range = `step ${String(from)}–${String(to)} / ${String(record.totalSteps)}`;
      if (record.totalSteps > record.steps.length) range += ' · earlier steps discarded';
      segments.push(currentTheme.fg('textMuted', range));
    }

    const composed = title + segments.join('  ');
    return fitLineExactly(composed, width);
  }
}

export function formatSubagentActivityPreview(record: SubagentActivityRecord): string {
  const lines: string[] = [];
  for (const step of record.steps) {
    lines.push(`── step ${String(step.step)} ──`);
    if (step.retrying !== undefined) lines.push(`${MESSAGE_INDENT}↻ ${step.retrying}`);
    if (step.textTail.trim().length > 0) lines.push(...step.textTail.trimEnd().split('\n'));
    for (const call of step.toolCalls) {
      lines.push(formatPreviewToolCall(call));
      if (
        call.result === undefined &&
        call.liveOutputTail !== undefined &&
        call.liveOutputTail.length > 0
      ) {
        lines.push(`${MESSAGE_INDENT}│ ${call.liveOutputTail}`);
      }
    }
  }
  if (record.error !== undefined && record.error.length > 0) {
    lines.push('Failed:', ...record.error.trimEnd().split('\n'));
  } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
    lines.push('Result:', ...record.resultSummary.trimEnd().split('\n'));
  }
  if (lines.length === 0) {
    return record.status === 'running' ? 'Waiting for activity…' : '';
  }
  return lines.join('\n');
}

function formatPreviewToolCall(call: SubToolCallActivity): string {
  const mark = call.status === 'done' ? '✓' : call.status === 'error' ? '✗' : '●';
  const verb = call.status === 'running' ? 'Using' : 'Used';
  const keyArg = extractKeyArgument(call.name, call.args);
  const argStr = keyArg === null || keyArg.length === 0 ? '' : ` (${keyArg})`;

  let chip = '';
  if (call.result !== undefined) {
    const callData: ToolCallBlockData = { id: call.id, name: call.name, args: call.args };
    const text = pickChip(call.name)?.(callData, call.result) ?? '';
    if (text.length > 0) chip = ` · ${text}`;
  }
  return `${mark} ${verb} ${call.name}${argStr}${chip}`;
}
