// Shared presentational helpers for the wire renderer registry and its
// consumers. Extracted into a standalone module so that `renderers.tsx`
// (which holds the per-kind registry) and `WireHeadline.tsx` /
// `WireRowDetail.tsx` (the thin dispatchers) can all import these without
// forming an import cycle:
//
//   parts.tsx  ←  renderers.tsx  ←  WireHeadline.tsx / WireRowDetail.tsx
//
// Every symbol below is defined exactly once, here.

import type { ReactNode } from 'react';

import type { ContentPart, ContextMessage, LoopRecordedEvent, ToolCall } from '../../types';
import { ImagePreview } from '../shared/ImagePreview';
import { JsonViewer } from '../shared/JsonViewer';
import { SizePreview } from '../shared/SizePreview';

export interface HeadlineRender {
  /** Main headline content — rendered in the flex-grow slot of the row */
  main: ReactNode;
  /** Right-side badges / pair refs */
  right?: ReactNode;
}

export function truncate(s: unknown, n: number): string {
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
export function firstText(parts: readonly ContentPart[]): string {
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string') return p.text;
  }
  return '(non-text)';
}

/** One-line description of the embedded LoopRecordedEvent. */
export function loopEventSummary(ev: LoopRecordedEvent): string {
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

// ─── tiny presentational helpers ───

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] text-fg-0 ${className}`}>{children}</span>;
}

export function Dim({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] text-fg-3 ${className}`}>{children}</span>;
}

export function FieldRow({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (wide) {
    return (
      <div className="col-span-2 flex items-baseline gap-3">
        <span className="w-[140px] shrink-0 font-mono text-[11px] text-fg-2 text-right">
          {label}
        </span>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    );
  }
  return (
    <>
      <span className="font-mono text-[11px] text-fg-2 text-right">{label}</span>
      <div className="font-mono text-[12px] text-fg-0 min-w-0 break-words">{children}</div>
    </>
  );
}

export function ContentPartView({ part }: { part: ContentPart }) {
  switch (part.type) {
    case 'text':
      return (
        <div className="border border-border bg-surface-0 p-2">
          <div className="mb-1 text-fg-3">text · {part.text.length}b</div>
          <pre className="whitespace-pre-wrap break-words text-fg-1">{part.text}</pre>
        </div>
      );
    case 'think':
      return (
        <div className="border border-[var(--color-cat-config)]/40 bg-surface-0 p-2">
          <div className="mb-1 text-[var(--color-cat-config)]">think · {part.think.length}b</div>
          <pre className="whitespace-pre-wrap break-words text-fg-1">{part.think}</pre>
        </div>
      );
    case 'image_url':
      return <ImagePreview url={part.imageUrl.url} />;
    case 'audio_url':
      return (
        <div className="border border-border bg-surface-0 p-2">
          <div className="mb-1 text-fg-3">audio_url</div>
          <Mono className="break-all">{part.audioUrl.url}</Mono>
        </div>
      );
    case 'video_url':
      return (
        <div className="border border-border bg-surface-0 p-2">
          <div className="mb-1 text-fg-3">video_url</div>
          <Mono className="break-all">{part.videoUrl.url}</Mono>
        </div>
      );
    default:
      return <JsonViewer value={part} defaultOpenDepth={1} />;
  }
}

function ToolCallView({ call }: { call: ToolCall }) {
  const args = call.arguments ?? '';
  let parsed: unknown = null;
  if (typeof args === 'string' && args.length > 0) {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = null;
    }
  }
  return (
    <div className="border border-[var(--color-cat-tools)]/40 bg-surface-0 p-2">
      <div className="flex items-center justify-between gap-2">
        <Mono className="text-[var(--color-cat-tools)]">{call.name}</Mono>
        <Mono className="text-fg-3 text-[10px]">#{call.id}</Mono>
      </div>
      <div className="mt-1">
        {parsed !== null ? (
          <JsonViewer value={parsed} defaultOpenDepth={1} />
        ) : (
          <pre className="whitespace-pre-wrap break-words text-fg-1">{args}</pre>
        )}
      </div>
    </div>
  );
}

