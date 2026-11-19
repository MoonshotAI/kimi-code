import type { ChatTurn, TaskNotification, TurnBlock } from '@moonshot-ai/app-core/client/types';
import type { ConversationRequestDebug } from '@moonshot-ai/app-core/conversation';
import { BROWSER_TOOL_NAME, isNotifyUserTool, normalizeToolName } from '@moonshot-ai/app-core/lib';
import { stripAttachmentLinks } from '@moonshot-ai/app-composer/model';
import { skillActivationsBubbleText } from '@moonshot-ai/app-composer/features/mention';

export function userTurnDisplayText(turn: ChatTurn): string {
  if (turn.skillActivations && turn.skillActivations.length > 0) {
    return skillActivationsBubbleText(turn.skillActivations, turn.text);
  }
  return turn.text;
}

export function canCopyUserTurn(turn: ChatTurn): boolean {
  return userTurnDisplayText(turn).trim().length > 0;
}

export function estimateUserTurnHeight(
  text: string | null,
  attachmentCount: number,
  expanded: boolean,
  clampLines: number,
): number {
  const lines = Math.max(1, Math.ceil((text ?? '').length / 50));
  return 60 + (expanded ? lines : Math.min(lines, clampLines)) * 24 + attachmentCount * 32;
}

export { formatTokens, formatDuration } from '@moonshot-ai/app-core/lib';

export function turnBlocks(turn: ChatTurn): TurnBlock[] {
  if (turn.blocks) return turn.blocks;
  const blocks: TurnBlock[] = [];
  if (turn.thinking) blocks.push({ kind: 'thinking', thinking: turn.thinking });
  const userText = turn.role === 'user' ? userTurnDisplayText(turn) : turn.text;
  if (userText) blocks.push({ kind: 'text', text: userText });
  for (const tool of turn.tools ?? []) blocks.push({ kind: 'tool', tool });
  return blocks;
}

export function streamingTailIndex(
  turn: ChatTurn,
  liveTurnId: string | null,
  approvals: readonly { toolCallId?: string }[] = [],
  questions: readonly { toolCallId?: string }[] = [],
): number | null {
  if (turn.id !== liveTurnId) return null;
  const blocks = turnBlocks(turn);
  const last = blocks.at(-1);
  if (last?.streaming !== true) return null;
  if (last.kind === 'thinking' && last.durationMs !== undefined) return null;
  if (last.kind === 'tool' && last.tool.status === 'running') {
    const id = last.tool.id;
    if (approvals.some((approval) => approval.toolCallId === id)) return null;
    if (questions.some((question) => question.toolCallId === id)) return null;
  }
  return blocks.length - 1;
}

export function turnInteractionParked(
  turn: ChatTurn,
  liveTurnId: string | null,
  approvals: readonly { toolCallId?: string }[] = [],
  questions: readonly { toolCallId?: string }[] = [],
): boolean {
  if (turn.id !== liveTurnId) return false;
  const last = turnBlocks(turn).at(-1);
  if (last?.kind === 'thinking') {
    return last.durationMs !== undefined && (approvals.length > 0 || questions.length > 0);
  }
  if (last?.kind !== 'tool' || last.tool.status !== 'running') return false;
  const id = last.tool.id;
  return approvals.some((approval) => approval.toolCallId === id) || questions.some((question) => question.toolCallId === id);
}

export function activityRunTailIndex(
  turn: ChatTurn,
  liveTurnId: string | null,
  approvals: readonly { toolCallId?: string }[] = [],
  questions: readonly { toolCallId?: string }[] = [],
): number | null {
  if (turn.id !== liveTurnId || turnInteractionParked(turn, liveTurnId, approvals, questions)) return null;
  const blocks = turnBlocks(turn);
  const last = blocks.at(-1);
  if (last?.kind !== 'thinking' && last?.kind !== 'tool') return null;
  return blocks.length - 1;
}

export function turnHasOutput(turn: ChatTurn): boolean {
  return turnBlocks(turn).some(
    (b) =>
      (b.kind === 'thinking' && b.thinking.trim().length > 0) ||
      (b.kind === 'text' && b.text.trim().length > 0) ||
      b.kind === 'tool' ||
      b.kind === 'notification',
  );
}

