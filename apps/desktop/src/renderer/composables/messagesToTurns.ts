// apps/web/src/composables/messagesToTurns.ts
// Converts a flat list of AppMessages into ChatTurn[] for rendering.
//
// Key rule: consecutive ASSISTANT messages are merged into ONE ChatTurn unless
// two known promptIds prove that they belong to different prompts.  This
// prevents a multi-step agent turn (think → tool → result → text) from appearing
// as several "kimi >" blocks.  Snapshot messages may omit promptId, so user
// messages and compaction summaries are the hard turn boundaries.
// TOOL-role messages fold their toolResult content into the preceding assistant
// group rather than becoming separate turns.

import type { AppMessage, AppApprovalRequest, AppTask, CompactionMarkerMetadata, SessionPlan } from '../api/types';
import { COMPACTION_MARKER_METADATA_KEY } from '../api/types';
import { detectShellDanger } from '../lib/shellDanger';
import {
  parseTaskNotifications,
  taskNotificationFromMetadata,
} from '../lib/notificationXml';
import type { AgentMember, ApprovalBlock, ChatTurn, CronTurnData, DiffViewLine, ToolCall, ToolMedia, TurnAttachment, TurnBlock } from '../types';
import { buildDiffLines, buildVerbatimDiffLines } from '../lib/diffLines';
import { normalizeToolName } from '../lib/toolMeta';

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
 *  caller leaves the raw tag as text instead of fabricating a broken /files url.
 *
 *  File-store ids come in two shapes: v1 `f_`<26-char ULID> (no hyphens) and
 *  v2 `f_`<randomUUID> (32 hex chars + 4 hyphens). */
const FILE_STORE_ID_RE =
  /^f_(?:[0-9A-Za-z]{26}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/;
/** Same two id shapes, anchored at the start of a `<fileId>-<name>` basename.
    Splitting on the first '-' instead would truncate v2 UUID ids at their
    first inner hyphen. */
const FILE_STORE_ID_AT_START_RE =
  /^f_(?:[0-9A-Za-z]{26}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})(?=-)/;
function fileIdFromCachePath(p: string): string | undefined {
  const base = p.split(/[\\/]/).at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  const id = dot > 0 ? base.slice(0, dot) : base;
  return FILE_STORE_ID_RE.test(id) ? id : undefined;
}

/** A generic file attachment comes back from the server as a text notice (see
 *  resolvePromptMediaFiles in the kap-server prompts route):
 *    Attached file "<name>" (<mime>, <n> bytes): <dir>/<fileId>-<name> — open it with the Read tool
 *  Recover the chip from the notice instead of dumping it — absolute server
 *  path and all — into the bubble. The fileId is matched by shape at the start
 *  of the basename (ULID or UUID, see FILE_STORE_ID_AT_START_RE). Inline-base64
 *  attachments are content-hash named (no fileId): they still become a chip so
 *  the notice stays hidden, just without bytes to open. */
const ATTACHED_FILE_NOTICE_RE =
  /^Attached file "(.+)" \(([^,]+), (\d+) bytes\): (.+) — open it with the Read tool$/;

