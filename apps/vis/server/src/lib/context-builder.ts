import type {
  AnnotatedMessage,
  ContentPart,
  NotificationRecord,
  ProjectedStateSummary,
  SessionInitializedRecord,
  SessionState,
  ToolCallEntry,
  UserInputPart,
  VisWireRecord,
} from './types';

const PERSISTED_OUTPUT_RE = /^<persisted-output path="([^"]+)">/;

/**
 * Extract the on-disk path from a `<persisted-output path="...">` marker
 * at the start of a tool-result output. Returns null when no marker is
 * present.
 */
export function extractPersistedOutputPath(text: string): string | null {
  const m = PERSISTED_OUTPUT_RE.exec(text.trimStart());
  return m?.[1] ?? null;
}

/**
 * Render a notification's `data` payload as the XML string that the live
 * ContextMemory would inject as a user-role message.
 */
export function renderNotificationXml(data: NotificationRecord['data']): string {
  const id = escAttr(data.id);
  const category = escAttr(data.category);
  const type = escAttr(data.type);
  const sourceKind = escAttr(data.source_kind);
  const sourceId = escAttr(data.source_id);
  const title = data.title;
  const severity = data.severity;
  const body = data.body;

  const lines: string[] = [
    `<notification id="${id}" category="${category}" type="${type}" source_kind="${sourceKind}" source_id="${sourceId}">`,
  ];
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (severity.length > 0) lines.push(`Severity: ${severity}`);
  if (body.length > 0) lines.push(body);

  // background_task notifications append a <task-notification> block
  // with the last 20 lines / 3000 chars of tail_output, matching what
  // the live projector would emit.
  if (data.source_kind === 'background_task') {
    const tail = (data as { tail_output?: string }).tail_output ?? '';
    if (tail.length > 0) {
      const tailLines = tail.split('\n');
      const trimmed = (tailLines.length > 20 ? tailLines.slice(-20) : tailLines)
        .join('\n')
        .slice(-3000);
      lines.push('<task-notification>', trimmed, '</task-notification>');
    }
  }

  lines.push('</notification>');
  return lines.join('\n');
}