export function latestSettledDaemonTurnIds(
  groups: readonly (readonly ChatTurn[])[],
  isSettled: (group: readonly ChatTurn[]) => boolean,
  limit: number,
): number[] {
  const ids: number[] = [];
  for (let i = groups.length - 1; i >= 0 && ids.length < limit; i -= 1) {
    const group = groups[i]!;
    const turnId = group[0]?.daemonTurnId;
    if (turnId === undefined || !isSettled(group)) continue;
    ids.push(turnId);
  }
  return ids;
}

export type ToolStackItem = {
  tool: Extract<TurnBlock, { kind: 'tool' }>['tool'];
  sourceIndex: number;
};

type RequestDebugs = { debug?: readonly ConversationRequestDebug[] };

export type ActivityItem = (
  | { kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number }
) & RequestDebugs;

export type AssistantRenderBlock =
  | ({ kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number } & RequestDebugs)
  | ({ kind: 'text'; text: string; final?: boolean; sourceIndex: number } & RequestDebugs)
  | ({ kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number } & RequestDebugs)
  | { kind: 'activity-run'; items: ActivityItem[] }
  | { kind: 'notification'; items: TaskNotification[]; sourceIndex: number };

export function rendersToolCard(block: Extract<TurnBlock, { kind: 'tool' }>): boolean {
  if (block.tool.name === BROWSER_TOOL_NAME) return true;
  return !(block.tool.status === 'ok' && block.tool.media);
}

export function rendersProgressRow(block: Extract<TurnBlock, { kind: 'tool' }>, notifyUserEnabled = true): boolean {
  return notifyUserEnabled && block.tool.status !== 'error' && isNotifyUserTool(block.tool.name);
}

export function latestNotifyToolCallId(turns: readonly ChatTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const blocks = turnBlocks(turns[i]!);
    for (let j = blocks.length - 1; j >= 0; j -= 1) {
      const block = blocks[j]!;
      if (block.kind === 'tool' && rendersProgressRow(block)) return block.tool.id;
    }
  }
  return undefined;
}

export function assistantRenderBlocks(turn: ChatTurn, options?: { notifyUserEnabled?: boolean }): AssistantRenderBlock[] {
  const blocks = turnBlocks(turn);
  const rendered: AssistantRenderBlock[] = [];
  let run: ActivityItem[] = [];
  let pending: { items: TaskNotification[]; sourceIndex: number } | null = null;

  const flushRun = () => {
    const [only] = run;
    if (run.length === 1 && only) {
      rendered.push(only);
    } else if (run.length > 1) {
      rendered.push({ kind: 'activity-run', items: run });
    }
    run = [];
  };
  const flushNotifications = () => {
    if (pending) rendered.push({ kind: 'notification', items: pending.items, sourceIndex: pending.sourceIndex });
    pending = null;
  };

  blocks.forEach((block, sourceIndex) => {
    if (block.kind === 'notification') {
      flushRun();
      if (pending) pending.items.push(block.notification);
      else pending = { items: [block.notification], sourceIndex };
      return;
    }
    if (run.length === 0) flushNotifications();
    if (block.kind === 'thinking') {
      run.push({
        kind: 'thinking',
        thinking: block.thinking,
        startedAt: block.startedAt,
        durationMs: block.durationMs,
        sourceIndex,
        debug: block.debug,
      });
      return;
    }
    if (
      block.kind === 'tool' &&
      rendersToolCard(block) &&
      !rendersProgressRow(block, options?.notifyUserEnabled) &&
      normalizeToolName(block.tool.name) !== 'task'
    ) {
      run.push({ kind: 'tool', tool: block.tool, sourceIndex, debug: block.debug });
      return;
    }

    flushRun();
    flushNotifications();
    if (block.kind === 'text') {
      rendered.push({
        kind: 'text',
        text: block.text,
        ...(block.final === true ? { final: true } : {}),
        sourceIndex,
        debug: block.debug,
      });
    } else if (block.kind === 'tool') {
      rendered.push({ kind: 'tool', tool: block.tool, sourceIndex, debug: block.debug });
    }
  });

  flushRun();
  flushNotifications();
  return rendered;
}

