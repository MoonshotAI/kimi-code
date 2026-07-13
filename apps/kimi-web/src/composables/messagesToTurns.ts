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
import type { AgentMember, ApprovalBlock, ChatTurn, CronTurnData, DiffLine, ToolCall, ToolMedia, TurnBlock } from '../types';

const READ_MEDIA_TOOL_RE = /^read[_-]?media(?:file)?$/i;
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const MEDIA_PATH_TAG_RE = /^<(image|video|audio)\s+path="([^"]+)">$/;
// A user-uploaded image/video reaches the transcript (after the server resolves
// it) as a self-contained text tag: `<video path="/cache/<fileId>.mp4"></video>`.
// The tag is its own content part, so anchoring keeps ordinary prose from
// matching; the closing tag is optional because ReadMediaFile emits the bare
// opening tag as a standalone part.
const USER_MEDIA_PATH_TAG_RE = /^<(image|video|audio)\s+path="([^"]+)">(?:<\/\1>)?$/;
const SYSTEM_MIME_RE = /Mime type:\s*([^.\s]+)/i;
const SYSTEM_SIZE_RE = /Size:\s*(\d+)\s*bytes/i;
const SYSTEM_DIMENSIONS_RE = /Original dimensions:\s*(\d+)x(\d+)\s*pixels/i;
// agent-core inlines a single model-facing `<system>` caption next to a
// compressed image upload (buildImageCompressionCaption), which rides along as
// a text part of the persisted user message. That one caption is harness
// metadata, not something the user typed, and its raw markup must never reach
// the bubble (or the edit/preview text derived from `turn.text`). The TUI and
// agent-core strip ONLY that caption — anchored on its fixed opening
// `<system>Image compressed to fit model limits:` (see
// extractImageCompressionCaptions in agent-core) — and reroute it through the
// hidden system-reminder injection. Mirror that narrow targeting here: a
// literal `<system>…</system>` the user pasted themselves (e.g. an XML / prompt
// example) is their own text, not harness metadata, so it survives untouched.
const CAPTION_OPENING = '<system>Image compressed to fit model limits:';
const CAPTION_PATTERN = /<system>Image compressed to fit model limits:[\s\S]*?<\/system>/g;

function stripImageCompressionCaptions(text: string): string {
  if (!text.includes(CAPTION_OPENING)) return text;
  return text.replace(CAPTION_PATTERN, '');
}

function unescapeAttr(value: string): string {
  // &amp; last so a doubly-escaped value isn't decoded twice.
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** Parse a `<video|image|audio path="…"></video>` text part. */
function mediaPathTag(text: string): { kind: 'image' | 'video' | 'audio'; path: string } | null {
  const m = USER_MEDIA_PATH_TAG_RE.exec(text.trim());
  if (!m) return null;
  return { kind: m[1] as 'image' | 'video' | 'audio', path: unescapeAttr(m[2]!) };
}

/** The server materializes uploads into `<cacheDir>/<fileId>.<ext>` (see
 *  materializeVideoToCache in the server prompts route). The browser can't play
 *  a server-local path, but the same bytes are served at getFileUrl(fileId), so
 *  recover the fileId from the cache filename to build a playable URL. Returns
 *  undefined when the basename isn't shaped like a file-store id (`f_…`) — e.g.
 *  TUI cache names (`<uuid>-<label>`) or legacy `/tmp/foo.mp4` paths — so the
 *  caller leaves the raw tag as text instead of fabricating a broken /files url. */
const FILE_STORE_ID_RE = /^f_[A-Za-z0-9]{10,}$/;
function fileIdFromCachePath(p: string): string | undefined {
  const base = p.split(/[\\/]/).at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  const id = dot > 0 ? base.slice(0, dot) : base;
  return FILE_STORE_ID_RE.test(id) ? id : undefined;
}

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

export function toAgentMember(task: AppTask): AgentMember {
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
    text: task.text,
    suspendedReason: task.suspendedReason,
    swarmIndex: task.swarmIndex,
  };
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

  if (kind === 'plan_review') {
    const plan = typeof d['plan'] === 'string' ? d['plan'] : '';
    const path = typeof d['path'] === 'string' ? d['path'] : undefined;
    const rawOptions = Array.isArray(d['options']) ? d['options'] : [];
    const options = rawOptions
      .map((item: unknown): { label: string; description?: string } | null => {
        const it = (item ?? {}) as Record<string, unknown>;
        const label = typeof it['label'] === 'string' ? it['label'] : '';
        if (!label) return null;
        const description = typeof it['description'] === 'string' ? it['description'] : undefined;
        return { label, description };
      })
      .filter((o): o is { label: string; description?: string } => o !== null);
    return { kind: 'plan_review', plan, path, options: options.length > 0 ? options : undefined };
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
   * Normalized signatures already folded into this group, used to drop a
   * duplicate assistant message. The same logical reply can reach us under two
   * different ids — e.g. the streamed copy plus the persisted copy after a
   * reload — and since both share the promptId they'd otherwise merge and
   * render the text + tool cards twice. Dedupe by normalized content (see
   * `contentSig` / `covers`) so a turn shows each reply once.
   */
  foldedSigs: ContentSig[];
}

// ---------------------------------------------------------------------------
// messagesToTurns
// ---------------------------------------------------------------------------

/**
 * Pull the prompt body out of a cron-fire envelope. Server-side, a cron
 * injection reaches the transcript as a user message whose text is wrapped in
 * `<cron-fire …>\n<prompt>\n…\n</prompt>\n</cron-fire>` (see renderCronFireXml
 * in agent-core). We surface only the inner prompt, mirroring the TUI's
 * extractCronPrompt / stripCronEnvelope.
 */
function extractCronPrompt(text: string): string {
  const open = '<prompt>\n';
  const close = '\n</prompt>';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start >= 0 && end >= start + open.length) {
    return text.slice(start + open.length, end);
  }
  return stripCronEnvelope(text);
}

