import { useEffect, useState } from 'react';

import { useContext } from '../../hooks/useContext';
import { useSession } from '../../hooks/useSession';
import type { TokenUsage } from '../../types';
import { Pill } from '../shared/Pill';
import { ClearRibbon } from './ClearRibbon';
import { CompactionRibbon } from './CompactionRibbon';
import { MessageBubble } from './MessageBubble';
import { UndoRibbon } from './UndoRibbon';

interface ContextTabProps {
  sessionId: string;
  /** Override starting agentId; defaults to 'main'. */
  initialAgentId?: string;
}

export function ContextTab({ sessionId, initialAgentId = 'main' }: ContextTabProps) {
  const [agentId, setAgentId] = useState<string>(initialAgentId);
  const [history, setHistory] = useState<'model' | 'full'>('model');
  // Re-sync on session OR agent id change — see WireTab for the same
  // rationale (session navigation must reset a stale subagent pick).
  useEffect(() => {
    setAgentId(initialAgentId);
  }, [sessionId, initialAgentId]);
  const { data: detail } = useSession(sessionId);
  const { data: ctx, isLoading, error } = useContext(sessionId, agentId, history);

  const agents = detail?.agents ?? [];
  const messages = ctx?.messages ?? [];
  const session = ctx?.usage.byScope.session ?? EMPTY_USAGE;
  // Live context-window fill (latest step.end usage), distinct from the
  // cumulative `session` spend the 4-segment bar breaks down.
  const contextTokens = ctx?.contextTokens ?? 0;
  const config = ctx?.config ?? {};
  const permissionMode = ctx?.permission.mode ?? null;
  const planActive = ctx?.planMode.active ?? false;
  const goal = ctx?.goal ?? null;
  const swarmActive = ctx?.swarm.active ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar — agent selector + status pills */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <label className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
          <span className="text-fg-3">agent</span>
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
            }}
            className="border border-border bg-surface-0 px-2 py-1 font-mono text-[12px] text-fg-0 focus:border-border-strong focus:outline-none"
          >
            {agents.length === 0 ? <option value={agentId}>{agentId}</option> : null}
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentId} ({a.type}
                {a.parentAgentId ? ` ← ${a.parentAgentId}` : ''})
              </option>
            ))}
          </select>
        </label>
        <span className="font-mono text-[11px] text-fg-2">
          <span className="tabular text-fg-0">{messages.length}</span>
          <span className="ml-1 text-fg-3">messages</span>
        </span>
        {config.modelAlias ? (
          <span className="font-mono text-[11px] text-fg-2">
            <span className="text-fg-3">model</span>{' '}
            <span className="text-fg-0">{config.modelAlias}</span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {/* History view toggle — 'model' (post-compaction, what the model
              sees) vs 'full' (full reconstructed history for debugging). */}
          <div
            role="group"
            aria-label="history view"
            className="flex items-center overflow-hidden border border-border"
          >
            <button
              type="button"
              aria-pressed={history === 'model'}
              onClick={() => {
                setHistory('model');
              }}
              className={[
                'px-2 py-1 font-mono text-[11px] transition-colors',
                history === 'model'
                  ? 'bg-surface-2 text-fg-0'
                  : 'bg-surface-0 text-fg-3 hover:text-fg-1',
              ].join(' ')}
            >
              model
            </button>
            <button
              type="button"
              aria-pressed={history === 'full'}
              onClick={() => {
                setHistory('full');
              }}
              className={[
                'border-l border-border px-2 py-1 font-mono text-[11px] transition-colors',
                history === 'full'
                  ? 'bg-surface-2 text-fg-0'
                  : 'bg-surface-0 text-fg-3 hover:text-fg-1',
              ].join(' ')}
            >
              full history
            </button>
          </div>
          {permissionMode ? (
            <Pill tone="approval" variant="outline">permission: {permissionMode}</Pill>
          ) : null}
          {planActive ? (
            <Pill tone="info" variant="solid">plan mode</Pill>
          ) : null}
          {swarmActive ? (
            <Pill tone="subagent" variant="solid">swarm mode</Pill>
          ) : null}
        </div>
      </div>

      {/* Full-history hint — clarifies that this is the reconstructed history
          and the model itself only sees the compacted view. */}
      {history === 'full' ? (
        <div className="shrink-0 border-b border-border bg-surface-1 px-3 py-1 font-mono text-[10.5px] text-fg-3">
          full reconstructed history — the model actually sees the compacted view
        </div>
      ) : null}

      {/* Live context-window fill (contextTokens) + the 4-segment cumulative
          session-usage breakdown. */}
      <TokenBar usage={session} contextTokens={contextTokens} />

      {/* Message stream */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 px-3 py-4">
          {goal ? (
            <div className="rounded border border-[var(--color-cat-lifecycle)]/40 bg-surface-0 p-2">
              <div className="mb-1 flex items-center gap-2">
                <Pill tone="lifecycle" variant="soft">goal</Pill>
                {goal.status ? <Pill tone="info" variant="outline">{goal.status}</Pill> : null}
              </div>
              <div className="font-mono text-[12px] text-fg-1">{goal.objective}</div>
              {goal.completionCriterion ? (
                <div className="mt-1 font-mono text-[11px] text-fg-3">
                  done when: {goal.completionCriterion}
                </div>
              ) : null}
            </div>
          ) : null}
          {config.systemPrompt ? <SystemPromptBubble text={config.systemPrompt} /> : null}
          {isLoading ? (
            <div className="px-3 py-2 font-mono text-[12px] text-fg-3">loading context…</div>
          ) : error ? (
            <div className="px-3 py-2 font-mono text-[12px] text-[var(--color-sev-error)]">
              {(error as Error).message}
            </div>
          ) : messages.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[12px] text-fg-3">
              no messages — session has only lifecycle/config records so far.
            </div>
          ) : (
            messages.map((m) => {
              if (m.source === 'compaction_summary') {
                return <CompactionRibbon key={m.lineNo} message={m} />;
              }
              if (m.source === 'undo') {
                return <UndoRibbon key={m.lineNo} message={m} />;
              }
              if (m.source === 'clear') {
                return <ClearRibbon key={m.lineNo} message={m} />;
              }
              return <MessageBubble key={m.lineNo} message={m} />;
            })
          )}
        </div>
      </div>
    </div>
  );
}