function escAttr(s: string): string {
  if (s.length === 0) return 'unknown';
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export interface BuildAnnotatedOptions {
  /** When true (default), rewind-orphaned records are kept with `out_of_context: true`. */
  preserveOutOfContext?: boolean;
}

/**
 * Walk `records` in order and emit an `AnnotatedMessage[]` that includes
 * notification and system_reminder synthetic user messages. Tracks a
 * numeric turn counter so `context_edit operation:'rewind' to_turn:N`
 * can flag later messages as out-of-context.
 */
export function buildAnnotatedMessages(
  records: readonly VisWireRecord[],
  options?: BuildAnnotatedOptions,
): AnnotatedMessage[] {
  const preserveOutOfContext = options?.preserveOutOfContext ?? true;

  // Track (messageIndex -> turnCounterAtEmission) so a rewind can mark
  // later emissions as out_of_context.
  let annotated: AnnotatedMessage[] = [];
  const msgTurnIdx: number[] = [];

  let turnCounter = 0;

  // An assistant message is not a single record — it's coalesced from
  // `step_begin → (content_part|tool_call)* → step_end` atoms anchored
  // by `step_uuid`. We buffer the in-flight step here and emit a
  // synthetic assistant message on step_end.
  interface StepBuffer {
    seq: number;
    step_uuid: string;
    text: string;
    think: string;
    think_encrypted?: string | undefined;
    tool_calls: ToolCallEntry[];
  }
  let currentStep: StepBuffer | null = null;

  const flushStep = (): void => {
    if (currentStep === null) return;
    const s = currentStep;
    const content: ContentPart[] = [];
    if (s.think.length > 0) {
      const part: ContentPart = { type: 'think', think: s.think };
      if (s.think_encrypted !== undefined) part['encrypted'] = s.think_encrypted;
      content.push(part);
    }
    if (s.text.length > 0) content.push({ type: 'text', text: s.text });
    if (content.length > 0 || s.tool_calls.length > 0) {
      pushMsg({
        seq: s.seq,
        message: { role: 'assistant', content, tool_calls: s.tool_calls },
        origin: { kind: 'assistant' },
        is_ephemeral: false,
        out_of_context: false,
      });
    }
    currentStep = null;
  };

  const pushMsg = (m: AnnotatedMessage): void => {
    annotated.push(m);
    msgTurnIdx.push(turnCounter);
  };

  for (const r of records) {
    switch (r.type) {
      case 'turn_begin': {
        // Close any dangling step so turn boundaries stay clean.
        flushStep();
        turnCounter += 1;
        break;
      }

      case 'user_message': {
        const text = userContentToText(r.content);
        pushMsg({
          seq: r.seq,
          message: {
            role: 'user',
            content: [{ type: 'text', text }],
            tool_calls: [],
          },
          origin: { kind: 'user' },
          is_ephemeral: false,
          out_of_context: false,
        });
        break;
      }

      case 'step_begin': {
        // Any prior unclosed step gets flushed; protocol guarantees order
        // step_begin → … → step_end, but crashes can leave orphans.
        flushStep();
        currentStep = {
          seq: r.seq,
          step_uuid: r.uuid,
          text: '',
          think: '',
          tool_calls: [],
        };
        break;
      }

      case 'content_part': {
        if (currentStep === null) break;
        if (currentStep.step_uuid !== r.step_uuid) break;
        if (r.part.kind === 'text') {
          currentStep.text += r.part.text;
        } else {
          currentStep.think += r.part.think;
          if (r.part.encrypted !== undefined) {
            currentStep.think_encrypted = r.part.encrypted;
          }
        }
        break;
      }

      case 'tool_call': {
        if (currentStep === null) break;
        if (currentStep.step_uuid !== r.step_uuid) break;
        currentStep.tool_calls.push({
          type: 'function',
          id: r.data.tool_call_id,
          name: r.data.tool_name,
          arguments: r.data.args === undefined ? null : JSON.stringify(r.data.args),
        });
        break;
      }

      case 'step_end': {
        // step_end may carry usage; we drop it here since the annotated
        // message already represents what the LLM emitted. Usage lives
        // on the wire record itself for the Wire tab to show.
        flushStep();
        break;
      }

      case 'tool_result': {
        const text = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
        const msg: AnnotatedMessage = {
          seq: r.seq,
          message: {
            role: 'tool',
            content: [{ type: 'text', text }],
            tool_calls: [],
            tool_call_id: r.tool_call_id,
          },
          origin: { kind: 'tool', tool_call_id: r.tool_call_id },
          is_ephemeral: false,
          out_of_context: false,
        };
        if (typeof r.output === 'string') {
          const persistedPath = extractPersistedOutputPath(r.output);
          if (persistedPath !== null) {
            msg.persisted_output_path = persistedPath;
          }
        }
        pushMsg(msg);
        break;
      }

      case 'system_reminder': {
        const text = `<system-reminder>\n${r.content}\n</system-reminder>`;
        pushMsg({
          seq: r.seq,
          message: { role: 'user', content: [{ type: 'text', text }], tool_calls: [] },
          origin: { kind: 'system_reminder', seq: r.seq },
          is_ephemeral: true,
          out_of_context: false,
        });
        break;
      }

      case 'notification': {
        if (!isLlmVisibleNotification(r)) break;
        const text = renderNotificationXml(r.data);
        pushMsg({
          seq: r.seq,
          message: { role: 'user', content: [{ type: 'text', text }], tool_calls: [] },
          origin: {
            kind: 'notification',
            seq: r.seq,
            notification_id: r.data.id,
            severity: r.data.severity,
          },
          is_ephemeral: true,
          out_of_context: false,
        });
        break;
      }

      case 'compaction': {
        // Wholesale replacement. Drops any open step buffer — atoms
        // before compaction are superseded by the summary.
        currentStep = null;
        annotated = [];
        msgTurnIdx.length = 0;
        pushMsg({
          seq: r.seq,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: r.summary }],
            tool_calls: [],
          },
          origin: { kind: 'assistant' },
          is_ephemeral: false,
          out_of_context: false,
        });
        break;
      }

      case 'context_cleared': {
        currentStep = null;
        annotated = [];
        msgTurnIdx.length = 0;
        break;
      }

      case 'context_edit': {
        if (r.operation === 'rewind' && typeof r.to_turn === 'number') {
          const toTurn = r.to_turn;
          if (preserveOutOfContext) {
            for (let i = 0; i < annotated.length; i += 1) {
              const emittedAtTurn = msgTurnIdx[i] ?? 0;
              if (emittedAtTurn > toTurn) {
                // Replace with a marked copy (immutability not required but
                // makes the "after rewind" behaviour obvious to readers).
                const m = annotated[i];
                if (m !== undefined) {
                  annotated[i] = { ...m, out_of_context: true };
                }
              }
            }
          } else {
            // Drop messages emitted in turns past `to_turn`.
            const keep: AnnotatedMessage[] = [];
            const keepTurns: number[] = [];
            for (let i = 0; i < annotated.length; i += 1) {
              const emittedAtTurn = msgTurnIdx[i] ?? 0;
              if (emittedAtTurn <= toTurn) {
                const m = annotated[i];
                if (m !== undefined) {
                  keep.push(m);
                  keepTurns.push(emittedAtTurn);
                }
              }
            }
            annotated = keep;
            msgTurnIdx.length = 0;
            msgTurnIdx.push(...keepTurns);
          }
        }
        break;
      }

      case 'approval_request':
      case 'approval_response':
      case 'metadata':
      case 'ownership_changed':
      case 'session_initialized':
      case 'skill_completed':
      case 'skill_invoked':
      case 'subagent_completed':
      case 'subagent_failed':
      case 'subagent_spawned':
      case 'system_prompt_changed':
      case 'team_mail':
      case 'tool_denied':
      case 'tools_changed':
      case 'turn_end':
        break;

      default:
        break;
    }
  }

  // Flush any trailing open step (session ended mid-step).
  flushStep();

  return annotated;
}

