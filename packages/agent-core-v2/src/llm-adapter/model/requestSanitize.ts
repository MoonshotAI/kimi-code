import type { ProtocolName } from '#human/llm/protocol/base';

import type { ContentPart, Message, Role, Tool, ToolCall } from '../contract/message';

export const REQUEST_SANITIZE_ENV = 'KIMI_CODE_REQUEST_SANITIZE';

export const EMPTY_TOOL_OUTPUT_PLACEHOLDER = 'Tool output is empty.';

export const OMITTED_TOOL_VIDEO_PLACEHOLDER =
  '[video content omitted: not supported by this endpoint]';

export const OMITTED_TOOL_AUDIO_PLACEHOLDER =
  '[audio content omitted: not supported by this endpoint]';

export type RequestSanitizeRepairKind =
  | 'lone_surrogate'
  | 'empty_tool_content'
  | 'unsupported_tool_media';

export interface RequestSanitizeRepair {
  readonly kind: RequestSanitizeRepairKind;
  readonly role: Role;
  readonly toolCallId?: string;
  readonly count: number;
}

export interface SanitizeRequestMessagesOptions {
  readonly protocol?: ProtocolName;
}

export interface SanitizeRequestMessagesResult {
  readonly messages: readonly Message[];
  readonly repairs: RequestSanitizeRepair[];
}

type Env = Readonly<Record<string, string | undefined>>;

export function resolveRequestSanitizeEnabled(env: Env = process.env): boolean {
  return env[REQUEST_SANITIZE_ENV]?.trim().toLowerCase() !== 'off';
}

interface SurrogateFix {
  readonly text: string;
  readonly count: number;
}

const REPLACEMENT_CHARACTER = '�';

function fixLoneSurrogates(value: string): SurrogateFix {
  let out: string[] | undefined;
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- raw UTF-16 halves are the point here
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // oxlint-disable-next-line unicorn/prefer-code-point -- raw UTF-16 halves are the point here
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (out !== undefined) out.push(value.slice(i, i + 2));
        i++;
        continue;
      }
      out ??= [value.slice(0, i)];
      out.push(REPLACEMENT_CHARACTER);
      count++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out ??= [value.slice(0, i)];
      out.push(REPLACEMENT_CHARACTER);
      count++;
    } else if (out !== undefined) {
      out.push(value[i]!);
    }
  }
  return { text: out === undefined ? value : out.join(''), count };
}

interface Tally {
  count: number;
}

type ToolCallIdMapper = (rawId: string, tally: Tally) => string;

function createToolCallIdMapper(): ToolCallIdMapper {
  const assignedByRaw = new Map<string, string>();
  const taken = new Set<string>();
  return (rawId, tally) => {
    const base = fixString(rawId, tally);
    const cached = assignedByRaw.get(rawId);
    if (cached !== undefined) return cached;
    let assigned = base;
    if (taken.has(assigned)) {
      let n = 2;
      assigned = `${base}__${n}`;
      while (taken.has(assigned)) {
        n += 1;
        assigned = `${base}__${n}`;
      }
    }
    taken.add(assigned);
    assignedByRaw.set(rawId, assigned);
    return assigned;
  };
}

function fixString(value: string, tally: Tally): string {
  const fix = fixLoneSurrogates(value);
  tally.count += fix.count;
  return fix.text;
}

function fixOptionalString(value: string | undefined, tally: Tally): string | undefined {
  return value === undefined ? undefined : fixString(value, tally);
}

function sanitizeJsonValue(value: unknown, tally: Tally): unknown {
  if (typeof value === 'string') return fixString(value, tally);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = sanitizeJsonValue(item, tally);
      changed = changed || next !== item;
      return next;
    });
    return changed ? out : value;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = sanitizeJsonValue(entry, tally);
      changed = changed || next !== entry;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

function sanitizePart(part: ContentPart, tally: Tally): ContentPart {
  switch (part.type) {
    case 'text': {
      const text = fixString(part.text, tally);
      return text === part.text ? part : { ...part, text };
    }
    case 'think': {
      const think = fixString(part.think, tally);
      const encrypted = fixOptionalString(part.encrypted, tally);
      return think === part.think && encrypted === part.encrypted
        ? part
        : { ...part, think, encrypted };
    }
    case 'image_url': {
      const url = fixString(part.imageUrl.url, tally);
      const id = fixOptionalString(part.imageUrl.id, tally);
      const name = fixOptionalString(part.imageUrl.name, tally);
      return url === part.imageUrl.url && id === part.imageUrl.id && name === part.imageUrl.name
        ? part
        : { ...part, imageUrl: { ...part.imageUrl, url, id, name } };
    }
    case 'audio_url': {
      const url = fixString(part.audioUrl.url, tally);
      const id = fixOptionalString(part.audioUrl.id, tally);
      return url === part.audioUrl.url && id === part.audioUrl.id
        ? part
        : { ...part, audioUrl: { ...part.audioUrl, url, id } };
    }
    case 'video_url': {
      const url = fixString(part.videoUrl.url, tally);
      const id = fixOptionalString(part.videoUrl.id, tally);
      const name = fixOptionalString(part.videoUrl.name, tally);
      return url === part.videoUrl.url && id === part.videoUrl.id && name === part.videoUrl.name
        ? part
        : { ...part, videoUrl: { ...part.videoUrl, url, id, name } };
    }
  }
}

