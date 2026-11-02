import type { Component } from '@moonshot-ai/pi-tui';

import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent, extractKeyArgumentDetail } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import {
  computeEditStats,
  computeWriteStats,
} from '#/tui/components/messages/tool-renderers/chip';
import { parseWaitForOutput } from '#/tui/components/messages/tool-renderers/wait-for';
import {
  transcriptGroupingActive,
  type TranscriptGroupTools,
  type TranscriptPresentationOptions,
} from '#/tui/config';
import type { ToolResultBlockData } from '#/tui/types';
import { FOREGROUND_BASH_HINT_DELAY_MS } from '#/tui/constant/rendering';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';
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

export type FoldClass = 'thinking' | 'explore' | 'all';

export interface TranscriptTail {
  readonly text: string;
  readonly startedAtMs: number;
}

export interface LogicalTranscriptItem {
  readonly kind: 'logical';
  readonly display: Component;
  readonly source: Component;
  readonly sourceIndex: number;
  readonly projectionVersion: number;
  readonly family: 'thinking' | 'tool';
  readonly foldClass: FoldClass;
  readonly current: boolean;
  readonly event: SummaryEvent;
  readonly tail?: TranscriptTail;
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
  readonly groupTools: TranscriptGroupTools;
  readonly items: readonly TranscriptItem[];
}

interface ToolProfile {
  readonly foldClass: FoldClass;
  readonly event: SummaryEvent['kind'];
}

const TOOL_BOUNDARY_ROLES: Readonly<Record<string, BoundaryRole>> = {
  Agent: 'card',
  AgentSwarm: 'card',
  NotifyUser: 'pinned',
  AskUserQuestion: 'pinned',
  ExitPlanMode: 'pinned',
};

const TOOL_PROFILES: Readonly<Record<string, ToolProfile>> = {
  Think: { foldClass: 'thinking', event: 'thought' },
  Read: { foldClass: 'explore', event: 'read' },
  ReadMediaFile: { foldClass: 'explore', event: 'read' },
  Grep: { foldClass: 'explore', event: 'search' },
  Glob: { foldClass: 'explore', event: 'search' },
  FetchURL: { foldClass: 'all', event: 'fetch' },
  WebSearch: { foldClass: 'all', event: 'webSearch' },
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
};

const SUCCESS: OutcomeCounts = { calls: 1, failed: 0, interrupted: 0 };
const INTERRUPTION_TEXT = [
  'The user manually interrupted "',
  'Interrupted by user',
  'was not run because the user rejected the approval request',
  'was not run because the approval request was cancelled',
] as const;