export interface AssistantFold {
  folded: AssistantRenderBlock[];
  visible: AssistantRenderBlock[];
}

const splitFoldCaches = { on: new WeakMap<ChatTurn, AssistantFold>(), off: new WeakMap<ChatTurn, AssistantFold>() };

export function splitAssistantFold(turn: ChatTurn, options?: { notifyUserEnabled?: boolean }): AssistantFold {
  const enabled = options?.notifyUserEnabled !== false;
  const cache = enabled ? splitFoldCaches.on : splitFoldCaches.off;
  const cached = cache.get(turn);
  if (cached !== undefined) return cached;
  const split = computeAssistantFold(turn, enabled);
  cache.set(turn, split);
  return split;
}

function computeAssistantFold(turn: ChatTurn, notifyUserEnabled: boolean): AssistantFold {
  const rendered = assistantRenderBlocks(turn, { notifyUserEnabled });
  let splitAt = rendered.findIndex(
    (block) => block.kind === 'text' && block.final === true && block.text.trim().length > 0,
  );
  if (splitAt === -1) {
    for (let i = rendered.length - 1; i >= 0; i--) {
      const block = rendered[i];
      if (block?.kind === 'text' && block.text.trim().length > 0) {
        splitAt = i;
        break;
      }
    }
  }
  if (splitAt === -1) {
    for (let i = 0; i < rendered.length; i++) {
      const block = rendered[i];
      if (block?.kind === 'tool' && !rendersToolCard(block)) {
        splitAt = i;
        break;
      }
      if (block?.kind === 'notification') {
        splitAt = i;
        break;
      }
    }
    if (splitAt === -1) return { folded: rendered, visible: [] };
  }
  return { folded: rendered.slice(0, splitAt), visible: rendered.slice(splitAt) };
}

export function flattenAssistantFold(fold: AssistantFold): AssistantRenderBlock[] {
  const indexOf = (block: AssistantRenderBlock): number =>
    block.kind === 'activity-run' ? (block.items[0]?.sourceIndex ?? -1) : block.sourceIndex;
  return [...fold.folded, ...fold.visible].sort((a, b) => indexOf(a) - indexOf(b));
}

export function turnActivitySeedMs(blocks: TurnBlock[]): number | undefined {
  let best: number | undefined;
  for (const block of blocks) {
    if (block.kind !== 'thinking' || block.startedAt === undefined) continue;
    const ms = Date.parse(block.startedAt);
    if (Number.isNaN(ms)) continue;
    if (best === undefined || ms < best) best = ms;
  }
  return best;
}

export function isoMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export type TurnWorkState = { phase: 'live'; nowMs: number } | { phase: 'settled' };

export function turnWorkMs(input: {
  startMs?: number;
  endedMs?: number;
  durationMs?: number;
  state: TurnWorkState;
}): number | undefined {
  if (input.state.phase === 'settled') {
    if (input.durationMs !== undefined) return Math.max(0, input.durationMs);
    if (input.startMs === undefined || input.endedMs === undefined) return undefined;
    return Math.max(0, input.endedMs - input.startMs);
  }
  if (input.startMs === undefined) return undefined;
  return Math.max(0, input.state.nowMs - input.startMs);
}

export function turnFinalText(turn: ChatTurn): string {
  return turnBlocks(turn)
    .flatMap((blk) => (blk.kind === 'text' && blk.text ? [blk.text] : []))
    .join('\n\n');
}

export function turnVisibleFinalText(turn: ChatTurn): string {
  return splitAssistantFold(turn)
    .visible.flatMap((blk) => (blk.kind === 'text' && blk.text ? [blk.text] : []))
    .at(-1) ?? '';
}

