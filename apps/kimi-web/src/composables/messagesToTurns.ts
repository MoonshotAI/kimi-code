// apps/kimi-web/src/composables/messagesToTurns.ts
// Converts a flat list of AppMessages into ChatTurn[] for rendering.
//
// Key rule: consecutive ASSISTANT messages are merged into ONE ChatTurn unless
// two known promptIds prove that they belong to different prompts.  This
// prevents a multi-step agent turn (think → tool → result → text) from appearing
// as several "kimi >" blocks.  Snapshot messages may omit promptId, so user
// messages and compaction summaries are the hard turn boundaries.
// TOOL-role messages fold their toolResult content into the preceding assistant
// group rather than becoming separate turns.

import type { AppMessage, AppApprovalRequest, AppTask, CompactionMarkerMetadata } from '../api/types';
import { COMPACTION_MARKER_METADATA_KEY } from '../api/types';
import type { AgentMember, ApprovalBlock, ChatTurn, DiffLine, ToolCall, ToolMedia, TurnBlock } from '../types';

const READ_MEDIA_TOOL_RE = /^read[_-]?media(?:file)?$/i;
// The builtin single-subagent spawn tool (collaboration/agent.ts). Detected by
// name so a subagent renders as an AgentCard from the persisted transcript
// alone — i.e. it survives a refresh even when the live task record (which only
// background subagents persist) is gone. Swarms use 'AgentSwarm' and are handled
// via buildSwarmGroups, so they are deliberately NOT matched here.
const SUBAGENT_TOOL_RE = /^agent$/i;
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const MEDIA_PATH_TAG_RE = /^<(image|video|audio)\s+path="([^"]+)">$/;
const SYSTEM_MIME_RE = /Mime type:\s*([^.\s]+)/i;
const SYSTEM_SIZE_RE = /Size:\s*(\d+)\s*bytes/i;
const SYSTEM_DIMENSIONS_RE = /Original dimensions:\s*(\d+)x(\d+)\s*pixels/i;

