import type { Component } from '@moonshot-ai/pi-tui';

import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { SkillActivationComponent } from '#/tui/components/messages/skill-activation';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent, extractKeyArgumentDetail } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import {
  chipText,
  computeEditStats,
  computeWriteStats,
} from '#/tui/components/messages/tool-renderers/chip';
import { parseWaitForOutput } from '#/tui/components/messages/tool-renderers/wait-for';
import {
  DENSITY,
  transcriptGroupingActive,
  type ToolFolding,
  type TranscriptPresentationOptions,
} from '#/tui/config';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { MCP_AUTHENTICATE_TOOL_SUFFIX } from '#/tui/constant/mcp';
import { FOREGROUND_BASH_HINT_DELAY_MS } from '#/tui/constant/rendering';
import { STREAMING_ARGS_PREVIEW_MAX_CHARS, UNNAMED_TOOL_CALL_NAME } from '#/tui/constant/streaming';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';
import { isToolCallId, type ToolCallId } from '#/tui/utils/turn-timeline';
import { isReadonlyBash } from '#/utils/readonly-bash';

export interface OutcomeCounts {
  readonly calls: number;
  readonly failed: number;
  readonly interrupted: number;
}

export type SummaryEvent =
  | { readonly kind: 'thought'; readonly durationMs?: number }
  | { readonly kind: 'read'; readonly path: string; readonly outcome: OutcomeCounts }
  | { readonly kind: 'search'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'fetch'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'webSearch'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'skill'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'query'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'todo'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'command'; readonly outcome: OutcomeCounts }
  | {
      readonly kind: 'edit';
      readonly path: string;
      readonly added: number;
      readonly removed: number;
      readonly outcome: OutcomeCounts;
    }
  | { readonly kind: 'taskCheck'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'mcp'; readonly server: string; readonly outcome: OutcomeCounts }
  | { readonly kind: 'other'; readonly outcome: OutcomeCounts }
  | { readonly kind: 'silent'; readonly outcome: OutcomeCounts };

type FoldClass = 'thinking' | 'explore' | 'all' | 'never';

export type FoldTraits =
  | { readonly kind: FoldClass }
  | { readonly kind: 'command'; readonly argsComplete: boolean; readonly readonly: boolean }
  | { readonly kind: 'unnamed' };

export interface ItemLabel {
  readonly verb: string;
  readonly rowVerb: string;
  readonly subject?: string;
}

export type ItemStat =
  | { readonly kind: 'diff'; readonly added: number; readonly removed: number }
  | { readonly kind: 'note'; readonly text: string };

export type ItemStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'done'; readonly stat?: ItemStat };

export interface LogicalTranscriptItem {
  readonly kind: 'logical';
  readonly display: Component;
  readonly source: Component;
  readonly sourceIndex: number;
  readonly projectionVersion: number;
  readonly family: 'thinking' | 'tool';
  readonly fold: FoldTraits;
  readonly callId?: ToolCallId;
  readonly current: boolean;
  readonly detailWhile?: readonly ItemStatus['kind'][];
  readonly event: SummaryEvent;
  readonly label: ItemLabel;
  readonly status: ItemStatus;
}

export interface TransparentTranscriptItem {
  readonly kind: 'transparent';
  readonly display: Component;
  readonly source: Component;
  readonly sourceIndex: number;
  readonly projectionVersion: number;
}

export type BoundaryRole = 'text' | 'card' | 'pinned';

export interface BoundaryTranscriptItem {
  readonly kind: 'boundary';
  readonly display: Component;
  readonly source: Component;
  readonly sourceIndex: number;
  readonly projectionVersion: number;
  readonly role: BoundaryRole;
}

export type TranscriptItem =
  | LogicalTranscriptItem
  | BoundaryTranscriptItem
  | TransparentTranscriptItem;

interface ItemInspection {
  readonly version: number;
  readonly folding: ToolFolding;
  readonly items: readonly TranscriptItem[];
}

interface ToolProfile {
  readonly foldClass: FoldClass;
  readonly event: SummaryEvent['kind'];
  readonly detailWhile?: readonly ItemStatus['kind'][];
}

const TOOL_BOUNDARY_ROLES: Readonly<Record<string, BoundaryRole>> = {
  Agent: 'card',
  AgentSwarm: 'card',
  NotifyUser: 'pinned',
  AskUserQuestion: 'pinned',
  ExitPlanMode: 'pinned',
};