const EMPTY_USAGE: TokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

// Colors are chosen from the existing semantic palette so the bar reads
// coherently with the rest of the app:
//   inputCacheRead     = success   (cache hit — the "good" share)
//   inputOther         = info      (billed input)
//   output             = assistant (what the model produced)
//   inputCacheCreation = warning   (billed once, amortised next call)
const SEG_COLORS = {
  inputCacheRead: 'var(--color-sev-success)',
  inputOther: 'var(--color-sev-info)',
  output: 'var(--color-assistant)',
  inputCacheCreation: 'var(--color-sev-warning)',
} as const;

function TokenBar({ usage, contextTokens }: { usage: TokenUsage; contextTokens: number }) {
  const total =
    usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
  return (
    <div className="shrink-0">
      {contextTokens > 0 ? (
        <div className="flex items-center justify-end gap-1 border-b border-border bg-surface-1 px-3 py-1 font-mono text-[10px] text-fg-2">
          <span className="text-fg-3">context</span>
          <span className="tabular text-fg-0">{contextTokens.toLocaleString()}</span>
          <span className="text-fg-3">tok</span>
        </div>
      ) : null}
      {total === 0 ? (
        <div className="h-[2px] bg-border" />
      ) : (
        <div
          className="flex h-[3px] w-full"
          title={
            `cache_read ${usage.inputCacheRead.toLocaleString()} · ` +
            `input ${usage.inputOther.toLocaleString()} · ` +
            `output ${usage.output.toLocaleString()} · ` +
            `cache_create ${usage.inputCacheCreation.toLocaleString()}`
          }
        >
          {usage.inputCacheRead > 0 ? (
            <div
              style={{
                width: `${seg(usage.inputCacheRead, total)}%`,
                backgroundColor: SEG_COLORS.inputCacheRead,
              }}
            />
          ) : null}
          {usage.inputOther > 0 ? (
            <div
              style={{
                width: `${seg(usage.inputOther, total)}%`,
                backgroundColor: SEG_COLORS.inputOther,
              }}
            />
          ) : null}
          {usage.output > 0 ? (
            <div
              style={{ width: `${seg(usage.output, total)}%`, backgroundColor: SEG_COLORS.output }}
            />
          ) : null}
          {usage.inputCacheCreation > 0 ? (
            <div
              style={{
                width: `${seg(usage.inputCacheCreation, total)}%`,
                backgroundColor: SEG_COLORS.inputCacheCreation,
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function seg(n: number, total: number): number {
  return (n / total) * 100;
}

function SystemPromptBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article
      className="relative flex max-w-full min-w-0 flex-col border-l-[3px] bg-surface-1"
      style={{ borderLeftColor: 'var(--color-cat-config)' }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2"
      >
        <span className="flex items-center gap-2">
          <Pill tone="config" variant="solid">system</Pill>
          <span className="font-mono text-[10px] text-fg-3 tabular">
            {text.length.toLocaleString()} chars
          </span>
        </span>
        <span className="font-mono text-[11px] text-fg-1">
          {open ? '▾ collapse' : '▸ show full'}
        </span>
      </button>
      <div className="relative min-w-0 px-3 pb-2">
        <pre
          className={[
            'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12.5px] text-fg-0',
            open ? '' : 'max-h-[9em] overflow-hidden',
          ].join(' ')}
        >
          {text}
        </pre>
        {!open ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14"
            style={{
              background: 'linear-gradient(to bottom, transparent 0%, var(--color-surface-1) 85%)',
            }}
          />
        ) : null}
      </div>
    </article>
  );
}
