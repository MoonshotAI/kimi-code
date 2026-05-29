import type { ReactNode } from 'react';

import type { AgentRecord, ContentPart, LoopRecordedEvent } from '../../types';
import { Pill } from '../shared/Pill';
import { formatBytes } from '../shared/SizePreview';

export interface HeadlineRender {
  /** Main headline content — rendered in the flex-grow slot of the row */
  main: ReactNode;
  /** Right-side badges / pair refs */
  right?: ReactNode;
}

function truncate(s: unknown, n: number): string {
  let str: string;
  if (s === null || s === undefined) str = '';
  else if (typeof s === 'string') str = s;
  else if (typeof s === 'number' || typeof s === 'boolean' || typeof s === 'bigint')
    str = String(s);
  else {
    try {
      str = JSON.stringify(s);
    } catch {
      return '[unserializable]';
    }
  }
  if (str.length <= n) return str;
  return str.slice(0, n) + '…';
}

/** Pull the first text segment from a ContentPart[] for one-line preview. */
function firstText(parts: readonly ContentPart[]): string {
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string') return p.text;
  }
  return '(non-text)';
}

/** One-line description of the embedded LoopRecordedEvent. */
function loopEventSummary(ev: LoopRecordedEvent): string {
  switch (ev.type) {
    case 'step.begin':
      return `step ${ev.step} (turn ${ev.turnId})`;
    case 'step.end':
      return `step ${ev.step} → ${ev.finishReason ?? '?'}`;
    case 'content.part': {
      const len =
        ev.part.type === 'text'
          ? ev.part.text.length
          : ev.part.type === 'think'
            ? ev.part.think.length
            : 0;
      return `${ev.part.type}${len ? ` (${len}b)` : ''}`;
    }
    case 'tool.call':
      return `${ev.name}#${ev.toolCallId.slice(-8)}`;
    case 'tool.result':
      return `result#${ev.toolCallId.slice(-8)}${ev.result.isError === true ? ' (error)' : ''}`;
    default: {
      const exhaustive: never = ev;
      return String((exhaustive as { type?: string }).type ?? 'unknown');
    }
  }
}