export function isPinnedToolCallComponent(component: Component): boolean {
  return (
    component instanceof ToolCallComponent &&
    TOOL_BOUNDARY_ROLES[component.toolCallView.name] === 'pinned'
  );
}

const TOOL_PROFILES: Readonly<Record<string, ToolProfile>> = {
  Think: { foldClass: 'thinking', event: 'thought' },
  Read: { foldClass: 'explore', event: 'read' },
  ReadMediaFile: { foldClass: 'explore', event: 'read' },
  Grep: { foldClass: 'explore', event: 'search' },
  Glob: { foldClass: 'explore', event: 'search' },
  FetchURL: { foldClass: 'explore', event: 'fetch' },
  WebSearch: { foldClass: 'explore', event: 'webSearch' },
  Skill: { foldClass: 'explore', event: 'skill' },
  TaskList: { foldClass: 'explore', event: 'query' },
  GetGoal: { foldClass: 'explore', event: 'query' },
  CronList: { foldClass: 'explore', event: 'query' },
  TodoList: { foldClass: 'explore', event: 'todo' },
  select_tools: { foldClass: 'explore', event: 'silent' },
  Bash: { foldClass: 'explore', event: 'command' },
  Edit: { foldClass: 'all', event: 'edit' },
  Write: { foldClass: 'all', event: 'edit' },
  WaitFor: { foldClass: 'all', event: 'taskCheck' },
  TaskOutput: { foldClass: 'all', event: 'taskCheck' },
  CronCreate: { foldClass: 'never', event: 'other' },
  CronDelete: { foldClass: 'never', event: 'other' },
};

const MCP_AUTHENTICATE_PROFILE: ToolProfile = {
  foldClass: 'never',
  event: 'mcp',
  detailWhile: ['running', 'failed'],
};
const SUCCESS: OutcomeCounts = { calls: 1, failed: 0, interrupted: 0 };
const LINE_COUNT_CHIP_TOOLS: ReadonlySet<string> = new Set(['Read', 'Bash']);
const INTERRUPTION_TEXT = [
  'The user manually interrupted "',
  'Interrupted by user',
  'was not run because the user rejected the approval request',
  'was not run because the approval request was cancelled',
] as const;

export function foregroundBashHintAt(
  children: readonly Component[],
  isFolded: (call: ToolCallComponent) => boolean,
): number | undefined {
  let earliest: number | undefined;
  for (const child of children) {
    if (!(child instanceof ToolCallComponent)) continue;
    const toolCall = child.toolCallView;
    if (
      toolCall.name !== 'Bash' ||
      toolCall.args['run_in_background'] === true ||
      toolCall.truncated === true ||
      child.toolResultView !== undefined ||
      !isFolded(child)
    ) {
      continue;
    }
    const hintAt = child.startedAtMs + FOREGROUND_BASH_HINT_DELAY_MS;
    earliest = earliest === undefined ? hintAt : Math.min(earliest, hintAt);
  }
  return earliest;
}

export function transcriptProjectionVersion(component: Component): number {
  if (
    component instanceof ThinkingComponent ||
    component instanceof ToolCallComponent ||
    component instanceof AssistantMessageComponent
  ) {
    return component.transcriptProjectionVersion;
  }
  if (
    component instanceof ReadGroupComponent ||
    component instanceof AgentGroupComponent ||
    component instanceof AgentSwarmProgressComponent
  ) {
    return component.transcriptProjectionVersion;
  }
  return 0;
}

function transparent(component: Component, sourceIndex: number): TransparentTranscriptItem {
  return {
    kind: 'transparent',
    display: component,
    source: component,
    sourceIndex,
    projectionVersion: transcriptProjectionVersion(component),
  };
}

function boundary(
  component: Component,
  sourceIndex: number,
  role: BoundaryRole = 'pinned',
): BoundaryTranscriptItem {
  return {
    kind: 'boundary',
    display: component,
    source: component,
    sourceIndex,
    projectionVersion: transcriptProjectionVersion(component),
    role,
  };
}