function sanitizeContent(content: ContentPart[], tally: Tally): ContentPart[] {
  let changed = false;
  const out = content.map((part) => {
    const next = sanitizePart(part, tally);
    changed = changed || next !== part;
    return next;
  });
  return changed ? out : content;
}

function sanitizeToolCalls(toolCalls: ToolCall[], tally: Tally, mapId: ToolCallIdMapper): ToolCall[] {
  let changed = false;
  const out = toolCalls.map((call) => {
    const id = mapId(call.id, tally);
    const name = fixString(call.name, tally);
    const args = call.arguments === null ? null : fixString(call.arguments, tally);
    const rawId = fixOptionalString(call.rawId, tally);
    const extras =
      call.extras === undefined
        ? undefined
        : (sanitizeJsonValue(call.extras, tally) as Record<string, unknown>);
    if (
      id === call.id &&
      name === call.name &&
      args === call.arguments &&
      rawId === call.rawId &&
      extras === call.extras
    ) {
      return call;
    }
    changed = true;
    return { ...call, id, name, arguments: args, rawId, extras };
  });
  return changed ? out : toolCalls;
}

function sanitizeTools(tools: readonly Tool[] | undefined, tally: Tally): readonly Tool[] | undefined {
  if (tools === undefined) return undefined;
  let changed = false;
  const out = tools.map((tool) => {
    const name = fixString(tool.name, tally);
    const description = fixString(tool.description, tally);
    const parameters = sanitizeJsonValue(tool.parameters, tally) as Record<string, unknown>;
    if (name === tool.name && description === tool.description && parameters === tool.parameters) {
      return tool;
    }
    changed = true;
    return { ...tool, name, description, parameters };
  });
  return changed ? out : tools;
}

const TOOL_DATA_MEDIA_DOWNGRADE_PROTOCOLS: ReadonlySet<ProtocolName> = new Set(['anthropic']);

function downgradeToolDataMedia(
  content: ContentPart[],
  protocol: ProtocolName | undefined,
  toolCallId: string | undefined,
  repairs: RequestSanitizeRepair[],
): ContentPart[] {
  if (protocol !== undefined && !TOOL_DATA_MEDIA_DOWNGRADE_PROTOCOLS.has(protocol)) return content;
  let count = 0;
  const out = content.map((part): ContentPart => {
    if (part.type === 'video_url' && part.videoUrl.url.startsWith('data:')) {
      count++;
      return { type: 'text', text: OMITTED_TOOL_VIDEO_PLACEHOLDER };
    }
    if (part.type === 'audio_url' && part.audioUrl.url.startsWith('data:')) {
      count++;
      return { type: 'text', text: OMITTED_TOOL_AUDIO_PLACEHOLDER };
    }
    return part;
  });
  if (count === 0) return content;
  repairs.push({ kind: 'unsupported_tool_media', role: 'tool', toolCallId, count });
  return out;
}

function isWireVisibleToolPart(part: ContentPart, protocol: ProtocolName | undefined): boolean {
  switch (part.type) {
    case 'text':
      return part.text.length > 0;
    case 'think':
      return false;
    case 'image_url':
    case 'video_url':
      return true;
    case 'audio_url':
      return protocol !== 'anthropic';
  }
}

function padEmptyToolContent(
  content: ContentPart[],
  protocol: ProtocolName | undefined,
  toolCallId: string | undefined,
  repairs: RequestSanitizeRepair[],
): ContentPart[] {
  if (content.some((part) => isWireVisibleToolPart(part, protocol))) return content;
  repairs.push({ kind: 'empty_tool_content', role: 'tool', toolCallId, count: 1 });
  return [{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }];
}

function sanitizeMessage(
  message: Message,
  protocol: ProtocolName | undefined,
  repairs: RequestSanitizeRepair[],
  mapId: ToolCallIdMapper,
): Message {
  const tally: Tally = { count: 0 };
  let content = sanitizeContent(message.content, tally);
  if (message.role === 'tool') {
    content = downgradeToolDataMedia(content, protocol, message.toolCallId, repairs);
    content = padEmptyToolContent(content, protocol, message.toolCallId, repairs);
  }
  const toolCalls = sanitizeToolCalls(message.toolCalls, tally, mapId);
  const name = fixOptionalString(message.name, tally);
  const toolCallId =
    message.toolCallId === undefined ? undefined : mapId(message.toolCallId, tally);
  const tools = sanitizeTools(message.tools, tally);
  if (tally.count > 0) {
    repairs.push({
      kind: 'lone_surrogate',
      role: message.role,
      toolCallId: message.toolCallId,
      count: tally.count,
    });
  }
  if (
    content === message.content &&
    toolCalls === message.toolCalls &&
    name === message.name &&
    toolCallId === message.toolCallId &&
    tools === message.tools
  ) {
    return message;
  }
  return { ...message, content, toolCalls, name, toolCallId, tools };
}

export function sanitizeRequestMessages(
  messages: readonly Message[],
  options: SanitizeRequestMessagesOptions = {},
): SanitizeRequestMessagesResult {
  const repairs: RequestSanitizeRepair[] = [];
  const mapId = createToolCallIdMapper();
  let changed = false;
  const out = messages.map((message) => {
    const next = sanitizeMessage(message, options.protocol, repairs, mapId);
    changed = changed || next !== message;
    return next;
  });
  return { messages: changed ? out : messages, repairs };
}