function stripCronEnvelope(text: string): string {
  const lines = text.split('\n');
  if (
    lines.length >= 2 &&
    lines[0]?.startsWith('<cron-fire ') &&
    lines.at(-1) === '</cron-fire>'
  ) {
    return lines.slice(1, -1).join('\n');
  }
  return text;
}

function cronOriginKind(msg: AppMessage): 'cron_job' | 'cron_missed' | undefined {
  const origin = msg.metadata?.['origin'] as { kind?: string } | undefined;
  if (origin?.kind === 'cron_job' || origin?.kind === 'cron_missed') return origin.kind;
  return undefined;
}

function cronPromptText(msg: AppMessage): string {
  const raw = msg.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return extractCronPrompt(raw);
}

function buildCronData(
  msg: AppMessage,
  kind: 'cron_job' | 'cron_missed',
): { text: string; cron: CronTurnData } {
  const origin = (msg.metadata?.['origin'] ?? {}) as Record<string, unknown>;
  const text = cronPromptText(msg);
  if (kind === 'cron_missed') {
    return {
      text,
      cron: { missedCount: typeof origin['count'] === 'number' ? origin['count'] : undefined },
    };
  }
  return {
    text,
    cron: {
      jobId: typeof origin['jobId'] === 'string' ? origin['jobId'] : undefined,
      cron: typeof origin['cron'] === 'string' ? origin['cron'] : undefined,
      recurring: typeof origin['recurring'] === 'boolean' ? origin['recurring'] : undefined,
      coalescedCount: typeof origin['coalescedCount'] === 'number' ? origin['coalescedCount'] : undefined,
      stale: typeof origin['stale'] === 'boolean' ? origin['stale'] : undefined,
    },
  };
}

function buildCronTurn(msg: AppMessage, no: number, kind: 'cron_job' | 'cron_missed'): ChatTurn {
  const { text, cron } = buildCronData(msg, kind);
  return { id: msg.id, role: 'cron', no, text, createdAt: msg.createdAt, cron };
}


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
  if (kind === 'plugin_command') return origin?.trigger === 'user-slash';
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


/** Extract the plan file path from an ExitPlanMode tool result. The approved
 *  output contains `Plan saved to: <path>`; this survives a page reload (unlike
 *  the ephemeral plan_review approval display), so the tool card can still link
 *  to the plan file. */
function parsePlanSavedPath(output: string[] | undefined): string | undefined {
  if (!output || output.length === 0) return undefined;
  const marker = 'Plan saved to: ';
  for (const line of output) {
    if (line.startsWith(marker)) return line.slice(marker.length).trim();
  }
  return undefined;
}

/**
 * Normalize an assistant message's content for duplicate detection. The same
 * logical reply reaches us as both a persisted transcript message and a
 * streamed copy (live deltas, or a resync seed from `in_flight_turn`), and the
 * two differ in ways that must not defeat the dedup: the persisted thinking
 * part may carry a provider `signature`, the seeded tool card may carry
 * progress `outputLines`, and the seeded copy concatenates each stream into a
 * single part instead of keeping the model's part boundaries. Reduce to the
 * concatenated stream text plus sorted tool-call ids — a toolCallId is unique
 * per call, so identical id sets mean the same logical message.
 */