export function foregroundBashHintAt(children: readonly Component[]): number | undefined {
  let earliest: number | undefined;
  for (const child of children) {
    if (!(child instanceof ToolCallComponent)) continue;
    const toolCall = child.toolCallView;
    if (
      toolCall.name !== 'Bash' ||
      toolCall.args['run_in_background'] === true ||
      toolCall.truncated === true ||
      child.toolResultView !== undefined
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
    return children.flatMap((child, index) => this.cached(child, index, options.groupTools));
  }

  private cached(
    component: Component,
    sourceIndex: number,
    groupTools: TranscriptGroupTools,
  ): readonly TranscriptItem[] {
    if (component instanceof UserMessageComponent) return [boundary(component, sourceIndex, 'text')];
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
    if (cached?.version === version && cached.groupTools === groupTools) {
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
        ? [this.inspectTool(component, sourceIndex, groupTools)]
        : [boundary(component, sourceIndex, role)];
    }
    else if (component instanceof ReadGroupComponent) items = this.inspectReadGroup(component, sourceIndex, groupTools);
    else items = [boundary(component, sourceIndex, 'card')];
    this.cache.set(component, { version, groupTools, items });
    return items.map((item) => ({ ...item, sourceIndex }));
  }

  private inspectThinking(component: ThinkingComponent, sourceIndex: number): LogicalTranscriptItem {
    const elapsed = component.thinkingElapsed;
    return {
      kind: 'logical',
      display: component,
      source: component,
      sourceIndex,
      projectionVersion: component.transcriptProjectionVersion,
      family: 'thinking',
      foldClass: 'thinking',
      current: elapsed === undefined,
      event: {
        kind: 'thought',
        durationMs: elapsed?.known === true ? elapsed.ms : undefined,
      },
    };
  }

  private inspectTool(
    component: ToolCallComponent,
    sourceIndex: number,
    groupTools: TranscriptGroupTools,
  ): LogicalTranscriptItem {
    const profile = this.profileFor(component);
    const outcome = this.inspectOutcome(component);
    const current = this.isCurrent(component);
    const toolCall = component.toolCallView;
    let foldClass = profile.foldClass;
    if (toolCall.name === 'Bash' && toolCall.streamingArguments === undefined && groupTools === 'explore') {
      foldClass = isReadonlyBash(typeof toolCall.args['command'] === 'string' ? toolCall.args['command'] : '')
        ? 'explore'
        : 'all';
    }
    const event = this.inspectEvent(component, profile, outcome);
    return {
      kind: 'logical',
      display: component,
      source: component,
      sourceIndex,
      projectionVersion: component.transcriptProjectionVersion,
      family: profile.foldClass === 'thinking' ? 'thinking' : 'tool',
      foldClass,
      current,
      event,
      tail: transcriptTail(component),
    };
  }

  private inspectReadGroup(
    component: ReadGroupComponent,
    sourceIndex: number,
    groupTools: TranscriptGroupTools,
  ): readonly TranscriptItem[] {
    const tools = component.getToolComponents();
    if (groupTools !== 'off') return tools.map((tool) => this.inspectTool(tool, sourceIndex, groupTools));
    const first = tools[0];
    const outcome = combineOutcomes(tools.map((tool) => this.inspectOutcome(tool)));
    return [{
      kind: 'logical',
      display: component,
      source: component,
      sourceIndex,
      projectionVersion: component.transcriptProjectionVersion,
      family: 'tool',
      foldClass: 'explore',
      current: tools.some((tool) => this.isCurrent(tool)),
      event: {
        kind: 'read',
        path: first?.getReadSnapshot().filePath ?? first?.toolCallView.id ?? '',
        outcome,
      },
    }];
  }

  private profileFor(component: ToolCallComponent): ToolProfile {
    const name = component.toolCallView.name;
    const profile = TOOL_PROFILES[name];
    if (profile !== undefined) return profile;
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

function transcriptTail(component: ToolCallComponent): TranscriptTail {
  const toolCall = component.toolCallView;
  const { name, args } = toolCall;
  const path = nonEmpty(component.getReadSnapshot().filePath);
  const argument = (key: string): string | undefined => nonEmpty(args[key]);
  const withSubject = (verb: string, subject: string | undefined): string =>
    subject === undefined ? verb : `${verb} ${subject}`;
  const taskId = argument('task_id');
  let text: string;
  switch (name) {
    case 'Read': text = withSubject('Read', path); break;
    case 'ReadMediaFile': text = withSubject('View', path); break;
    case 'Grep': {
      const pattern = argument('pattern');
      text = pattern === undefined
        ? 'Search'
        : `Search "${pattern}"${path === undefined ? '' : ` in ${path}`}`;
      break;
    }
    case 'Glob': text = withSubject('Find', argument('pattern')); break;
    case 'Bash': {
      text = withSubject('$', extractKeyArgumentDetail(name, args)?.text);
      break;
    }
    case 'Edit': text = withSubject('Edit', path); break;
    case 'Write': text = withSubject('Write', path); break;
    case 'TodoList': {
      const todos = args['todos'];
      const active = Array.isArray(todos) ? todos.find((todo) => {
        if (typeof todo !== 'object' || todo === null) return false;
        return 'status' in todo && todo.status === 'in_progress' &&
          'title' in todo && typeof todo.title === 'string';
      }) : undefined;
      const title = typeof active === 'object' && active !== null && 'title' in active
        ? nonEmpty(active.title)
        : undefined;
      text = `Update todos${title === undefined ? '' : ` · ${title}`}`;
      break;
    }
    case 'Skill': text = withSubject('Load skill', argument('skill')); break;
    case 'WebSearch': {
      const query = argument('query');
      text = query === undefined ? 'Search web' : `Search web "${query}"`;
      break;
    }
    case 'FetchURL': {
      text = withSubject('Fetch', nonEmpty(argument('url')?.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')));
      break;
    }
    case 'WaitFor': text = taskId === undefined ? 'Wait for any task' : `Wait for ${taskId}`; break;
    case 'TaskOutput': text = taskId === undefined ? 'Read output' : `Read output of ${taskId}`; break;
    case 'TaskList': text = 'List tasks'; break;
    default: {
      const decoded = decodeMcpToolName(name);
      if (decoded !== null) text = `${decoded.serverName}: ${decoded.toolName}`;
      else text = withSubject(name, nonEmpty(extractKeyArgumentDetail(name, args)?.text));
    }
  }
  return { text, startedAtMs: component.startedAtMs };
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