export function combineOutcomes(outcomes: readonly OutcomeCounts[]): OutcomeCounts {
  return outcomes.reduce(
    (total, outcome) => ({
      calls: total.calls + outcome.calls,
      failed: total.failed + outcome.failed,
      interrupted: total.interrupted + outcome.interrupted,
    }),
    { calls: 0, failed: 0, interrupted: 0 },
  );
}

export class TranscriptItemInspector {
  private readonly cache = new WeakMap<Component, ItemInspection>();

  read(
    children: readonly Component[],
    options: TranscriptPresentationOptions,
  ): readonly TranscriptItem[] {
    if (!transcriptGroupingActive(options)) {
      return children.map((child, index) => boundary(child, index));
    }
    const { folding } = DENSITY[options.toolCallDensity];
    return children.flatMap((child, index) => this.cached(child, index, folding));
  }

  private cached(
    component: Component,
    sourceIndex: number,
    folding: ToolFolding,
  ): readonly TranscriptItem[] {
    if (component instanceof UserMessageComponent) return [boundary(component, sourceIndex, 'text')];
    if (folding !== 'none' && component instanceof SkillActivationComponent && component.loadedByModel) {
      return [transparent(component, sourceIndex)];
    }
    if (
      !(component instanceof ThinkingComponent) &&
      !(component instanceof ToolCallComponent) &&
      !(component instanceof AssistantMessageComponent) &&
      !(component instanceof ReadGroupComponent) &&
      !(component instanceof AgentGroupComponent) &&
      !(component instanceof AgentSwarmProgressComponent)
    ) {
      return [boundary(component, sourceIndex)];
    }
    const version = transcriptProjectionVersion(component);
    const cached = this.cache.get(component);
    if (cached?.version === version && cached.folding === folding) {
      return cached.items.map((item) => ({ ...item, sourceIndex }));
    }
    let items: readonly TranscriptItem[];
    if (component instanceof AssistantMessageComponent) {
      items = component.hasVisibleContent
        ? [boundary(component, sourceIndex, 'text')]
        : [transparent(component, sourceIndex)];
    }
    else if (component instanceof ThinkingComponent) items = [this.inspectThinking(component, sourceIndex)];
    else if (component instanceof ToolCallComponent) {
      const role = TOOL_BOUNDARY_ROLES[component.toolCallView.name];
      items = role === undefined
        ? [this.inspectTool(component, sourceIndex)]
        : [boundary(component, sourceIndex, role)];
    }
    else if (component instanceof ReadGroupComponent) items = this.inspectReadGroup(component, sourceIndex, folding);
    else items = [boundary(component, sourceIndex, 'card')];
    this.cache.set(component, { version, folding, items });
    return items.map((item) => ({ ...item, sourceIndex }));
  }

  private inspectThinking(component: ThinkingComponent, sourceIndex: number): LogicalTranscriptItem {
    const elapsed = component.thinkingElapsed;
    const durationMs = elapsed?.known === true ? elapsed.ms : undefined;
    return {
      kind: 'logical',
      display: component,
      source: component,
      sourceIndex,
      projectionVersion: component.transcriptProjectionVersion,
      family: 'thinking',
      fold: { kind: 'thinking' },
      current: elapsed === undefined,
      event: { kind: 'thought', durationMs },
      label: {
        verb: 'Thought',
        rowVerb: 'Thought',
        subject: durationMs === undefined ? undefined : `for ${formatDuration(durationMs)}`,
      },
      status: elapsed === undefined ? { kind: 'running' } : { kind: 'done' },
    };
  }

  private inspectTool(component: ToolCallComponent, sourceIndex: number): LogicalTranscriptItem {
    const profile = this.profileFor(component);
    const outcome = this.inspectOutcome(component);
    const current = this.isCurrent(component);
    const toolCall = component.toolCallView;
    const event = this.inspectEvent(component, profile, outcome);
    return {
      kind: 'logical',
      display: component,
      source: component,
      sourceIndex,
      projectionVersion: component.transcriptProjectionVersion,
      family: profile.foldClass === 'thinking' ? 'thinking' : 'tool',
      fold: foldTraits(toolCall, profile),
      callId: isToolCallId(toolCall.id) ? toolCall.id : undefined,
      current,
      detailWhile: profile.detailWhile,
      event,
      label: toolLabel(component),
      status: current ? { kind: 'running' } : finishedStatus(outcome, toolStat(component, event)),
    };
  }

