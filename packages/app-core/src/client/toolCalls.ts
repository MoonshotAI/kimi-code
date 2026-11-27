import type { AppApprovalRequest, AppTask } from '../api/types';
import { detectShellDanger } from '../lib/shellDanger';
import type { AgentMember, ApprovalBlock, DiffViewLine, ToolMedia } from './types';
import { buildDiffLines, buildVerbatimDiffLines, buildWholeFileDiffLines } from './diffLines';
import { normalizeToolName } from '../lib/normalizeToolName';
import { BROWSER_TOOL_NAME } from '../lib/browserToolName';

const READ_MEDIA_TOOL_RE = /^read[_-]?media(?:file)?$/i;
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const MEDIA_PATH_TAG_RE = /^<(image|video|audio)\s+path="([^"]+)">$/;
const MEDIA_PATH_IN_TEXT_RE = /<(?:image|video|audio)\s+path="([^"]+)">/;
const SYSTEM_MIME_RE = /Mime type:\s*([^.\s]+)/i;
const SYSTEM_SIZE_RE = /Size:\s*(\d+)\s*bytes/i;
const SYSTEM_DIMENSIONS_RE = /Original dimensions:\s*(\d+)x(\d+)\s*pixels/i;
const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

const FILE_STORE_ID_RE =
  /^f_(?:[0-9A-Za-z]{26}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/;
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

function mediaUrlPart(
  part: Record<string, unknown>,
  sessionId?: string,
  getSessionMediaUrl?: (sessionId: string, fileId: string) => string,
): Pick<ToolMedia, 'kind' | 'url' | 'fileId' | 'sessionId'> | null {
  const type = part['type'];
  if (type === 'image' || type === 'video') {
    if (sessionId === undefined) return null;
    const source = part['source'];
    if (typeof source !== 'object' || source === null) return null;
    const fields = source as Record<string, unknown>;
    const fileId = fields['file_id'];
    if (fields['kind'] !== 'session_media' || typeof fileId !== 'string') return null;
    return {
      kind: type,
      url: getSessionMediaUrl?.(sessionId, fileId) ?? '',
      fileId,
      sessionId,
    };
  }
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

function savedAttachmentPath(quoted: string | undefined): string | undefined {
  if (quoted === undefined) return undefined;
  try {
    const path: unknown = JSON.parse(quoted);
    return typeof path === 'string' ? path : undefined;
  } catch {
    return undefined;
  }
}

function browserToolMedia(
  output: unknown,
  sessionId: string | undefined,
  getSessionMediaUrl: ((sessionId: string, fileId: string) => string) | undefined,
): ToolMedia | undefined {
  const parts = Array.isArray(output) ? output : [output];
  let text = '';
  let inline: string | undefined;
  for (const raw of parts) {
    if (typeof raw === 'string') text += `${raw}\n`;
    if (typeof raw !== 'object' || raw === null) continue;
    const part = raw as Record<string, unknown>;
    if (part['type'] === 'text' && typeof part['text'] === 'string') text += `${part['text']}\n`;
    const media = mediaUrlPart(part);
    if (media?.kind === 'image') inline ??= media.url;
  }
  const saved = parseToolResultTrailer(text).notices.find(
    (notice) => MCP_FILE_ID_RE.test(notice[2] ?? '') && notice[3]?.startsWith('image/'),
  );
  if (saved?.[2] && sessionId && getSessionMediaUrl) {
    const bytes = Number(saved[4]);
    return {
      kind: 'image',
      url: getSessionMediaUrl(sessionId, saved[2]),
      fileId: saved[2],
      sessionId,
      mimeType: saved[3],
      bytes: Number.isFinite(bytes) ? bytes : undefined,
      path: savedAttachmentPath(saved[1]),
    };
  }
  if (inline === undefined) return undefined;
  const data = DATA_URL_RE.exec(inline);
  return {
    kind: 'image',
    url: inline,
    mimeType: data?.[1],
    bytes: data?.[2] ? bytesFromBase64(data[2]) : undefined,
  };
}

export function normalizeToolMedia(
  toolName: string,
  output: unknown,
  sessionId?: string,
  getSessionMediaUrl?: (sessionId: string, fileId: string) => string,
): ToolMedia | undefined {
  if (toolName === BROWSER_TOOL_NAME) return browserToolMedia(output, sessionId, getSessionMediaUrl);
  if (!READ_MEDIA_TOOL_RE.test(toolName)) return undefined;
  const parts = contentPartsFromOutput(output);
  if (parts === null) return undefined;

  let path: string | undefined;
  let tagKind: ToolMedia['kind'] | undefined;
  let mimeType: string | undefined;
  let bytes: number | undefined;
  let dimensions: string | undefined;
  let media: Pick<ToolMedia, 'kind' | 'url' | 'fileId' | 'sessionId'> | null = null;

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

    const nextMedia = mediaUrlPart(part, sessionId, getSessionMediaUrl);
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
    fileId:
      media.fileId ??
      (media.url.startsWith('ms://') && path !== undefined
        ? fileIdFromCachePath(path)
        : undefined),
    sessionId: media.sessionId,
    mimeType,
    bytes: Number.isFinite(bytes) ? bytes : undefined,
    dimensions,
  };
}

export function withReadMediaDetails(
  toolName: string,
  media: ToolMedia | undefined,
  output: string,
  note: string | undefined,
): ToolMedia | undefined {
  if (media === undefined || !READ_MEDIA_TOOL_RE.test(toolName)) return media;
  const size = note === undefined ? null : SYSTEM_SIZE_RE.exec(note);
  const dims = note === undefined ? null : SYSTEM_DIMENSIONS_RE.exec(note);
  return {
    ...media,
    path: MEDIA_PATH_IN_TEXT_RE.exec(output)?.[1] ?? media.path,
    bytes: size?.[1] === undefined ? media.bytes : Number(size[1]),
    dimensions: dims?.[1] === undefined || dims[2] === undefined ? media.dimensions : `${dims[1]}x${dims[2]}`,
  };
}

const CAPTION_CLOSING = '</system>';
const TRAILING_ATTACHMENT_NOTICE_RE =
  /(?:Original attachment saved at: ("(?:[^"\\\n]|\\.)*")\n)?Attachment reference: "kimi-file:\/\/([^"\n]+)"\nSession-relative attachment: "(?:[^"\\\n]|\\.)*"\nMIME: "((?:[^"\\\n]|\\.)*)"; size: (\d+) bytes[^\n]*$/;
const MCP_FILE_ID_RE = /^f_mcp_[0-9a-f]+$/;

function trailingCaptionStart(trimmed: string): number {
  if (!trimmed.endsWith(CAPTION_CLOSING)) return -1;
  const start = trimmed.lastIndexOf(CAPTION_OPENING);
  if (start < 0 || trimmed.indexOf(CAPTION_CLOSING, start) !== trimmed.length - CAPTION_CLOSING.length) return -1;
  return start;
}

function parseToolResultTrailer(text: string): { body: string; notices: RegExpExecArray[] } {
  let rest = text;
  const notices: RegExpExecArray[] = [];
  for (;;) {
    const trimmed = rest.trimEnd();
    const captionStart = trailingCaptionStart(trimmed);
    if (captionStart >= 0) {
      rest = trimmed.slice(0, captionStart);
      continue;
    }
    const notice = TRAILING_ATTACHMENT_NOTICE_RE.exec(trimmed);
    if (notice === null) return { body: rest, notices: notices.reverse() };
    notices.push(notice);
    rest = trimmed.slice(0, notice.index);
  }
}

function stripToolResultNotices(text: string): string {
  return parseToolResultTrailer(text).body;
}

export function toolResultText(output: unknown): string | undefined {
  if (typeof output === 'string') return stripToolResultNotices(output);
  if (!Array.isArray(output)) return undefined;
  for (const part of output) {
    if (typeof part === 'string') return stripToolResultNotices(part);
    if (typeof part !== 'object' || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p['type'] === 'text' && typeof p['text'] === 'string') return stripToolResultNotices(p['text']);
  }
  return undefined;
}

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

export function agentIdFromOutput(toolName: string, output: readonly string[] | undefined): string | undefined {
  if (normalizeToolName(toolName) !== 'task') return undefined;
  for (const line of output ?? []) {
    const match = /^agent_id:\s*(\S+)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function toAgentMember(task: AppTask, recoveredCommand?: string): AgentMember {
  return {
    id: task.agentId ?? task.id,
    toolCallId: task.parentToolCallId,
    name: task.description,
    kind: task.kind,
    subagentType: task.subagentType,
    prompt: task.command ?? recoveredCommand,
    model: task.model,
    thinkingEffort: task.thinkingEffort,
    phase:
      task.status === 'completed'
        ? 'completed'
        : task.status === 'failed'
          ? 'failed'
          : task.status === 'cancelled'
            ?
              'cancelled'
            :
              (task.subagentPhase ?? 'working'),
    status: task.status,
    outputLines: task.outputLines,
    text: task.text,
    suspendedReason: task.suspendedReason,
    swarmIndex: task.swarmIndex,
  };
}

export function buildApprovalBlock(a: AppApprovalRequest): ApprovalBlock {
  const d = (a.display ?? {}) as Record<string, unknown>;
  const kind = typeof d['kind'] === 'string' ? d['kind'] : '';
  if (a.toolName === BROWSER_TOOL_NAME) {
    const detail = d['detail'];
    const input = detail !== null && typeof detail === 'object' && !Array.isArray(detail)
      ? detail as Record<string, unknown> : {};
    return { kind: 'browser', input };
  }

  if (kind === 'diff') {
    const path = typeof d['path'] === 'string' ? d['path'] : '';
    if (Array.isArray(d['diff'])) {
      return { kind: 'diff', path, diff: d['diff'] as DiffViewLine[] };
    }
    const before = typeof d['old_text'] === 'string' ? d['old_text'] : (typeof d['before'] === 'string' ? d['before'] : undefined);
    const after = typeof d['new_text'] === 'string' ? d['new_text'] : (typeof d['after'] === 'string' ? d['after'] : undefined);
    if (before !== undefined && after !== undefined) {
      const diff = buildWholeFileDiffLines(before, after) ?? buildVerbatimDiffLines(before, after);
      return { kind: 'diff', path, diff };
    }
    return { kind: 'diff', path, diff: [] };
  }

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
    return { kind: 'fileop', op: operation || kind, path, detail, tool: a.toolName || undefined };
  }

  if (kind === 'shell' || kind === 'command') {
    const command = typeof d['command'] === 'string' ? d['command'] : a.action;
    return {
      kind: 'shell',
      command,
      cwd: typeof d['cwd'] === 'string' ? d['cwd'] : undefined,
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
      tool: a.toolName || undefined,
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

export function parsePlanSavedPath(output: string[] | undefined): string | undefined {
  if (!output || output.length === 0) return undefined;
  const marker = 'Plan saved to: ';
  for (const line of output) {
    if (line.startsWith(marker)) return line.slice(marker.length).trim();
  }
  return undefined;
}