function bytesFromBase64(b64: string): number {
  if (b64.length === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function contentPartsFromOutput(output: unknown): unknown[] | null {
  if (Array.isArray(output)) return output;
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mediaUrlPart(part: Record<string, unknown>): { kind: ToolMedia['kind']; url: string } | null {
  const type = part['type'];
  const kind =
    type === 'image_url'
      ? 'image'
      : type === 'video_url'
        ? 'video'
        : type === 'audio_url'
          ? 'audio'
          : null;
  if (kind === null) return null;
  const holderKey = kind === 'image' ? 'imageUrl' : kind === 'video' ? 'videoUrl' : 'audioUrl';
  const holder = part[holderKey];
  if (typeof holder !== 'object' || holder === null) return null;
  const url = (holder as Record<string, unknown>)['url'];
  return typeof url === 'string' ? { kind, url } : null;
}

function normalizeToolMedia(toolName: string, output: unknown): ToolMedia | undefined {
  if (!READ_MEDIA_TOOL_RE.test(toolName)) return undefined;
  const parts = contentPartsFromOutput(output);
  if (parts === null) return undefined;

  let path: string | undefined;
  let tagKind: ToolMedia['kind'] | undefined;
  let mimeType: string | undefined;
  let bytes: number | undefined;
  let dimensions: string | undefined;
  let media: { kind: ToolMedia['kind']; url: string } | null = null;

  for (const raw of parts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const part = raw as Record<string, unknown>;
    if (part['type'] === 'text' && typeof part['text'] === 'string') {
      const text = part['text'];
      const tag = MEDIA_PATH_TAG_RE.exec(text);
      if (tag) {
        tagKind = tag[1] as ToolMedia['kind'];
        path = tag[2];
      }
      const mime = SYSTEM_MIME_RE.exec(text);
      if (mime?.[1]) mimeType = mime[1];
      const size = SYSTEM_SIZE_RE.exec(text);
      if (size?.[1]) bytes = Number(size[1]);
      const dims = SYSTEM_DIMENSIONS_RE.exec(text);
      if (dims?.[1] && dims[2]) dimensions = `${dims[1]}x${dims[2]}`;
      continue;
    }

    const nextMedia = mediaUrlPart(part);
    if (nextMedia) media = nextMedia;
  }

  if (media === null) return undefined;
  const data = DATA_URL_RE.exec(media.url);
  if (data?.[1]) mimeType = data[1];
  if (data?.[2]) bytes = bytesFromBase64(data[2]);

  return {
    kind: media.kind ?? tagKind ?? 'image',
    url: media.url,
    path,
    mimeType,
    bytes: Number.isFinite(bytes) ? bytes : undefined,
    dimensions,
  };
}

/**
 * Tool output is `string | ContentPart[]` (agent-core). A string splits into
 * lines; a ContentPart[] (e.g. from media tools) is flattened: text/think parts
 * become lines, image/media parts become a `[image]`-style placeholder — instead
 * of dumping raw `[{"type":"text",...}]` JSON into the UI.
 */
function normalizeToolOutput(output: unknown): string[] | undefined {
  if (output === null || output === undefined) return undefined;
  if (typeof output === 'string') return output.split('\n');
  if (Array.isArray(output)) {
    const lines: string[] = [];
    for (const part of output) {
      if (typeof part === 'string') {
        lines.push(...part.split('\n'));
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (p.type === 'text' && typeof p.text === 'string') lines.push(...p.text.split('\n'));
        else if (p.type === 'think' && typeof p.think === 'string') lines.push(...p.think.split('\n'));
        else if (p.type === 'image_url' || p.type === 'image') lines.push('[image]');
        else if (typeof p.type === 'string') lines.push(`[${p.type}]`);
        else lines.push(JSON.stringify(part));
      }
    }
    return lines.length > 0 ? lines : undefined;
  }
  return [JSON.stringify(output)];
}

function toAgentMember(task: AppTask): AgentMember {
  return {
    id: task.id,
    toolCallId: task.parentToolCallId,
    name: task.description,
    subagentType: task.subagentType,
    phase:
      task.subagentPhase ??
      (task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'working'),
    status: task.status,
    summary: task.outputPreview,
    outputLines: task.outputLines,
    suspendedReason: task.suspendedReason,
    swarmIndex: task.swarmIndex,
  };
}

/** Parse the Agent tool's input (object or JSON string) into the fields an
    AgentCard needs. Tolerant of missing/garbled input. */
function parseAgentToolInput(input: unknown): {
  description?: string;
  subagentType?: string;
  prompt?: string;
} {
  let obj: Record<string, unknown> | null = null;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (input && typeof input === 'object') {
    obj = input as Record<string, unknown>;
  }
  if (!obj) return {};
  return {
    description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
    subagentType: typeof obj['subagent_type'] === 'string' ? obj['subagent_type'] : undefined,
    prompt: typeof obj['prompt'] === 'string' ? obj['prompt'] : undefined,
  };
}

/** Build an AgentMember from an `Agent` tool call + its result, used when no
    live subagent task is available (e.g. after a refresh). The result text is
    the subagent's full output — richer detail than a task's short preview. */
function agentMemberFromToolUse(
  toolCallId: string,
  input: unknown,
  result: { output: unknown; isError: boolean } | undefined,
  sessionActive: boolean,
): AgentMember {
  const parsed = parseAgentToolInput(input);
  const phase: AgentMember['phase'] = result
    ? result.isError
      ? 'failed'
      : 'completed'
    : sessionActive
      ? 'working'
      : 'completed';
  const summaryLines = result ? normalizeToolOutput(result.output) : undefined;
  return {
    id: toolCallId,
    toolCallId,
    name: parsed.description && parsed.description.length > 0 ? parsed.description : 'Sub Agent',
    subagentType: parsed.subagentType,
    prompt: parsed.prompt,
    phase,
    status: result ? (result.isError ? 'failed' : 'completed') : sessionActive ? 'running' : 'completed',
    summary: summaryLines && summaryLines.length > 0 ? summaryLines.join('\n') : undefined,
  };
}

function sortAgentTasks(a: AppTask, b: AppTask): number {
  const ai = a.swarmIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.swarmIndex ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.createdAt.localeCompare(b.createdAt);
}

// ---------------------------------------------------------------------------
// Inline buildApprovalBlock (mirrors the one in useKimiWebClient.ts; kept
// here to avoid a circular import when tests import this module directly).
// ---------------------------------------------------------------------------

function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const removed = oldText.split('\n');
  const added = newText.split('\n');
  const lines: DiffLine[] = [];
  removed.forEach((text, i) => {
    lines.push({ kind: 'rem', gutter: String(i + 1), text: `- ${text}` });
  });
  added.forEach((text, i) => {
    lines.push({ kind: 'add', gutter: String(i + 1), text: `+ ${text}` });
  });
  return lines;
}

function buildApprovalBlock(a: AppApprovalRequest): ApprovalBlock {
  const d = (a.display ?? {}) as Record<string, unknown>;
  const kind = typeof d['kind'] === 'string' ? d['kind'] : '';

  if (kind === 'diff') {
    const path = typeof d['path'] === 'string' ? d['path'] : '';
    if (Array.isArray(d['diff'])) {
      return { kind: 'diff', path, diff: d['diff'] as DiffLine[] };
    }
    if (typeof d['old_text'] === 'string' && typeof d['new_text'] === 'string') {
      return { kind: 'diff', path, diff: buildDiffLines(d['old_text'], d['new_text']) };
    }
    return { kind: 'diff', path, diff: [] };
  }

  if (kind === 'shell' || kind === 'command') {
    return {
      kind: 'shell',
      command: typeof d['command'] === 'string' ? d['command'] : a.action,
      cwd: typeof d['cwd'] === 'string' ? d['cwd'] : undefined,
      danger: typeof d['danger'] === 'string' ? d['danger'] : undefined,
    };
  }

  if (kind === 'file_content' || kind === 'file') {
    return {
      kind: 'file',
      path: typeof d['path'] === 'string' ? d['path'] : '',
      content: typeof d['content'] === 'string' ? d['content'] : '',
      language: typeof d['language'] === 'string' ? d['language'] : undefined,
    };
  }

  if (kind === 'file_op' || kind === 'fileop') {
    const op =
      typeof d['operation'] === 'string'
        ? d['operation']
        : typeof d['op'] === 'string'
          ? d['op']
          : kind;
    return {
      kind: 'fileop',
      op,
      path: typeof d['path'] === 'string' ? d['path'] : '',
      detail: typeof d['detail'] === 'string' ? d['detail'] : undefined,
    };
  }

  if (kind === 'url_fetch' || kind === 'url') {
    return {
      kind: 'url',
      method: typeof d['method'] === 'string' ? d['method'] : undefined,
      url: typeof d['url'] === 'string' ? d['url'] : a.action,
    };
  }

  if (kind === 'search') {
    return {
      kind: 'search',
      query: typeof d['query'] === 'string' ? d['query'] : a.action,
      scope: typeof d['scope'] === 'string' ? d['scope'] : undefined,
    };
  }

  if (kind === 'invocation' || kind === 'agent_call' || kind === 'skill_call') {
    return {
      kind: 'invocation',
      kind2: typeof d['kind'] === 'string' ? d['kind'] : kind,
      name: typeof d['name'] === 'string' ? d['name'] : a.toolName,
      description: typeof d['description'] === 'string' ? d['description'] : undefined,
    };
  }

  if (kind === 'todo' || kind === 'todo_list') {
    const rawItems = Array.isArray(d['items']) ? d['items'] : [];
    const items = rawItems.map((item: unknown) => {
      const it = (item ?? {}) as Record<string, unknown>;
      return {
        title: typeof it['title'] === 'string' ? it['title'] : '',
        status: typeof it['status'] === 'string' ? it['status'] : 'pending',
      };
    });
    return { kind: 'todo', items };
  }

  return { kind: 'generic', summary: a.action };
}

// ---------------------------------------------------------------------------
// Internal grouping state
// ---------------------------------------------------------------------------

interface Group {
  /** id of the first assistant message in the group — used as the turn id */
  id: string;
  /** Known promptId for this assistant group, if the protocol supplied one. */
  promptId: string | undefined;
  textParts: string[];
  thinkingParts: string[];
  tools: ToolCall[];
  /** Ordered text/tool blocks (preserve call order for inline rendering). */
  blocks: TurnBlock[];
  approval: ApprovalBlock | undefined;
  approvalId: string | undefined;
  /** Client-side measured duration from turn.started to turn.ended (ms). */
  durationMs?: number;
  /**
   * Content signatures already folded into this group, used to drop a duplicate
   * assistant message. The same logical reply can reach us under two different
   * ids — e.g. the streamed copy plus the persisted copy after a reload — and
   * since both share the promptId they'd otherwise merge and render the text +
   * tool cards twice. Dedupe by exact content so a turn shows each reply once.
   */
  seenSigs: Set<string>;
}

// ---------------------------------------------------------------------------
// messagesToTurns
// ---------------------------------------------------------------------------

/**
 * Whether a USER-role message should be shown. Mirrors the TUI's
 * isReplayUserTurnRecord: only real user input (origin `user`/absent, or a
 * user-typed slash command) is displayed; system-injected user turns
 * (compaction summaries, injections, hook results, retries, system triggers,
 * background tasks, cron) are hidden. The origin arrives via message metadata
 * (see toProtocolMessage in @moonshot-ai/agent-core).
 */
function isDisplayableUserMessage(msg: AppMessage): boolean {
  const origin = msg.metadata?.['origin'] as { kind?: string; trigger?: string } | undefined;
  const kind = origin?.kind;
  if (kind === undefined || kind === 'user') return true;
  if (kind === 'skill_activation') return origin?.trigger === 'user-slash';
  return false;
}

/**
 * A compaction summary message — either the client-side marker appended on
 * compactionCompleted, or the daemon's synthetic ASSISTANT message that
 * replaces the compacted prefix in a reloaded snapshot. Both render as a
 * "context compacted" divider; the summary text opens in the side panel.
 */
function isCompactionSummaryMessage(msg: AppMessage): boolean {
  const origin = msg.metadata?.['origin'] as { kind?: string } | undefined;
  return origin?.kind === 'compaction_summary';
}

function continuesAssistantGroup(group: Group | null, promptId: string | undefined): group is Group {
  if (group === null) return false;
  return (
    group.promptId === undefined ||
    promptId === undefined ||
    group.promptId === promptId
  );
}

export function messagesToTurns(
  messages: AppMessage[],
  approvals: AppApprovalRequest[],
  getFileUrl?: (fileId: string) => string,
  /**
   * Whether the active session is still producing output. Only a live session's
   * FINAL group keeps a dangling tool spinning (a genuine in-flight tool). When
   * the session is idle, a tool that never got its result — e.g. a result frame
   * the projector dropped on a reconnect/ordering race — must settle instead of
   * spinning forever after the turn already finished.
   */
  sessionActive = true,
  subagentTasks: AppTask[] = [],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let no = 1;

  // Build approval lookup by toolCallId
  const approvalByTool = new Map<string, AppApprovalRequest>();
  for (const a of approvals) {
    approvalByTool.set(a.toolCallId, a);
  }

  const subagentsByTool = new Map<string, AppTask[]>();
  for (const task of subagentTasks) {
    if (task.kind !== 'subagent') continue;
    const keys = [task.parentToolCallId, task.id].filter((key): key is string => typeof key === 'string' && key.length > 0);
    for (const key of keys) {
      const list = subagentsByTool.get(key) ?? [];
      list.push(task);
      subagentsByTool.set(key, list);
    }
  }
  for (const [key, list] of subagentsByTool.entries()) {
    subagentsByTool.set(key, list.toSorted(sortAgentTasks));
  }

  // Index every tool result by its tool-call id. When an `Agent` tool call has
  // no live subagent task (the common case after a refresh — foreground
  // subagents are never persisted as background tasks), we rebuild its AgentCard
  // straight from the transcript, and the result text comes from this map.
  const toolResultByCallId = new Map<string, { output: unknown; isError: boolean }>();
  for (const msg of messages) {
    for (const c of msg.content) {
      if (c.type === 'toolResult') {
        toolResultByCallId.set(c.toolCallId, { output: c.output, isError: Boolean(c.isError) });
      }
    }
  }

  let pendingGroup: Group | null = null;

  function flushGroup(final = false): void {
    if (!pendingGroup) return;
    const g = pendingGroup;
    pendingGroup = null;
    // A later message ended this turn, so a tool still 'running' simply never
    // had its result persisted (e.g. an aborted turn in an old transcript) —
    // render it settled instead of spinning forever. The FINAL group keeps
    // 'running' so live in-flight tools show their spinner — but only while the
    // session is actually active; once it is idle a dangling tool is a missed
    // result, not a live one, so settle it too.
    if (!final || !sessionActive) {
      for (let i = 0; i < g.tools.length; i++) {
        const t = g.tools[i]!;
        if (t.status !== 'running') continue;
        const updated: ToolCall = { ...t, status: 'ok' };
        g.tools[i] = updated;
        const blk = g.blocks.find((b) => b.kind === 'tool' && b.tool.id === updated.id);
        if (blk && blk.kind === 'tool') blk.tool = updated;
      }
    }
    turns.push({
      id: g.id,
      role: 'assistant',
      no: no++,
      text: g.textParts.join('\n'),
      thinking: g.thinkingParts.length > 0 ? g.thinkingParts.join('\n') : undefined,
      tools: g.tools.length > 0 ? g.tools : undefined,
      blocks: g.blocks.length > 0 ? g.blocks : undefined,
      approval: g.approval,
      approvalId: g.approvalId,
      durationMs: g.durationMs,
    });
  }

  function absorbContent(g: Group, content: AppMessage['content']): void {
    for (const c of content) {
      if (c.type === 'text') {
        if (c.text) {
          g.textParts.push(c.text);
          // Append to a trailing text block, else open a new one — so a tool
          // call between two text segments splits them into separate blocks.
          const last = g.blocks.at(-1);
          if (last && last.kind === 'text') last.text += '\n' + c.text;
          else g.blocks.push({ kind: 'text', text: c.text });
        }
      } else if (c.type === 'thinking') {
        if (c.thinking) {
          g.thinkingParts.push(c.thinking);
          // Ordered block too: thinking renders WHERE it happened in the turn,
          // merging consecutive segments (same rule as text blocks above).
          const last = g.blocks.at(-1);
          if (last && last.kind === 'thinking') last.thinking += '\n' + c.thinking;
          else g.blocks.push({ kind: 'thinking', thinking: c.thinking });
        }
      } else if (c.type === 'toolUse') {
        const agentTasks = subagentsByTool.get(c.toolCallId);
        if (agentTasks && agentTasks.length > 0) {
          // A multi-member swarm (subagents sharing a parent tool-call, each with
          // a swarmIndex) renders as its OWN SwarmCard in the chat flow — see
          // buildSwarmGroups, same membership test. Don't ALSO render it inline
          // here, or the swarm shows up twice ("two blocks").
          const swarmMembers = agentTasks.filter((t) => t.swarmIndex !== undefined);
          if (swarmMembers.length > 1) continue;
          const members = agentTasks.map(toAgentMember);
          if (members.length === 1) {
            g.blocks.push({ kind: 'agent', member: members[0]! });
          } else {
            g.blocks.push({ kind: 'agentGroup', members });
          }
          continue;
        }

        // No live task, but this IS a single-subagent spawn (`Agent` tool):
        // rebuild the AgentCard from the persisted tool call + result so the
        // subagent keeps its rich card after a refresh instead of degrading to
        // a plain tool card.
        if (SUBAGENT_TOOL_RE.test(c.toolName)) {
          const member = agentMemberFromToolUse(
            c.toolCallId,
            c.input,
            toolResultByCallId.get(c.toolCallId),
            sessionActive,
          );
          g.blocks.push({ kind: 'agent', member });
          continue;
        }

        const pendingApproval = approvalByTool.get(c.toolCallId);
        const toolCall: ToolCall = {
          id: c.toolCallId,
          name: c.toolName,
          arg: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
          // 'running' until the toolResult is absorbed (resolves to ok/error);
          // flushGroup settles dangling tools of finished turns back to 'ok'.
          status: 'running',
          output: c.outputLines,
        };
        g.tools.push(toolCall);
        g.blocks.push({ kind: 'tool', tool: toolCall });
        if (pendingApproval) {
          g.approval = buildApprovalBlock(pendingApproval);
          g.approvalId = pendingApproval.approvalId;
        }
      } else if (c.type === 'toolResult') {
        // Update the matching tool call status within this group (both the flat
        // tools[] and the ordered block that renders it).
        const idx = g.tools.findIndex((t) => t.id === c.toolCallId);
        if (idx !== -1) {
          const tool = g.tools[idx]!;
          const updated: ToolCall = {
            ...tool,
            status: c.isError ? 'error' : 'ok',
            output: normalizeToolOutput(c.output),
            media: c.isError ? undefined : normalizeToolMedia(tool.name, c.output),
          };
          g.tools[idx] = updated;
          const blk = g.blocks.find((b) => b.kind === 'tool' && b.tool.id === c.toolCallId);
          if (blk && blk.kind === 'tool') blk.tool = updated;
        }
      }
    }
  }

  function resolveMediaUrl(
    c: AppMessage['content'][number],
  ): { url: string; kind: 'image' | 'video' } | undefined {
    if (c.type === 'image' || c.type === 'video') {
      const kind = c.type;
      const src = c.source;
      if (src.kind === 'url') return { url: src.url, kind };
      if (src.kind === 'base64') return { url: `data:${src.mediaType};base64,${src.data}`, kind };
      if (src.kind === 'file' && getFileUrl) return { url: getFileUrl(src.fileId), kind };
    }
    if (c.type === 'file' && getFileUrl) {
      if (c.mediaType.startsWith('image/')) return { url: getFileUrl(c.fileId), kind: 'image' };
      if (c.mediaType.startsWith('video/')) return { url: getFileUrl(c.fileId), kind: 'video' };
    }
    return undefined;
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    // Compaction summaries become a divider turn — never a chat bubble. The
    // snapshot variant carries no token stats (marker metadata is client-side).
    if (isCompactionSummaryMessage(msg)) {
      flushGroup();
      const marker = msg.metadata?.[COMPACTION_MARKER_METADATA_KEY] as
        | CompactionMarkerMetadata
        | undefined;
      turns.push({
        id: msg.id,
        role: 'compaction',
        no, // not displayed — dividers have no gutter number
        text: msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
        compaction: {
          trigger: marker?.trigger,
          tokensBefore: marker?.tokensBefore,
          tokensAfter: marker?.tokensAfter,
        },
      });
      continue;
    }

    // User messages flush the pending group and start a new user turn
    if (msg.role === 'user') {
      flushGroup();
      // Hide system-injected user turns (TUI parity) — they end the previous
      // assistant turn but aren't rendered as a user bubble.
      if (!isDisplayableUserMessage(msg)) continue;

      const origin = msg.metadata?.['origin'] as
        | { kind?: string; skillName?: string; skillArgs?: string; trigger?: string }
        | undefined;
      const isSkillActivation =
        origin?.kind === 'skill_activation' && origin?.trigger === 'user-slash';

      const textParts: string[] = [];
      const images: { url: string; alt?: string; kind: 'image' | 'video' }[] = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          if (isSkillActivation) {
            // Skill activation messages carry the raw XML block; we strip it and
            // surface only the user-provided args as the "user input" text.
            textParts.push(origin.skillArgs ?? '');
          } else {
            textParts.push(c.text);
          }
        }
        const media = resolveMediaUrl(c);
        if (media) images.push({ url: media.url, kind: media.kind, alt: c.type === 'file' ? c.name : undefined });
      }
      turns.push({
        id: msg.id,
        role: 'user',
        no: no++,
        text: textParts.join('\n'),
        images: images.length > 0 ? images : undefined,
        skillActivation: isSkillActivation
          ? { name: origin.skillName!, args: origin.skillArgs }
          : undefined,
        createdAt: msg.createdAt,
      });
      continue;
    }

    // Tool-role messages (toolResult) fold into the pending group's tool list
    if (msg.role === 'tool') {
      if (pendingGroup) absorbContent(pendingGroup, msg.content);
      continue;
    }

    // Assistant messages: decide whether to extend the current group or start a new one.
    //
    // Merge rule: user messages and compaction summaries are hard boundaries.
    // Inside an assistant segment, split only when both sides have known,
    // different promptIds. The daemon's REST snapshot is allowed to omit
    // prompt_id, so "missing promptId" must not fragment one model reply into
    // many chat children.
    const pid = msg.promptId;

    const continuesGroup = continuesAssistantGroup(pendingGroup, pid);

    if (!continuesGroup) {
      flushGroup();
      pendingGroup = {
        id: msg.id,
        promptId: pid,
        textParts: [],
        thinkingParts: [],
        tools: [],
        blocks: [],
        approval: undefined,
        approvalId: undefined,
        seenSigs: new Set<string>(),
        durationMs: msg.durationMs,
      };
    } else if (pendingGroup !== null && pendingGroup.promptId === undefined && pid !== undefined) {
      pendingGroup.promptId = pid;
    }

    const group = pendingGroup;
    if (group === null) continue;

    // Drop an assistant message whose content was already folded into this group
    // (a duplicate streamed-vs-persisted copy sharing the promptId), so the turn
    // doesn't render the same text + tools twice.
    const sig = JSON.stringify(msg.content);
    if (group.promptId !== undefined && group.seenSigs.has(sig)) continue;
    group.seenSigs.add(sig);

    absorbContent(group, msg.content);
  }

  flushGroup(true);
  return turns;
}