function attachedFileNotice(
  text: string,
): { name: string; mediaType: string; size: number; fileId?: string } | null {
  const m = ATTACHED_FILE_NOTICE_RE.exec(text.trim());
  if (!m) return null;
  const base = (m[4] ?? '').split(/[\\/]/).at(-1) ?? '';
  const id = FILE_STORE_ID_AT_START_RE.exec(base)?.[0];
  return {
    name: m[1]!,
    mediaType: m[2]!,
    size: Number(m[3]),
    fileId: id !== undefined && FILE_STORE_ID_RE.test(id) ? id : undefined,
  };
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
    // An uploaded video's `video_url` part carries the provider-side `ms://…`
    // id, which the browser cannot load — the daemon serves the same bytes at
    // getFileUrl(fileId), so recover the id from the cache path tag. Only the
    // unplayable `ms://` case: for images the preview prefers fileId over url
    // (useFilePreview), and a crop/downsample read must show the returned
    // data: image, not the original stored file.
    fileId:
      media.url.startsWith('ms://') && path !== undefined
        ? fileIdFromCachePath(path)
        : undefined,
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
export function normalizeToolOutput(output: unknown): string[] | undefined {
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

function agentIdFromOutput(toolName: string, output: readonly string[] | undefined): string | undefined {
  if (normalizeToolName(toolName) !== 'task') return undefined;
  for (const line of output ?? []) {
    const match = /^agent_id:\s*(\S+)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function toAgentMember(task: AppTask): AgentMember {
  return {
    id: task.agentId ?? task.id,
    toolCallId: task.parentToolCallId,
    name: task.description,
    subagentType: task.subagentType,
    model: task.model,
    thinkingEffort: task.thinkingEffort,
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

function buildApprovalBlock(a: AppApprovalRequest): ApprovalBlock {
  const d = (a.display ?? {}) as Record<string, unknown>;
  const kind = typeof d['kind'] === 'string' ? d['kind'] : '';

  if (kind === 'diff') {
    const path = typeof d['path'] === 'string' ? d['path'] : '';
    if (Array.isArray(d['diff'])) {
      return { kind: 'diff', path, diff: d['diff'] as DiffViewLine[] };
    }
    const before = typeof d['old_text'] === 'string' ? d['old_text'] : (typeof d['before'] === 'string' ? d['before'] : undefined);
    const after = typeof d['new_text'] === 'string' ? d['new_text'] : (typeof d['after'] === 'string' ? d['after'] : undefined);
    if (before !== undefined && after !== undefined) {
      // An oversized before/after pair makes the LCS diff refuse (null) — fall
      // back to a verbatim +/- listing so the approval never shows an empty diff.
      const diff = buildDiffLines(before, after) ?? buildVerbatimDiffLines(before, after);
      return { kind: 'diff', path, diff };
    }
    return { kind: 'diff', path, diff: [] };
  }

  // file_io (Write / Edit / Read / Grep / Glob approvals). Write carries the
  // full new-file content; Edit carries the old/new hunk — same mapping the
  // TUI's approval adapter makes (content preview vs before/after diff).
  if (kind === 'file_io') {
    const path = typeof d['path'] === 'string' ? d['path'] : '';
    const operation = typeof d['operation'] === 'string' ? d['operation'] : '';
    if (operation === 'write' && typeof d['content'] === 'string') {
      return { kind: 'file', path, content: d['content'] };
    }
    if (operation === 'edit' && typeof d['before'] === 'string' && typeof d['after'] === 'string') {
      const diff = buildDiffLines(d['before'], d['after']) ?? buildVerbatimDiffLines(d['before'], d['after']);
      return { kind: 'diff', path, diff };
    }
    const detail = typeof d['detail'] === 'string' ? d['detail'] : undefined;
    return { kind: 'fileop', op: operation || kind, path, detail };
  }

  if (kind === 'shell' || kind === 'command') {
    const command = typeof d['command'] === 'string' ? d['command'] : a.action;
    return {
      kind: 'shell',
      command,
      cwd: typeof d['cwd'] === 'string' ? d['cwd'] : undefined,
      // The daemon never fills `danger` — fall back to the display heuristic.
      danger: typeof d['danger'] === 'string' ? d['danger'] : detectShellDanger(command),
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
  /** Server `created_at` of the group's first message (turn start stamp). */
  createdAt?: string;
  /** Server `created_at` of the last absorbed message (turn end stamp). */
  endedAt?: string;
  /** The turn was opened by a goal continuation trigger (provenance marker). */
  goalContinuation?: boolean;
  /**
   * Content signatures already folded into this group, used to drop a duplicate
   * assistant message. The same logical reply can reach us under two different
   * ids — e.g. the streamed copy plus the persisted copy after a reload — and
   * since both share the promptId they'd otherwise merge and render the text +
   * tool cards twice. Dedupe by exact content so a turn shows each reply once.
   */
  seenSigs: Set<string>;
  /**
   * Source messages absorbed into this group, in order (openers, tool-role
   * results, continuation assistants, and the notification/goal-seed user
   * messages that seeded the group). Reported via `collect` so the turns
   * projector can reuse this turn while every source reference is unchanged.
   */
  sources: AppMessage[];
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
 * Whether a USER-role message should be shown. Mirrors agent-core's
 * isAgentReplayUserTurnRecord (agent/replay/turns.ts): only real user input
 * (origin `user`/absent, or a user-typed slash command) is displayed;
 * system-injected user turns (compaction summaries, injections, hook results,
 * retries, system triggers, background tasks, cron) are hidden. The origin
 * arrives via message metadata (see toProtocolMessage in
 * @moonshot-ai/agent-core).
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

/** Dedup signature for message content: adjacent same-kind parts are chunks
 *  of one segment, so merge them before signing — a chunked copy of a message
 *  must match its assembled copy. Thinking's renderer-only timing (startedAt /
 *  durationMs) never persists, so it is dropped from the signature. */
function contentSig(content: AppMessage['content']): string {
  const parts: AppMessage['content'][number][] = [];
  for (const c of content) {
    const prev = parts.at(-1);
    if (c.type === 'text' && prev?.type === 'text') prev.text += c.text;
    else if (c.type === 'thinking' && prev?.type === 'thinking') prev.thinking += c.thinking;
    else if (c.type === 'thinking') parts.push({ type: 'thinking', thinking: c.thinking });
    else parts.push({ ...c });
  }
  return JSON.stringify(parts);
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
  /** Persisted ExitPlanMode records for this session, keyed by toolCallId. */
  plansByToolCallId: Record<string, SessionPlan> = {},
  options?: {
    /** Gutter numbering starts here instead of 1 (suffix projections continuing
     *  a reused prefix). */
    startNo?: number;
    /** Fired for every emitted turn with the source messages that produced it. */
    collect?: (turn: ChatTurn, sources: readonly AppMessage[]) => void;
  },
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let no = options?.startNo ?? 1;
  const collect = options?.collect;

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
    // A contentless group only exists as a freshly seeded goal-continuation
    // turn: keep it at the transcript tail (the turn is live, its first block
    // is still coming); a superseding boundary drops it instead of leaving a
    // ghost turn behind.
    if (
      !final &&
      g.blocks.length === 0 &&
      g.textParts.length === 0 &&
      g.thinkingParts.length === 0 &&
      g.tools.length === 0
    ) {
      return;
    }
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
    const turn: ChatTurn = {
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
      createdAt: g.createdAt,
      endedAt: g.endedAt,
      goalContinuation: g.goalContinuation,
    };
    turns.push(turn);
    collect?.(turn, g.sources);
  }

  function absorbContent(g: Group, content: AppMessage['content']): void {
    // Adjacent same-kind parts within ONE message are stream chunks of a
    // single segment — concatenate verbatim; only a message or non-text
    // boundary earns a '\n'.
    let prevKind: 'text' | 'thinking' | null = null;
    for (const c of content) {
      if (c.type === 'text') {
        if (c.text) {
          if (prevKind === 'text') g.textParts[g.textParts.length - 1]! += c.text;
          else g.textParts.push(c.text);
          // Append to a trailing text block, else open a new one — so a tool
          // call between two text segments splits them into separate blocks.
          const last = g.blocks.at(-1);
          if (last && last.kind === 'text') last.text += (prevKind === 'text' ? '' : '\n') + c.text;
          else g.blocks.push({ kind: 'text', text: c.text });
          prevKind = 'text';
        }
      } else if (c.type === 'thinking') {
        if (c.thinking) {
          if (prevKind === 'thinking') g.thinkingParts[g.thinkingParts.length - 1]! += c.thinking;
          else g.thinkingParts.push(c.thinking);
          // Ordered block too: thinking renders WHERE it happened in the turn,
          // merging consecutive segments (same rule as text blocks above).
          const last = g.blocks.at(-1);
          if (last && last.kind === 'thinking') {
            last.thinking += (prevKind === 'thinking' ? '' : '\n') + c.thinking;
            // Merge timing across the boundary: keep the earliest start and the
            // latest closed end; if either side is still open, the merged block
            // is open too.
            const start = [last.startedAt, c.startedAt].filter((v): v is string => v !== undefined).sort()[0];
            const eitherOpen =
              (last.startedAt !== undefined && last.durationMs === undefined) ||
              (c.startedAt !== undefined && c.durationMs === undefined);
            const closedEnds = [last, c].flatMap((p) =>
              p.startedAt !== undefined && p.durationMs !== undefined
                ? [Date.parse(p.startedAt) + p.durationMs]
                : [],
            );
            last.startedAt = start;
            last.durationMs =
              !eitherOpen && start !== undefined && closedEnds.length > 0
                ? Math.max(...closedEnds) - Date.parse(start)
                : undefined;
          } else {
            g.blocks.push({
              kind: 'thinking',
              thinking: c.thinking,
              startedAt: c.startedAt,
              durationMs: c.durationMs,
            });
          }
          prevKind = 'thinking';
        }
      } else if (c.type === 'toolUse') {
        prevKind = null;
        // Single `Agent` subagent spawns and all other tools render as a normal
        // tool card: the card shows the fixed args (prompt / description) plus
        // the final result when expanded, while a subagent's live progress
        // streams in the right-side detail panel (sourced from the task).
        const pendingApproval = approvalByTool.get(c.toolCallId);
        const persistedPlan =
          c.toolName === 'ExitPlanMode' ? plansByToolCallId[c.toolCallId] : undefined;
        const toolCall: ToolCall = {
          id: c.toolCallId,
          name: c.toolName,
          arg: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
          agentId:
            normalizeToolName(c.toolName) === 'task'
              ? c.agentRefs?.find((ref) => ref.role !== 'member')?.agentId ??
                c.agentRefs?.[0]?.agentId
              : undefined,
          // 'running' until the toolResult is absorbed (resolves to ok/error);
          // flushGroup settles dangling tools of finished turns back to 'ok'.
          status: 'running',
          output: c.outputLines,
          plan: persistedPlan,
          planPath:
            c.toolName === 'ExitPlanMode'
              ? persistedPlan?.path ?? planReviewByToolCallId[c.toolCallId]?.path
              : undefined,
        };
        g.tools.push(toolCall);
        g.blocks.push({ kind: 'tool', tool: toolCall });
        if (pendingApproval) {
          g.approval = buildApprovalBlock(pendingApproval);
          g.approvalId = pendingApproval.approvalId;
        }
      } else if (c.type === 'toolResult') {
        prevKind = null;
        // Update the matching tool call status within this group (both the flat
        // tools[] and the ordered block that renders it).
        const idx = g.tools.findIndex((t) => t.id === c.toolCallId);
        if (idx !== -1) {
          const tool = g.tools[idx]!;
          const output = normalizeToolOutput(c.output);
          const updated: ToolCall = {
            ...tool,
            status: c.isError ? 'error' : 'ok',
            output,
            media: c.isError ? undefined : normalizeToolMedia(tool.name, c.output),
            agentId: tool.agentId ?? agentIdFromOutput(tool.name, output),
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
      } else {
        prevKind = null;
      }
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
      const compactionTurn: ChatTurn = {
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
      };
      turns.push(compactionTurn);
      collect?.(compactionTurn, [msg]);
      continue;
    }

    // User messages flush the pending group and start a new user turn
    if (msg.role === 'user') {
      const cronKind = cronOriginKind(msg);
      const userOriginKind = (
        msg.metadata?.['origin'] as { kind?: string } | undefined
      )?.kind;
      // Hidden injections (todo-list reminders …) are stream noise, NOT turn
      // boundaries: they land mid-turn between assistant messages, so flushing
      // on them would fragment one agent turn into several chat turns (visible
      // as repeated folded rows with nothing in between). A Skill tool call's
      // loaded-skill message (trigger model-tool / nested-skill) is the same
      // mid-turn noise — only a user-slash activation opens a real user turn
      // (isAgentReplayUserTurnRecord parity). Every other hidden user message
      // (hook results, retries, system triggers, …) keeps its boundary. Cron
      // injections become their own turn below.
      const isToolSkillActivation =
        userOriginKind === 'skill_activation' &&
        (msg.metadata?.['origin'] as { trigger?: string } | undefined)?.trigger !== 'user-slash';
      if (cronKind === undefined && (userOriginKind === 'injection' || isToolSkillActivation)) {
        continue;
      }
      // Task notifications are the same mid-turn noise boundary-wise, but they
      // DO render: each <notification> block becomes a notification block in
      // the pending assistant group — a notification that opens a new turn
      // seeds a group of its own, and the next assistant message merges in via
      // the missing-promptId rule. Text with no well-formed block keeps the
      // old hidden behaviour. The origin kind is 'task' (current; the legacy
      // spellings are 'background_task' and the step-request kind
      // 'task_notification').
      if (
        cronKind === undefined &&
        (userOriginKind === 'task' ||
          userOriginKind === 'background_task' ||
          userOriginKind === 'task_notification')
      ) {
        const text = msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        const structuredNotification = taskNotificationFromMetadata(msg.metadata);
        const notifications =
          structuredNotification !== undefined
            ? [structuredNotification]
            : parseTaskNotifications(text);
        if (notifications.length > 0) {
          pendingGroup ??= {
            id: msg.id,
            promptId: undefined,
            textParts: [],
            thinkingParts: [],
            tools: [],
            blocks: [],
            approval: undefined,
            approvalId: undefined,
            seenSigs: new Set<string>(),
            sources: [msg],
            createdAt: msg.createdAt,
          };
          for (const notification of notifications) {
            pendingGroup.blocks.push({
              kind: 'notification',
              notification: { ...notification, createdAt: msg.createdAt },
            });
          }
        }
        continue;
      }
      // A cron injection always renders as its own standalone turn: agent-core
      // buffers steer input while a turn is in flight and only injects it at the
      // turn boundary, so the cron message does not land between a tool use and
      // its result in practice.
      flushGroup();
      if (cronKind !== undefined) {
        const cronTurn = buildCronTurn(msg, no++, cronKind);
        turns.push(cronTurn);
        collect?.(cronTurn, [msg]);
        continue;
      }
      // A goal continuation opens the next assistant turn: the (long,
      // machine-written) prompt stays hidden, and the turn is seeded
      // IMMEDIATELY with its provenance marker — the marker (and the undo
      // guard keyed off it) applies from the moment the trigger lands, not
      // only once the first assistant block exists. A still-empty seeded
      // group is dropped by the next boundary (see flushGroup).
      if (
        userOriginKind === 'system_trigger' &&
        (msg.metadata?.['origin'] as { name?: string } | undefined)?.name === 'goal_continuation'
      ) {
        pendingGroup = {
          id: msg.id,
          promptId: undefined,
          textParts: [],
          thinkingParts: [],
          tools: [],
          blocks: [],
          approval: undefined,
          approvalId: undefined,
          seenSigs: new Set<string>(),
          sources: [msg],
          createdAt: msg.createdAt,
          goalContinuation: true,
        };
        continue;
      }
      // Hide system-injected user turns (TUI parity) — they end the previous
      // assistant turn (a seeded-but-empty goal turn included) but aren't
      // rendered as a user bubble.
      if (!isDisplayableUserMessage(msg)) {
        continue;
      }
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
      const attachments: TurnAttachment[] = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          if (isSkillActivation) {
            // Skill activation messages carry the rendered skill-prompt XML;
            // the bubble replaces it with a command card plus the user args
            // (set once after the loop — pushing per text part would duplicate
            // the args now that uploads add notice parts to the same message).
            // Those uploads come back exactly like the plain-message path:
            // media as `<video|image path="…">` tags, other files as
            // "Attached file …" notices — recover the chips the same way.
            const tag = mediaPathTag(c.text);
            if (tag && (tag.kind === 'video' || tag.kind === 'image') && getFileUrl) {
              const fileId = fileIdFromCachePath(tag.path);
              if (fileId) {
                attachments.push({ url: getFileUrl(fileId), kind: tag.kind, fileId });
                continue;
              }
            }
            const attached = attachedFileNotice(c.text);
            if (attached) {
              attachments.push({
                kind: 'file',
                // No recoverable fileId (inline-base64 upload) → no URL: the
                // chip renders name/size but stays non-clickable.
                url: attached.fileId && getFileUrl ? getFileUrl(attached.fileId) : '',
                fileId: attached.fileId,
                name: attached.name,
                mediaType: attached.mediaType,
                size: attached.size,
              });
            }
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
                attachments.push({ url: getFileUrl(fileId), kind: tag.kind, fileId });
                continue;
              }
            }
            // A generic file upload comes back as an "Attached file …" notice;
            // recover the chip the same way (see attachedFileNotice).
            const attached = attachedFileNotice(c.text);
            if (attached) {
              attachments.push({
                kind: 'file',
                // No recoverable fileId (inline-base64 upload) → no URL: the
                // chip renders name/size but stays non-clickable.
                url: attached.fileId && getFileUrl ? getFileUrl(attached.fileId) : '',
                fileId: attached.fileId,
                name: attached.name,
                mediaType: attached.mediaType,
                size: attached.size,
              });
              continue;
            }
            const stripped = stripImageCompressionCaptions(c.text);
            if (stripped !== c.text && stripped.trim().length === 0) continue;
            textParts.push(stripped);
          }
        }
        const media = resolveMediaUrl(c);
        if (media) {
          attachments.push({
            url: media.url,
            kind: media.kind,
            name: c.type === 'file' ? c.name : undefined,
            fileId: media.fileId,
          });
          continue;
        }
        // Non-media files (pdf/zip/yaml/…) carry no playable URL, but the chip
        // still renders them with name/size and a download action.
        if (c.type === 'file' && getFileUrl) {
          attachments.push({
            kind: 'file',
            url: getFileUrl(c.fileId),
            fileId: c.fileId,
            name: c.name,
            mediaType: c.mediaType || undefined,
            size: c.size,
          });
        }
      }
      const userTurn: ChatTurn = {
        id: msg.id,
        role: 'user',
        no: no++,
        // Skill activations surface only the args as the bubble text (the
        // skill-prompt XML text parts are dropped above); everything else
        // joins its kept text parts.
        text: isSkillActivation ? (origin?.skillArgs ?? '') : textParts.join('\n'),
        attachments: attachments.length > 0 ? attachments : undefined,
        skillActivation: isSkillActivation
          ? { name: origin.skillName!, args: origin.skillArgs }
          : undefined,
        pluginCommand: isPluginCommand
          ? { pluginId: origin.pluginId!, commandName: origin.commandName!, args: origin.commandArgs }
          : undefined,
        createdAt: msg.createdAt,
      };
      turns.push(userTurn);
      collect?.(userTurn, [msg]);
      continue;
    }

    // Tool-role messages (toolResult) fold into the pending group's tool list
    if (msg.role === 'tool') {
      if (pendingGroup) {
        pendingGroup.sources.push(msg);
        absorbContent(pendingGroup, msg.content);
        pendingGroup.endedAt = msg.createdAt;
      }
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
        sources: [],
        durationMs: msg.durationMs,
        createdAt: msg.createdAt,
      };
    } else if (pendingGroup !== null && pendingGroup.promptId === undefined && pid !== undefined) {
      pendingGroup.promptId = pid;
    }

    const group = pendingGroup;
    if (group === null) continue;

    // Drop an assistant message whose content was already folded into this group
    // (a duplicate streamed-vs-persisted copy sharing the promptId), so the turn
    // doesn't render the same text + tools twice.
    const sig = contentSig(msg.content);
    if (group.promptId !== undefined && group.seenSigs.has(sig)) continue;
    group.seenSigs.add(sig);
    group.sources.push(msg);

    // Assistant absorb site also tracks the daemon's own turn measurement:
    // the reducer stamps durationMs on the turn's LAST assistant message at
    // turn.ended, so the last stamped value wins (the group-opening read only
    // ever sees it for single-step turns).
    if (msg.durationMs !== undefined) group.durationMs = msg.durationMs;
    absorbContent(group, msg.content);
    // Only a LATER message proves the turn spanned time — stamping the end
    // from the opener itself would read as Worked 0s for single-message turns
    // (an in-place completed reply shares one created_at).
    if (msg.id !== group.id) group.endedAt = msg.createdAt;
  }

  flushGroup(true);
  return turns;
}