function userContentToText(content: string | readonly UserInputPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'image_url') return `<image url="${p.image_url.url}">`;
      return `<video url="${p.video_url.url}">`;
    })
    .join('');
}

function isLlmVisibleNotification(r: NotificationRecord): boolean {
  const targets = r.data.targets;
  if (!targets.includes('llm')) return false;
  // Optimistic: an absent `delivered_at` means a legacy record from before
  // delivery tracking was added (delivery actually happened); a value of
  // `0` means the LLM sink was intentionally skipped.
  const deliveredAt = r.data.delivered_at;
  if (deliveredAt === undefined) return true;
  return deliveredAt.llm !== 0;
}

/**
 * Build the projected-state summary by walking the wire records locally.
 * Only the config-class state is materialized (model, system prompt,
 * active tools, permission/plan mode, last seq, token totals).
 */
export function buildProjectedStateSummary(
  records: readonly VisWireRecord[],
  sessionInitialized: SessionInitializedRecord | null,
  state?: SessionState | null,
): ProjectedStateSummary {
  const baseline =
    sessionInitialized ??
    ({
      type: 'session_initialized',
      seq: 0,
      time: 0,
      agent_type: 'main',
      session_id: state?.session_id ?? 'unknown',
      system_prompt: '',
      active_tools: [],
      model: state?.model,
      permission_mode: state?.permission_mode,
      plan_mode: state?.plan_mode,
      workspace_dir: state?.workspace_dir,
    } satisfies SessionInitializedRecord);
  const breakdown = sumTokenBreakdown(records);
  const projected = projectStateLocally(records, baseline, state);
  return {
    model: projected.model,
    system_prompt: projected.system_prompt,
    active_tools: projected.active_tools,
    last_seq: projected.last_seq,
    token_count: breakdown.input_tokens + breakdown.output_tokens,
    permission_mode: projected.permission_mode,
    plan_mode: projected.plan_mode,
    ...breakdown,
  };
}

function projectStateLocally(
  records: readonly VisWireRecord[],
  sessionInitialized: SessionInitializedRecord,
  state?: SessionState | null,
): Pick<
  ProjectedStateSummary,
  'model' | 'system_prompt' | 'active_tools' | 'last_seq' | 'permission_mode' | 'plan_mode'
> {
  let systemPrompt: string | null = sessionInitialized.system_prompt;
  let activeTools = [...sessionInitialized.active_tools];
  let model: string | null = state?.model ?? sessionInitialized.model ?? null;
  let permissionMode: string | null = sessionInitialized.permission_mode ?? null;
  let planMode = sessionInitialized.plan_mode ?? false;
  let lastSeq = sessionInitialized.seq;
  for (const record of records) {
    lastSeq = Math.max(lastSeq, record.seq ?? 0);
    if (record.type === 'system_prompt_changed') {
      systemPrompt = record.new_prompt;
    } else if (record.type === 'tools_changed') {
      activeTools = [...record.tools];
    } else if (record.type === 'notification') {
      const payload = record.data.payload;
      if (record.data.type === 'config.update' && isRecord(payload)) {
        model = configModel(payload) ?? model;
      } else if (record.data.type === 'permission.update' && isRecord(payload)) {
        permissionMode = stringValue(payload['mode']) ?? permissionMode;
      }
    }
  }
  return {
    model,
    system_prompt: systemPrompt,
    active_tools: activeTools,
    last_seq: lastSeq,
    permission_mode: state?.permission_mode ?? permissionMode,
    plan_mode: state?.plan_mode ?? planMode,
  };
}

function configModel(payload: Record<string, unknown>): string | null {
  const alias = stringValue(payload['modelAlias']);
  if (alias !== null) return alias;
  const provider = payload['provider'];
  if (isRecord(provider)) return stringValue(provider['model']);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Sum `step_end.usage` across all records. Mirrors the core projector's
 *  tokenCount logic (step-level) so partial/running turns are still counted
 *  — turn_end.usage is the turn total but it arrives only after the turn
 *  closes, so step_end sums stay responsive on live sessions. */
function sumTokenBreakdown(records: readonly VisWireRecord[]): {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const r of records) {
    if (r.type !== 'step_end') continue;
    const usage = (r as { usage?: Record<string, number | undefined> }).usage;
    if (usage === undefined) continue;
    input += usage['input_tokens'] ?? 0;
    output += usage['output_tokens'] ?? 0;
    cacheRead += usage['cache_read_tokens'] ?? 0;
    cacheWrite += usage['cache_write_tokens'] ?? 0;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}