  private inspectReadGroup(
    component: ReadGroupComponent,
    sourceIndex: number,
    folding: ToolFolding,
  ): readonly TranscriptItem[] {
    const tools = component.getToolComponents();
    if (folding !== 'none') return tools.map((tool) => this.inspectTool(tool, sourceIndex));
    const first = tools[0];
    const outcome = combineOutcomes(tools.map((tool) => this.inspectOutcome(tool)));
    const path = first?.getReadSnapshot().filePath ?? first?.toolCallView.id ?? '';
    const running = tools.find((tool) => this.isCurrent(tool));
    return [{
      kind: 'logical',
      display: component,
      source: component,
      sourceIndex,
      projectionVersion: component.transcriptProjectionVersion,
      family: 'tool',
      fold: { kind: 'explore' },
      current: running !== undefined,
      event: { kind: 'read', path, outcome },
      label: { verb: 'Read', rowVerb: 'Read', subject: nonEmpty(path) },
      status: running === undefined ? finishedStatus(outcome, undefined) : { kind: 'running' },
    }];
  }

  private profileFor(component: ToolCallComponent): ToolProfile {
    const name = component.toolCallView.name;
    const profile = TOOL_PROFILES[name];
    if (profile !== undefined) return profile;
    if (name.startsWith('mcp__') && name.endsWith(MCP_AUTHENTICATE_TOOL_SUFFIX)) return MCP_AUTHENTICATE_PROFILE;
    if (name.startsWith('mcp__')) return { foldClass: 'all', event: 'mcp' };
    return { foldClass: 'all', event: 'other' };
  }

  private isCurrent(component: ToolCallComponent): boolean {
    const toolCall = component.toolCallView;
    return component.toolResultView === undefined && !toolCall.truncated;
  }

  private inspectEvent(
    component: ToolCallComponent,
    profile: ToolProfile,
    outcome: OutcomeCounts,
  ): SummaryEvent {
    const toolCall = component.toolCallView;
    const path = component.getReadSnapshot().filePath ?? toolCall.id;
    switch (profile.event) {
      case 'thought': {
        const elapsed = component.toolElapsed;
        return {
          kind: 'thought',
          durationMs: elapsed?.known === true ? elapsed.ms : undefined,
        };
      }
      case 'read': return { kind: 'read', path, outcome };
      case 'search': return { kind: 'search', outcome };
      case 'fetch': return { kind: 'fetch', outcome };
      case 'webSearch': return { kind: 'webSearch', outcome };
      case 'skill': return { kind: 'skill', outcome };
      case 'query': return { kind: 'query', outcome };
      case 'todo': return { kind: 'todo', outcome };
      case 'command': return { kind: 'command', outcome };
      case 'edit': {
        const stats = toolCall.name === 'Write'
          ? { added: computeWriteStats(toolCall.args).lines, removed: 0 }
          : computeEditStats(toolCall.args);
        return { kind: 'edit', path, ...stats, outcome };
      }
      case 'taskCheck': return { kind: 'taskCheck', outcome };
      case 'mcp': return { kind: 'mcp', server: toolCall.name.split('__')[1] ?? 'unknown', outcome };
      case 'other': return { kind: 'other', outcome };
      case 'silent': return { kind: 'silent', outcome };
    }
  }