/** Render the collapsed-headline for a wire record. */
export function renderHeadline(r: AgentRecord): HeadlineRender {
  switch (r.type) {
    case 'metadata':
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>protocol v{r.protocol_version}</Mono>
            <Dim>·</Dim>
            <Mono>created {new Date(r.created_at).toLocaleString()}</Mono>
          </span>
        ),
      };

    case 'config.update': {
      const parts: string[] = [];
      if (r.profileName !== undefined) parts.push(`profile=${r.profileName}`);
      if (r.modelAlias !== undefined) parts.push(`model=${r.modelAlias}`);
      if (r.cwd !== undefined) parts.push(`cwd=${r.cwd}`);
      if (r.thinkingLevel !== undefined) parts.push(`thinking=${r.thinkingLevel}`);
      if (r.systemPrompt !== undefined) parts.push(`system(${r.systemPrompt.length}b)`);
      return {
        main: (
          <span className="truncate text-fg-0">
            {parts.length === 0 ? <Dim>(no fields)</Dim> : parts.join(' · ')}
          </span>
        ),
      };
    }

    case 'turn.prompt':
    case 'turn.steer': {
      const text = firstText(r.input);
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="turn" variant="soft">
              {r.origin.kind}
            </Pill>
            <span className="truncate text-fg-1">→ {truncate(text, 80)}</span>
          </span>
        ),
      };
    }

    case 'turn.cancel':
      return {
        main: <Mono>{r.turnId !== undefined ? `turn ${r.turnId}` : '(latest)'}</Mono>,
      };

    case 'context.append_message': {
      const m = r.message;
      const tc = m.toolCalls.length > 0 ? `${m.toolCalls.length} tool_call(s)` : '';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill
              tone={
                m.role === 'user'
                  ? 'user'
                  : m.role === 'assistant'
                    ? 'assistant'
                    : m.role === 'tool'
                      ? 'tool'
                      : 'meta'
              }
              variant="soft"
            >
              {m.role}
            </Pill>
            <Dim>({m.content.length} part{m.content.length === 1 ? '' : 's'})</Dim>
            {tc ? <Dim>· {tc}</Dim> : null}
            {m.origin?.kind ? <Dim>· origin={m.origin.kind}</Dim> : null}
          </span>
        ),
        right: m.isError === true ? (
          <Pill tone="error" variant="solid">
            error
          </Pill>
        ) : undefined,
      };
    }

    case 'context.append_loop_event':
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>{r.event.type}</Mono>
            <Dim className="truncate">{loopEventSummary(r.event)}</Dim>
          </span>
        ),
      };

    case 'context.clear':
      return { main: <Dim>context cleared</Dim> };

    case 'context.apply_compaction':
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="compaction" variant="soft">
              compacted
            </Pill>
            <Dim>
              summary {r.summary.length}b · {r.tokensBefore}→{r.tokensAfter} tok · {r.compactedCount} msgs
            </Dim>
          </span>
        ),
      };

    case 'tools.set_active_tools': {
      const head = r.names.slice(0, 3).join(', ');
      const rest = r.names.length > 3 ? ` +${r.names.length - 3} more` : '';
      return {
        main: (
          <Mono className="truncate">
            {head}
            {rest}
          </Mono>
        ),
        right: <Dim>{r.names.length} tools</Dim>,
      };
    }

    case 'tools.register_user_tool':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono className="text-[var(--color-cat-tools)]">+ {r.name}</Mono>
          </span>
        ),
      };

    case 'tools.unregister_user_tool':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono className="text-[var(--color-sev-warning)]">- {r.name}</Mono>
          </span>
        ),
      };

    case 'tools.update_store': {
      const valuePreview =
        typeof r.value === 'object' && r.value !== null
          ? '(object)'
          : truncate(String(r.value), 60);
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>{r.key}</Mono>
            <Dim>= {valuePreview}</Dim>
          </span>
        ),
      };
    }

    case 'permission.set_mode':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Dim>mode →</Dim>
            <Pill tone="approval" variant="soft">
              {r.mode}
            </Pill>
          </span>
        ),
      };

    case 'permission.record_approval_result': {
      const tone =
        r.result.decision === 'approved'
          ? 'success'
          : r.result.decision === 'rejected'
            ? 'error'
            : 'neutral';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>
              {r.toolName}#{r.toolCallId.slice(-8)}
            </Mono>
            <Pill tone={tone} variant="soft">
              {r.result.decision}
            </Pill>
            {r.result.scope ? <Dim>({r.result.scope})</Dim> : null}
          </span>
        ),
      };
    }

    case 'usage.record':
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>{r.model}</Mono>
            <Dim>
              in {r.usage.inputOther} / out {r.usage.output} / cache r{r.usage.inputCacheRead} w
              {r.usage.inputCacheCreation}
            </Dim>
          </span>
        ),
        right: r.usageScope ? (
          <Pill tone="meta" variant="outline">
            {r.usageScope}
          </Pill>
        ) : undefined,
      };

    case 'full_compaction.begin':
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="compaction" variant="soft">
              {r.source}
            </Pill>
            {r.instruction ? (
              <Dim className="truncate">"{truncate(r.instruction, 40)}"</Dim>
            ) : null}
          </span>
        ),
      };

    case 'full_compaction.cancel':
      return { main: <Dim>cancelled</Dim> };

    case 'full_compaction.complete':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Dim>
              {r.compactedCount} msgs · {r.tokensBefore}→{r.tokensAfter} tok
            </Dim>
            <Dim>· summary {formatBytes(r.summary.length)}</Dim>
          </span>
        ),
      };

    case 'plan_mode.enter':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Pill tone="lifecycle" variant="soft">
              enter
            </Pill>
            <Mono>{r.id}</Mono>
          </span>
        ),
      };

    case 'plan_mode.cancel':
    case 'plan_mode.exit':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Pill
              tone={r.type === 'plan_mode.exit' ? 'success' : 'warning'}
              variant="soft"
            >
              {r.type === 'plan_mode.exit' ? 'exit' : 'cancel'}
            </Pill>
            <Mono>{r.id ?? '(latest)'}</Mono>
          </span>
        ),
      };

    case 'background.stop':
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono>task</Mono>
            <Mono>{r.taskId}</Mono>
          </span>
        ),
      };
  }
  // `r` is `never` here under TypeScript exhaustiveness, but at runtime
  // best-effort parsing of unknown/future protocols can deliver records
  // whose `type` is outside the AgentRecord union. Without this fallback
  // WireRow would dereference `undefined` and crash the whole tab.
  return {
    main: (
      <Dim>(unknown record type: {(r as { type: string }).type})</Dim>
    ),
  };
}

// ─── tiny presentational helpers ───
function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] text-fg-0 ${className}`}>{children}</span>;
}

function Dim({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] text-fg-3 ${className}`}>{children}</span>;
}
