import { useState, type ReactNode } from 'react';
import type { AnnotatedMessage, ContentPart, ToolCallEntry } from '../../types';
import { Pill } from '../shared/Pill';
import { PersistedOutputLink } from './PersistedOutputLink';

interface MessageBubbleProps {
  message: AnnotatedMessage;
  sessionId: string;
}

export function MessageBubble({ message, sessionId }: MessageBubbleProps) {
  const { role } = message.message;
  if (role === 'user') return <UserBubble m={message} />;
  if (role === 'assistant') return <AssistantBubble m={message} />;
  return <ToolBubble m={message} sessionId={sessionId} />;
}

function baseClass(out: boolean): string {
  return [
    'relative flex max-w-full min-w-0 flex-col border-l-[3px] bg-surface-1 px-3 py-2',
    out ? 'opacity-50 line-through decoration-[var(--color-sev-error)] decoration-dashed' : '',
  ].join(' ');
}

function UserBubble({ m }: { m: AnnotatedMessage }) {
  return (
    <article
      className={baseClass(m.out_of_context)}
      style={{ borderLeftColor: 'var(--color-user)' }}
    >
      <header className="mb-1 flex items-center gap-2">
        <Pill tone="user" variant="solid">user</Pill>
        <span className="font-mono text-[10px] text-fg-3 tabular">seq {m.seq}</span>
        {m.out_of_context ? <Pill tone="error" variant="outline">out-of-context</Pill> : null}
      </header>
      <MessageContent parts={m.message.content} />
    </article>
  );
}

function AssistantBubble({ m }: { m: AnnotatedMessage }) {
  const thinkPart = m.message.content.find((p) => p.type === 'think');
  const think = thinkPart ? (thinkPart['think'] as string | undefined) : undefined;
  const textParts = m.message.content.filter((p) => p.type !== 'think');
  return (
    <article
      className={baseClass(m.out_of_context)}
      style={{ borderLeftColor: 'var(--color-assistant)' }}
    >
      <header className="mb-1 flex items-center gap-2">
        <Pill tone="assistant" variant="solid">assistant</Pill>
        <span className="font-mono text-[10px] text-fg-3 tabular">seq {m.seq}</span>
        {think ? <Pill tone="config" variant="outline">think</Pill> : null}
        {m.message.tool_calls.length > 0 ? (
          <Pill tone="tools" variant="outline">
            {m.message.tool_calls.length} tool call{m.message.tool_calls.length > 1 ? 's' : ''}
          </Pill>
        ) : null}
        {m.out_of_context ? <Pill tone="error" variant="outline">out-of-context</Pill> : null}
      </header>
      {think ? <ThinkBlock text={think} /> : null}
      <MessageContent parts={textParts} />
      {m.message.tool_calls.length > 0 ? (
        <div className="mt-2 space-y-1">
          {m.message.tool_calls.map((tc) => <ToolCallCard key={tc.id} call={tc} />)}
        </div>
      ) : null}
    </article>
  );
}

function ToolBubble({ m, sessionId }: { m: AnnotatedMessage; sessionId: string }) {
  const firstTextPart = m.message.content.find((p) => p.type === 'text');
  const text = firstTextPart ? ((firstTextPart['text'] as string | undefined) ?? '') : '';
  const hasPersisted = !!m.persisted_output_path && m.message.tool_call_id;
  return (
    <article
      className={baseClass(m.out_of_context)}
      style={{ borderLeftColor: 'var(--color-tool)' }}
    >
      <header className="mb-1 flex items-center gap-2">
        <Pill tone="tool" variant="solid">tool</Pill>
        {m.message.tool_call_id ? (
          <span className="font-mono text-[11px] text-fg-1">
            call {m.message.tool_call_id.slice(0, 12)}
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-fg-3 tabular">seq {m.seq}</span>
        {m.out_of_context ? <Pill tone="error" variant="outline">out-of-context</Pill> : null}
      </header>
      {hasPersisted ? (
        <PersistedOutputLink
          sessionId={sessionId}
          toolCallId={m.message.tool_call_id!}
          path={m.persisted_output_path!}
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-fg-1">
          {text}
        </pre>
      )}
    </article>
  );
}

function ThinkBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 border border-border bg-surface-0">
      <button
        onClick={() =>{  setOpen((v) => !v); }}
        className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[11px] text-fg-2 hover:text-fg-1"
      >
        <span className="text-fg-3">{open ? '▾' : '▸'}</span>
        <span className="uppercase tracking-[0.08em]">thinking</span>
        <span className="text-fg-3 tabular">{text.length}ch</span>
      </button>
      {open ? (
        <pre className="border-t border-border px-2 py-1 whitespace-pre-wrap break-words font-mono text-[12px] text-fg-1">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function ToolCallCard({ call }: { call: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  const argsStr = call.arguments ?? '';
  return (
    <div className="border border-border bg-surface-0">
      <button
        onClick={() =>{  setOpen((v) => !v); }}
        className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[11px] hover:bg-surface-2"
      >
        <span className="text-fg-3">{open ? '▾' : '▸'}</span>
        <Pill tone="tools" variant="soft">call</Pill>
        <span className="text-fg-0">{call.name}</span>
        <span className="truncate text-fg-3">{truncate(argsStr, 80)}</span>
        <span className="ml-auto text-fg-3 tabular text-[10px]">{call.id.slice(0, 10)}</span>
      </button>
      {open ? (
        <pre className="border-t border-border px-2 py-1 whitespace-pre-wrap break-words font-mono text-[12px] text-fg-1">
          {prettyJson(argsStr)}
        </pre>
      ) : null}
    </div>
  );
}

function MessageContent({ parts }: { parts: readonly ContentPart[] }): ReactNode {
  return (
    <div className="space-y-2">
      {parts.map((p, i) => {
        if (p.type === 'text') {
          return (
            <pre
              key={i}
              className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.55] text-fg-0"
            >
              {(p['text'] as string) ?? ''}
            </pre>
          );
        }
        if (p.type === 'image_url') {
          const url = (p['image_url'] as { url?: string } | undefined)?.url;
          return <div key={i} className="text-fg-2 font-mono text-[11px]">[image: {url ?? '—'}]</div>;
        }
        if (p.type === 'video_url') {
          const url = (p['video_url'] as { url?: string } | undefined)?.url;
          return <div key={i} className="text-fg-2 font-mono text-[11px]">[video: {url ?? '—'}]</div>;
        }
        return (
          <div key={i} className="text-fg-3 font-mono text-[11px]">
            [{p.type}]
          </div>
        );
      })}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
