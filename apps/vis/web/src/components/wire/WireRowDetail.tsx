import { useState } from 'react';

import type {
  AgentRecord,
  ContentPart,
  ContextMessage,
  LoopRecordedEvent,
  ToolCall,
  WireEntry,
} from '../../types';
import { CopyButton } from '../shared/CopyButton';
import { ImagePreview } from '../shared/ImagePreview';
import { JsonViewer } from '../shared/JsonViewer';
import { SizePreview } from '../shared/SizePreview';

interface WireRowDetailProps {
  entry: WireEntry;
  /** Scroll to + expand a given line. */
  onJumpTo?: (lineNo: number) => void;
}

type JsonView = 'none' | 'raw' | 'projected';

export function WireRowDetail({ entry }: WireRowDetailProps) {
  const [view, setView] = useState<JsonView>('none');
  // Only offer the dual view when migration actually changed something.
  // For records on the current protocol, `raw` and `data` are identical
  // and the toggle would just be visual noise.
  const migrated = !sameJson(entry.raw, entry.data);

  return (
    <div className="pl-[120px] pr-2 py-1 font-mono text-[12px]">
      {renderFriendly(entry.data)}
      <div className="mt-2 flex items-center justify-end gap-3">
        <CopyButton
          value={JSON.stringify(entry.raw, null, 2)}
          label="copy raw"
        />
        {migrated ? (
          <CopyButton
            value={JSON.stringify(entry.data, null, 2)}
            label="copy projected"
          />
        ) : null}
        <button
          onClick={() => {
            setView((v) => (v === 'raw' ? 'none' : 'raw'));
          }}
          className={`font-mono text-[10px] ${
            view === 'raw' ? 'text-fg-0' : 'text-fg-3 hover:text-fg-1'
          }`}
          title="What this line looks like on disk (no vis-side transforms)"
        >
          {view === 'raw' ? '[ hide raw ]' : '[ {…} raw ]'}
        </button>
        {migrated ? (
          <button
            onClick={() => {
              setView((v) => (v === 'projected' ? 'none' : 'projected'));
            }}
            className={`font-mono text-[10px] ${
              view === 'projected' ? 'text-fg-0' : 'text-fg-3 hover:text-fg-1'
            }`}
            title="Same line after vis applied the agent-core migration chain"
          >
            {view === 'projected' ? '[ hide projected ]' : '[ {…} projected ]'}
          </button>
        ) : null}
      </div>
      {view !== 'none' ? (
        <div className="mt-2 border border-border bg-surface-0 p-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
            {view === 'raw' ? 'as written on disk' : 'after vis migration'}
            {migrated && view === 'raw' ? (
              <span className="ml-2 text-[var(--color-sev-warning)]">
                — differs from projected
              </span>
            ) : null}
          </div>
          <JsonViewer
            value={view === 'raw' ? entry.raw : entry.data}
            defaultOpenDepth={2}
          />
        </div>
      ) : null}
    </div>
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function renderFriendly(record: AgentRecord) {
  switch (record.type) {
    case 'context.append_message':
      return <MessageDetail message={record.message} />;
    case 'context.append_loop_event':
      return <LoopEventDetail event={record.event} />;
    case 'turn.prompt':
    case 'turn.steer':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
            <FieldRow label="origin" wide>
              <JsonViewer value={record.origin} defaultOpenDepth={2} />
            </FieldRow>
          </div>
          <div>
            <div className="mb-1 text-fg-2">
              input ({record.input.length} part{record.input.length === 1 ? '' : 's'})
            </div>
            <div className="space-y-1">
              {record.input.map((part, i) => (
                <ContentPartView key={i} part={part} />
              ))}
            </div>
          </div>
        </div>
      );
    case 'context.apply_compaction':
    case 'full_compaction.complete':
      return (
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
          <FieldRow label="summary" wide>
            <SizePreview label="summary" sizeBytes={record.summary.length} preview={record.summary}>
              <pre className="whitespace-pre-wrap break-words text-fg-1">{record.summary}</pre>
            </SizePreview>
          </FieldRow>
          <FieldRow label="compactedCount">
            <span className="text-[var(--color-sev-info)]">{record.compactedCount}</span>
          </FieldRow>
          <FieldRow label="tokensBefore">
            <span className="text-[var(--color-sev-info)]">{record.tokensBefore}</span>
          </FieldRow>
          <FieldRow label="tokensAfter">
            <span className="text-[var(--color-sev-info)]">{record.tokensAfter}</span>
          </FieldRow>
        </div>
      );
    default:
      return <JsonViewer value={record} defaultOpenDepth={2} />;
  }
}
function MessageDetail({ message }: { message: ContextMessage }) {
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

function ContentPartView({ part }: { part: ContentPart }) {
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

function LoopEventDetail({ event }: { event: LoopRecordedEvent }) {
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
    case 'step.begin':
    case 'step.end':
    case 'content.part':
      return <JsonViewer value={event} defaultOpenDepth={2} />;
    default:
      return <JsonViewer value={event} defaultOpenDepth={2} />;
  }
}

function Mono({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] text-fg-0 ${className}`}>{children}</span>;
}

function FieldRow({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
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