  private inspectOutcome(component: ToolCallComponent): OutcomeCounts {
    const result = component.toolResultView;
    if (result === undefined) return SUCCESS;
    if (result.is_error === true && isInterruptedOutput(result.output)) {
      return { calls: 1, failed: 0, interrupted: 1 };
    }
    if (result.is_error === true) return { calls: 1, failed: 1, interrupted: 0 };
    if (component.toolCallView.name === 'TaskOutput' && taskOutputFailed(result)) {
      return { calls: 1, failed: 1, interrupted: 0 };
    }
    if (component.toolCallView.name === 'WaitFor') {
      const waitStatus = parseWaitForOutput(result.output)?.finishedStatus;
      if (waitStatus !== undefined && waitStatus !== 'completed') {
        return { calls: 1, failed: 1, interrupted: 0 };
      }
    }
    return SUCCESS;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

function foldTraits(toolCall: Readonly<ToolCallBlockData>, profile: ToolProfile): FoldTraits {
  const argsComplete = argumentsComplete(toolCall.streamingArguments);
  if (profile.event === 'command') {
    const command = toolCall.args['command'];
    return {
      kind: 'command',
      argsComplete,
      readonly: argsComplete && isReadonlyBash(typeof command === 'string' ? command : ''),
    };
  }
  if (!argsComplete && toolCall.name === UNNAMED_TOOL_CALL_NAME) return { kind: 'unnamed' };
  return { kind: profile.foldClass };
}

function argumentsComplete(streamed: string | undefined): boolean {
  if (streamed === undefined) return true;
  if (streamed.length > STREAMING_ARGS_PREVIEW_MAX_CHARS || !streamed.trimEnd().endsWith('}')) return false;
  try {
    const parsed: unknown = JSON.parse(streamed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function finishedStatus(outcome: OutcomeCounts, stat: ItemStat | undefined): ItemStatus {
  if (outcome.interrupted > 0) return { kind: 'interrupted' };
  if (outcome.failed > 0) return { kind: 'failed' };
  return { kind: 'done', stat };
}

function toolStat(component: ToolCallComponent, event: SummaryEvent): ItemStat | undefined {
  const result = component.toolResultView;
  if (result === undefined) return undefined;
  if (event.kind === 'edit') {
    return event.added + event.removed === 0
      ? undefined
      : { kind: 'diff', added: event.added, removed: event.removed };
  }
  const toolCall = component.toolCallView;
  if (LINE_COUNT_CHIP_TOOLS.has(toolCall.name)) return undefined;
  const text = chipText(toolCall, result);
  return text.length === 0 ? undefined : { kind: 'note', text };
}

function toolLabel(component: ToolCallComponent): ItemLabel {
  const { name, args } = component.toolCallView;
  const path = nonEmpty(component.getReadSnapshot().filePath);
  const argument = (key: string): string | undefined => nonEmpty(args[key]);
  const label = (verb: string, subject?: string): ItemLabel => ({ verb, rowVerb: verb, subject });
  const taskId = argument('task_id');
  switch (name) {
    case 'Read': return label('Read', path);
    case 'ReadMediaFile': return label('View', path);
    case 'Grep': {
      const pattern = argument('pattern');
      if (pattern === undefined) return label('Search');
      return label('Search', `"${pattern}"${path === undefined ? '' : ` in ${path}`}`);
    }
    case 'Glob': return label('Find', argument('pattern'));
    case 'Bash': return { verb: '$', rowVerb: 'Bash', subject: argument('command') };
    case 'Edit': return label('Edit', path);
    case 'Write': return label('Write', path);
    case 'TodoList': {
      const title = activeTodoTitle(args['todos']);
      return label('Update todos', title === undefined ? undefined : `· ${title}`);
    }
    case 'Skill': return label('Load skill', argument('skill'));
    case 'WebSearch': {
      const query = argument('query');
      return label('Search web', query === undefined ? undefined : `"${query}"`);
    }
    case 'FetchURL': return label('Fetch', nonEmpty(argument('url')?.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')));
    case 'WaitFor': return label('Wait for', taskId ?? 'any task');
    case 'TaskOutput': return label('Read output', taskId === undefined ? undefined : `of ${taskId}`);
    case 'TaskList': return label('List tasks');
    default: {
      const decoded = decodeMcpToolName(name);
      if (decoded !== null) return label(`${decoded.serverName}:`, decoded.toolName);
      return label(name, nonEmpty(extractKeyArgumentDetail(name, args)?.text));
    }
  }
}

function activeTodoTitle(todos: unknown): string | undefined {
  if (!Array.isArray(todos)) return undefined;
  const active: unknown = todos.find((todo) => {
    if (typeof todo !== 'object' || todo === null) return false;
    return 'status' in todo && todo.status === 'in_progress' &&
      'title' in todo && typeof todo.title === 'string';
  });
  return typeof active === 'object' && active !== null && 'title' in active
    ? nonEmpty(active.title)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isInterruptedOutput(output: string): boolean {
  return INTERRUPTION_TEXT.some((text) => output.includes(text)) ||
    /Tool ".+" was aborted/.test(output) ||
    /User tool ".+" was aborted\./.test(output);
}

function taskOutputFailed(result: ToolResultBlockData): boolean {
  const header = result.output.split('[output]', 1)[0] ?? '';
  return /^status:\s*(?:failed|timed_out|killed|lost)\s*$/m.test(header);
}