export function MessageDetail({ message }: { message: ContextMessage }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="role">
          <span className="text-[var(--color-cat-ephemeral)]">"{message.role}"</span>
        </FieldRow>
        {message.toolCallId ? (
          <FieldRow label="toolCallId">
            <Mono>{message.toolCallId}</Mono>
          </FieldRow>
        ) : null}
        {message.origin ? (
          <FieldRow label="origin" wide>
            <JsonViewer value={message.origin} defaultOpenDepth={2} />
          </FieldRow>
        ) : null}
        {message.isError === true ? (
          <FieldRow label="isError">
            <span className="text-[var(--color-sev-error)]">true</span>
          </FieldRow>
        ) : null}
        {message.partial === true ? (
          <FieldRow label="partial">
            <span className="text-[var(--color-sev-warning)]">true</span>
          </FieldRow>
        ) : null}
      </div>

      {message.content.length > 0 ? (
        <div>
          <div className="mb-1 text-fg-2">content ({message.content.length} part{message.content.length === 1 ? '' : 's'})</div>
          <div className="space-y-1">
            {message.content.map((part, i) => (
              <ContentPartView key={i} part={part} />
            ))}
          </div>
        </div>
      ) : null}

      {message.toolCalls.length > 0 ? (
        <div>
          <div className="mb-1 text-fg-2">
            toolCalls ({message.toolCalls.length})
          </div>
          <div className="space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallView key={tc.id} call={tc} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LoopEventDetail({ event }: { event: LoopRecordedEvent }) {
  switch (event.type) {
    case 'tool.call': {
      let parsed: unknown = event.args;
      if (typeof event.args === 'string') {
        try {
          parsed = JSON.parse(event.args);
        } catch {
          parsed = event.args;
        }
      }
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
            <FieldRow label="name">
              <Mono className="text-[var(--color-cat-tools)]">{event.name}</Mono>
            </FieldRow>
            <FieldRow label="toolCallId">
              <Mono>{event.toolCallId}</Mono>
            </FieldRow>
            <FieldRow label="step">
              <span className="text-[var(--color-sev-info)]">{event.step}</span>
            </FieldRow>
            <FieldRow label="turnId">
              <Mono>{event.turnId}</Mono>
            </FieldRow>
            {event.description ? (
              <FieldRow label="description" wide>
                <pre className="whitespace-pre-wrap break-words text-fg-1">
                  {event.description}
                </pre>
              </FieldRow>
            ) : null}
          </div>
          <div>
            <div className="mb-1 text-fg-2">args</div>
            <JsonViewer value={parsed} defaultOpenDepth={2} />
          </div>
          {event.display ? (
            <div>
              <div className="mb-1 text-fg-2">display</div>
              <JsonViewer value={event.display} defaultOpenDepth={1} />
            </div>
          ) : null}
        </div>
      );
    }
    case 'tool.result': {
      const isError = event.result.isError === true;
      const output = event.result.output;
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
            <FieldRow label="toolCallId">
              <Mono>{event.toolCallId}</Mono>
            </FieldRow>
            <FieldRow label="parentUuid">
              <Mono>{event.parentUuid}</Mono>
            </FieldRow>
            <FieldRow label="isError">
              <span
                className={
                  isError ? 'text-[var(--color-sev-error)]' : 'text-[var(--color-sev-success)]'
                }
              >
                {String(isError)}
              </span>
            </FieldRow>
            {event.result.message !== undefined ? (
              <FieldRow label="message" wide>
                <pre className="whitespace-pre-wrap break-words text-fg-1">
                  {event.result.message}
                </pre>
              </FieldRow>
            ) : null}
          </div>
          <div>
            <div className="mb-1 text-fg-2">output</div>
            {typeof output === 'string' ? (
              <SizePreview label="output" sizeBytes={output.length} preview={output}>
                <pre className="whitespace-pre-wrap break-words text-fg-1">{output}</pre>
              </SizePreview>
            ) : (
              <div className="space-y-1">
                {output.map((p, i) => (
                  <ContentPartView key={i} part={p} />
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    case 'step.end': {
      const usage = event.usage;
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
            <FieldRow label="step">
              <span className="text-[var(--color-sev-info)]">{event.step}</span>
            </FieldRow>
            <FieldRow label="turnId">
              <Mono>{event.turnId}</Mono>
            </FieldRow>
            {event.finishReason !== undefined ? (
              <FieldRow label="finishReason">
                <Mono>{event.finishReason}</Mono>
              </FieldRow>
            ) : null}
            {event.providerFinishReason !== undefined ? (
              <FieldRow label="providerFinishReason">
                <Mono>{event.providerFinishReason}</Mono>
              </FieldRow>
            ) : null}
            {event.rawFinishReason !== undefined ? (
              <FieldRow label="rawFinishReason">
                <Mono>{event.rawFinishReason}</Mono>
              </FieldRow>
            ) : null}
            {event.llmFirstTokenLatencyMs !== undefined ? (
              <FieldRow label="firstToken">
                <span className="text-fg-1">{event.llmFirstTokenLatencyMs} ms</span>
              </FieldRow>
            ) : null}
            {event.llmStreamDurationMs !== undefined ? (
              <FieldRow label="streamDuration">
                <span className="text-fg-1">{event.llmStreamDurationMs} ms</span>
              </FieldRow>
            ) : null}
          </div>
          {usage !== undefined ? (
            <div>
              <div className="mb-1 text-fg-2">usage</div>
              <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
                <FieldRow label="inputOther">
                  <span className="text-[var(--color-sev-info)]">{usage.inputOther}</span>
                </FieldRow>
                <FieldRow label="output">
                  <span className="text-[var(--color-sev-info)]">{usage.output}</span>
                </FieldRow>
                <FieldRow label="inputCacheRead">
                  <span className="text-[var(--color-sev-info)]">{usage.inputCacheRead}</span>
                </FieldRow>
                <FieldRow label="inputCacheCreation">
                  <span className="text-[var(--color-sev-info)]">{usage.inputCacheCreation}</span>
                </FieldRow>
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    case 'step.begin':
    case 'content.part':
      return <JsonViewer value={event} defaultOpenDepth={2} />;
    default:
      return <JsonViewer value={event} defaultOpenDepth={2} />;
  }
}

/** Fallback detail for any kind without a dedicated renderer: a full
 *  structured JSON dump of the record (type + time + payload). */
export function GenericDetail({ value }: { value: unknown }) {
  return <JsonViewer value={value} defaultOpenDepth={2} />;
}