interface ContentSig {
  text: string;
  thinking: string;
  toolIds: string[];
  rest: string[];
}

function contentSig(content: AppMessage['content']): ContentSig {
  let text = '';
  let thinking = '';
  const toolIds: string[] = [];
  const rest: string[] = [];
  for (const c of content) {
    if (c.type === 'text') text += c.text;
    else if (c.type === 'thinking') thinking += c.thinking;
    else if (c.type === 'toolUse') toolIds.push(c.toolCallId);
    else rest.push(JSON.stringify(c));
  }
  toolIds.sort();
  rest.sort();
  return { text, thinking, toolIds, rest };
}

/**
 * Whether an already-folded message's signature fully covers `incoming` —
 * i.e. `incoming` is a duplicate of it. Subset, not equality: a resync seed
 * carries only the still-running tools of a parallel batch (finished ones
 * left `running_tools`), so its id set is a strict subset of the persisted
 * message's. Empty text/thinking in `incoming` adds nothing and counts as
 * covered.
 */
function covers(folded: ContentSig, incoming: ContentSig): boolean {
  if (incoming.text !== '' && incoming.text !== folded.text) return false;
  if (incoming.thinking !== '' && incoming.thinking !== folded.thinking) return false;
  return (
    incoming.toolIds.every((id) => folded.toolIds.includes(id)) &&
    incoming.rest.every((j) => folded.rest.includes(j))
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
  /** Preserved `plan_review` displays keyed by toolCallId — used to link the
   *  ExitPlanMode tool card back to the plan file after the approval resolves. */
  planReviewByToolCallId: Record<string, { plan: string; path?: string }> = {},
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let no = 1;

  // Build approval lookup by toolCallId
  const approvalByTool = new Map<string, AppApprovalRequest>();
  for (const a of approvals) {
    approvalByTool.set(a.toolCallId, a);
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
        // Single `Agent` subagent spawns and all other tools render as a normal
        // tool card: the card shows the fixed args (prompt / description) plus
        // the final result when expanded, while a subagent's live progress
        // streams in the right-side detail panel (sourced from the task).
        const pendingApproval = approvalByTool.get(c.toolCallId);
        const toolCall: ToolCall = {
          id: c.toolCallId,
          name: c.toolName,
          arg: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
          // 'running' until the toolResult is absorbed (resolves to ok/error);
          // flushGroup settles dangling tools of finished turns back to 'ok'.
          status: 'running',
          output: c.outputLines,
          planPath: c.toolName === 'ExitPlanMode' ? planReviewByToolCallId[c.toolCallId]?.path : undefined,
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
          // ExitPlanMode: if the plan path wasn't captured from the (ephemeral)
          // approval display, recover it from the result output so the file link
          // survives a reload for approved plans.
          if (updated.name === 'ExitPlanMode' && !updated.planPath) {
            updated.planPath = parsePlanSavedPath(updated.output);
          }
          g.tools[idx] = updated;
          const blk = g.blocks.find((b) => b.kind === 'tool' && b.tool.id === c.toolCallId);
          if (blk && blk.kind === 'tool') blk.tool = updated;
        }
      }
    }
  }

  /**
   * Fold the volatile extras of a dropped duplicate into the group: a resync
   * seed's tool cards carry live progress (`outputLines` from
   * `in_flight_turn.running_tools[].last_progress`) that the persisted copy
   * lacks — without this, a mid-tool refresh blanks the card's latest output
   * until the next progress frame. Never overwrite output a tool result
   * already settled.
   */
  function mergeVolatileExtras(g: Group, content: AppMessage['content']): void {
    for (const c of content) {
      if (c.type !== 'toolUse' || !c.outputLines?.length) continue;
      const idx = g.tools.findIndex((t) => t.id === c.toolCallId);
      if (idx === -1) continue;
      const tool = g.tools[idx]!;
      if (tool.output !== undefined) continue;
      const updated: ToolCall = { ...tool, output: c.outputLines };
      g.tools[idx] = updated;
      const blk = g.blocks.find((b) => b.kind === 'tool' && b.tool.id === c.toolCallId);
      if (blk && blk.kind === 'tool') blk.tool = updated;
    }
  }

  function resolveMediaUrl(
    c: AppMessage['content'][number],
  ): { url: string; kind: 'image' | 'video'; fileId?: string } | undefined {
    if (c.type === 'image' || c.type === 'video') {
      const kind = c.type;
      const src = c.source;
      if (src.kind === 'url') return { url: src.url, kind };
      if (src.kind === 'base64') return { url: `data:${src.mediaType};base64,${src.data}`, kind };
      if (src.kind === 'file' && getFileUrl) return { url: getFileUrl(src.fileId), kind, fileId: src.fileId };
    }
    if (c.type === 'file' && getFileUrl) {
      if (c.mediaType.startsWith('image/')) return { url: getFileUrl(c.fileId), kind: 'image', fileId: c.fileId };
      if (c.mediaType.startsWith('video/')) return { url: getFileUrl(c.fileId), kind: 'video', fileId: c.fileId };
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
      const cronKind = cronOriginKind(msg);
      // A cron injection always renders as its own standalone turn: agent-core
      // buffers steer input while a turn is in flight and only injects it at the
      // turn boundary, so the cron message does not land between a tool use and
      // its result in practice.
      flushGroup();
      if (cronKind !== undefined) {
        turns.push(buildCronTurn(msg, no++, cronKind));
        continue;
      }
      // Hide system-injected user turns (TUI parity) — they end the previous
      // assistant turn but aren't rendered as a user bubble.
      if (!isDisplayableUserMessage(msg)) continue;

      const origin = msg.metadata?.['origin'] as
        | {
            kind?: string;
            skillName?: string;
            skillArgs?: string;
            pluginId?: string;
            commandName?: string;
            commandArgs?: string;
            trigger?: string;
          }
        | undefined;
      const isSkillActivation =
        origin?.kind === 'skill_activation' && origin?.trigger === 'user-slash';
      const isPluginCommand =
        origin?.kind === 'plugin_command' && origin?.trigger === 'user-slash';

      const textParts: string[] = [];
      const images: { url: string; alt?: string; kind: 'image' | 'video'; fileId?: string }[] = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          if (isSkillActivation) {
            // Skill activation messages carry the raw XML block; we strip it and
            // surface only the user-provided args as the "user input" text.
            textParts.push(origin.skillArgs ?? '');
          } else if (isPluginCommand) {
            // Plugin command turns carry the expanded body; surface only the
            // user-provided args, mirroring skill activations.
            textParts.push(origin.commandArgs ?? '');
          } else {
            // A video/image upload comes back from the server as a
            // `<video path="…"></video>` text tag (see resolvePromptMediaFiles).
            // Render it as an attachment instead of dumping the raw tag into the
            // bubble — recover the fileId from the cache filename so the browser
            // gets a playable URL via getFileUrl.
            const tag = mediaPathTag(c.text);
            if (tag && (tag.kind === 'video' || tag.kind === 'image') && getFileUrl) {
              const fileId = fileIdFromCachePath(tag.path);
              if (fileId) {
                images.push({ url: getFileUrl(fileId), kind: tag.kind, alt: fileId, fileId });
                continue;
              }
            }
            const stripped = stripImageCompressionCaptions(c.text);
            if (stripped !== c.text && stripped.trim().length === 0) continue;
            textParts.push(stripped);
          }
        }
        const media = resolveMediaUrl(c);
        if (media) images.push({ url: media.url, kind: media.kind, alt: c.type === 'file' ? c.name : undefined, fileId: media.fileId });
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
        pluginCommand: isPluginCommand
          ? { pluginId: origin.pluginId!, commandName: origin.commandName!, args: origin.commandArgs }
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
        foldedSigs: [],
        durationMs: msg.durationMs,
      };
    } else if (pendingGroup !== null && pendingGroup.promptId === undefined && pid !== undefined) {
      pendingGroup.promptId = pid;
    }

    const group = pendingGroup;
    if (group === null) continue;

    // Drop an assistant message whose content was already folded into this group
    // (a duplicate streamed-vs-persisted copy sharing the promptId), so the turn
    // doesn't render the same text + tools twice. The duplicate can still carry
    // volatile extras the persisted copy lacks (tool progress), so merge those
    // into the existing cards before dropping it.
    const sig = contentSig(msg.content);
    if (group.promptId !== undefined && group.foldedSigs.some((folded) => covers(folded, sig))) {
      mergeVolatileExtras(group, msg.content);
      continue;
    }
    group.foldedSigs.push(sig);

    absorbContent(group, msg.content);
  }

  flushGroup(true);
  return turns;
}