const escapeMarkdownText = (value: string): string =>
  value
    .replace(/([\\`*_[\]<!#])/g, '\\$1')
    .replace(/^([-+>])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');

export function turnToMarkdown(turn: ChatTurn): string {
  const parts: string[] = [];
  for (const blk of turnBlocks(turn)) {
    if (blk.kind === 'thinking' && blk.thinking) {
      parts.push(`> **Thinking**\n> ${blk.thinking.split('\n').join('\n> ')}`);
    } else if (blk.kind === 'text' && blk.text) {
      parts.push(stripAttachmentLinks(blk.text, escapeMarkdownText));
    } else if (blk.kind === 'tool' && blk.tool.output && blk.tool.output.length > 0) {
      const output = blk.tool.output.join('\n');
      parts.push(`\`\`\`\n[${blk.tool.name}]\n${output}\n\`\`\``);
    } else if (blk.kind === 'notification') {
      const n = blk.notification;
      const lines = [n.title, n.type, ...n.body.split('\n')].filter((s) => s !== '');
      const quoted = lines.length > 0 ? `> **Notification**\n> ${lines.join('\n> ')}` : '';
      const preview = n.outputPreview?.text ?? '';
      const fenced = preview !== '' ? `\`\`\`\n[output-preview]\n${preview}\n\`\`\`` : '';
      const md = [quoted, fenced].filter((s) => s !== '').join('\n\n');
      if (md !== '') parts.push(md);
    }
  }
  return parts.join('\n\n');
}

const RENDER_ALL_MAX_TURNS = 40;
const RENDER_ALL_MAX_BLOCKS = 240;

export function historyRenderAllAffordable(turns: readonly ChatTurn[]): boolean {
  if (turns.length > RENDER_ALL_MAX_TURNS) return false;
  let blocks = 0;
  for (const turn of turns) {
    blocks += 1 + (turn.blocks?.length ?? turn.tools?.length ?? 0);
    if (blocks > RENDER_ALL_MAX_BLOCKS) return false;
  }
  return true;
}

export function turnTocTitle(turn: ChatTurn, t: (key: string) => string): string {
  if (turn.role === 'compaction') return t('conversation.compactedPlain');
  if (turn.role === 'user') {
    if (turn.skillActivation) return `/${turn.skillActivation.name}`;
    if (turn.skillActivations && turn.skillActivations.length > 0)
      return turn.skillActivations.map((act) => `/${act.name}`).join(' ');
    if (turn.pluginCommand) return `/${turn.pluginCommand.pluginId}:${turn.pluginCommand.commandName}`;
    const text = stripAttachmentLinks(turn.text).trim().replaceAll(/\s+/g, ' ');
    return text.length > 0 ? text : 'user';
  }
  const text = (turn.text || turn.thinking || '').trim().replaceAll(/\s+/g, ' ');
  if (text.length > 0) return text;
  if ((turn.tools?.length ?? 0) > 0) return `${turn.tools!.length} tools`;
  return 'kimi';
}

export function toolStackKey(item: ToolStackItem): string {
  return item.tool.id || `tool-${item.sourceIndex}`;
}

export function renderBlockKey(block: AssistantRenderBlock, index: number): string {
  if (block.kind === 'activity-run') {
    return `activity-run-${block.items[0]?.sourceIndex ?? index}`;
  }
  if (block.kind === 'tool') return toolStackKey({ tool: block.tool, sourceIndex: block.sourceIndex });
  return `${block.kind}-${block.sourceIndex}`;
}

export type { TurnFileChange } from '@moonshot-ai/app-core/client';

export function normalizePathKey(path: string): string {
  const posixAbsolute = path.startsWith('/') && !path.startsWith('//');
  const norm = posixAbsolute ? path : path.replace(/\\/g, '/');
  let root = '';
  let rest = norm;
  let windows = false;
  const unc = /^\/\/([^/]+\/[^/]+)(\/|$)/.exec(norm);
  if (unc) {
    root = `//${unc[1]!.toLowerCase()}/`;
    rest = norm.slice(unc[0].length - (unc[0].endsWith('/') ? 1 : 0));
    windows = true;
  } else if (/^[a-zA-Z]:\//.test(norm)) {
    root = `${norm[0]!.toLowerCase()}:/`;
    rest = norm.slice(3);
    windows = true;
  } else if (norm.startsWith('/')) {
    root = '/';
    rest = norm.slice(1);
  }
  const isAbs = root !== '';

  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push(part);
      continue;
    }
    out.push(part);
  }
  const body = out.join('/');
  const key = root + body;
  return windows ? key.toLowerCase() : key;
}
