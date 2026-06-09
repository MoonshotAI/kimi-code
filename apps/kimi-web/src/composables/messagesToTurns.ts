// apps/kimi-web/src/composables/messagesToTurns.ts
// Converts a flat list of AppMessages into ChatTurn[] for rendering.
//
// Key rule: consecutive ASSISTANT messages that share the same non-undefined
// promptId are merged into ONE ChatTurn.  This prevents a multi-step agent
// turn (think → tool → result → text) from appearing as several "kimi >"
// blocks.  TOOL-role messages fold their toolResult content into the
// preceding assistant group rather than becoming separate turns.
//
// Fallback: if promptId is undefined on both the pending group and the
// incoming message they are NOT merged (one turn per message, old behaviour).

import type { AppMessage, AppApprovalRequest } from '../api/types';
import type { ApprovalBlock, ChatTurn, DiffLine, ToolCall } from '../types';

/**
 * Tool output is `string | ContentPart[]` (agent-core). A string splits into
 * lines; a ContentPart[] (e.g. from media tools) is flattened: text/think parts
 * become lines, image/media parts become a `[image]`-style placeholder — instead
 * of dumping raw `[{"type":"text",...}]` JSON into the UI.
 */
function normalizeToolOutput(output: unknown): string[] | undefined {
  if (output == null) return undefined;
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
        title: typeof it['title'] === 'string' ? it['title'] : String(it['title'] ?? ''),
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
  /** The shared promptId (never undefined inside a group; empty string = no promptId) */
  promptId: string;
  textParts: string[];
  thinkingParts: string[];
  tools: ToolCall[];
  approval: ApprovalBlock | undefined;
  approvalId: string | undefined;
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

export function messagesToTurns(
  messages: AppMessage[],
  approvals: AppApprovalRequest[],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let no = 1;

  // Build approval lookup by toolCallId
  const approvalByTool = new Map<string, AppApprovalRequest>();
  for (const a of approvals) {
    approvalByTool.set(a.toolCallId, a);
  }

  let pendingGroup: Group | null = null;

  function flushGroup(): void {
    if (!pendingGroup) return;
    const g = pendingGroup;
    pendingGroup = null;
    turns.push({
      id: g.id,
      role: 'assistant',
      no: no++,
      text: g.textParts.join('\n'),
      thinking: g.thinkingParts.length > 0 ? g.thinkingParts.join('\n') : undefined,
      tools: g.tools.length > 0 ? g.tools : undefined,
      approval: g.approval,
      approvalId: g.approvalId,
    });
  }

  function absorbContent(g: Group, content: AppMessage['content']): void {
    for (const c of content) {
      if (c.type === 'text') {
        if (c.text) g.textParts.push(c.text);
      } else if (c.type === 'thinking') {
        if (c.thinking) g.thinkingParts.push(c.thinking);
      } else if (c.type === 'toolUse') {
        const pendingApproval = approvalByTool.get(c.toolCallId);
        const toolCall: ToolCall = {
          id: c.toolCallId,
          name: c.toolName,
          arg: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
          status: pendingApproval ? 'running' : 'ok',
        };
        g.tools.push(toolCall);
        if (pendingApproval) {
          g.approval = buildApprovalBlock(pendingApproval);
          g.approvalId = pendingApproval.approvalId;
        }
      } else if (c.type === 'toolResult') {
        // Update the matching tool call status within this group
        const idx = g.tools.findIndex((t) => t.id === c.toolCallId);
        if (idx !== -1) {
          const existing = g.tools[idx]!;
          g.tools[idx] = {
            ...existing,
            status: c.isError ? 'error' : 'ok',
            output: normalizeToolOutput(c.output),
          };
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    // User messages flush the pending group and start a new user turn
    if (msg.role === 'user') {
      flushGroup();
      const textParts: string[] = [];
      for (const c of msg.content) {
        if (c.type === 'text') textParts.push(c.text);
      }
      turns.push({
        id: msg.id,
        role: 'user',
        no: no++,
        text: textParts.join('\n'),
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
    // Merge rule: both the pending group and the incoming message must have a
    // defined, equal promptId.  If either is undefined → start a new group
    // (fallback to old one-turn-per-message behaviour).
    const pid = msg.promptId;

    const continuesGroup =
      pendingGroup !== null &&
      pid !== undefined &&
      pendingGroup.promptId !== '' &&
      pendingGroup.promptId === pid;

    if (!continuesGroup) {
      flushGroup();
      pendingGroup = {
        id: msg.id,
        promptId: pid ?? '', // empty string = "no promptId" sentinel
        textParts: [],
        thinkingParts: [],
        tools: [],
        approval: undefined,
        approvalId: undefined,
        seenSigs: new Set<string>(),
      };
    }

    // Drop an assistant message whose content was already folded into this group
    // (a duplicate streamed-vs-persisted copy sharing the promptId), so the turn
    // doesn't render the same text + tools twice.
    const sig = JSON.stringify(msg.content);
    if (pendingGroup!.seenSigs.has(sig)) continue;
    pendingGroup!.seenSigs.add(sig);

    absorbContent(pendingGroup!, msg.content);
  }

  flushGroup();
  return turns;
}
