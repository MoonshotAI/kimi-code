/**
 * Pending interactions card (approvals / questions) of one session — fetched
 * on demand: the session `interactions` push stream went away with
 * `/api/v2/ws`, so the card refreshes only when Load is clicked.
 */

import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { useState } from 'react';

import { useConnection } from '../connection';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';

interface PendingInteraction {
  readonly id: string;
  /** Known kinds: 'approval' | 'question' | 'user_tool'; other kinds may appear. */
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

export function InteractionsCard({ sessionId }: { sessionId: string }) {
  const { klient } = useConnection();
  const [pending, setPending] = useState<readonly PendingInteraction[]>([]);
  const [error, setError] = useState<unknown>(null);
  const interaction = klient.session(sessionId).service(ISessionInteractionService);
  const approval = klient.session(sessionId).service(ISessionApprovalService);
  const question = klient.session(sessionId).service(ISessionQuestionService);

  const reload = async () => {
    try {
      setError(null);
      setPending((await interaction.listPending()) as readonly PendingInteraction[]);
    } catch (error) {
      setError(error);
    }
  };

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await approval.decide(id, { decision });
      await reload();
    } catch (error) {
      setError(error);
    }
  };
  const answer = async (id: string, q: string, value: string) => {
    try {
      await question.answer(id, { answers: { [q]: value } });
      await reload();
    } catch (error) {
      setError(error);
    }
  };
  const dismiss = async (id: string) => {
    try {
      await question.dismiss(id);
      await reload();
    } catch (error) {
      setError(error);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-900/50 bg-amber-950/20">
      <div className="flex items-center justify-between border-b border-amber-900/40 px-3 py-2">
        <span className="text-[12px] font-medium text-amber-200">
          Pending interactions {pending.length > 0 ? `(${pending.length})` : ''}
        </span>
        <ActionButton onClick={() => void reload()}>Load</ActionButton>
      </div>
      <div className="px-3 py-2">
        {error !== null ? (
          <div className="mb-2">
            <ErrorLine error={error} />
          </div>
        ) : null}
        {pending.length === 0 ? (
          <div className="text-[11px] text-neutral-600 italic">
            nothing pending (click Load to check)
          </div>
        ) : (
          pending.map((item) => (
            <div
              key={item.id}
              className="mb-2 rounded border border-neutral-800 bg-neutral-950/60 p-2"
            >
              <div className="mb-1 flex items-center gap-2">
                <Badge tone="amber">{item.kind}</Badge>
                <span className="font-mono text-[10px] text-neutral-500">{item.id}</span>
                <span className="text-[10px] text-neutral-600">{relTime(item.createdAt)}</span>
              </div>
              {item.kind === 'approval' ? (
                <>
                  <div className="mb-1.5 text-[11px] text-neutral-300">
                    <span className="text-neutral-500">tool </span>
                    {payloadField(item.payload, 'toolName', '?')}
                    <span className="text-neutral-500"> · </span>
                    {payloadField(item.payload, 'action', '')}
                  </div>
                  <JsonView data={item.payload['display'] ?? item.payload} />
                  <div className="mt-2 flex gap-1.5">
                    <ActionButton onClick={() => void decide(item.id, 'approved')}>
                      Approve
                    </ActionButton>
                    <ActionButton danger onClick={() => void decide(item.id, 'rejected')}>
                      Reject
                    </ActionButton>
                  </div>
                </>
              ) : item.kind === 'question' ? (
                <QuestionView
                  payload={item.payload}
                  onAnswer={(q, v) => void answer(item.id, q, v)}
                  onDismiss={() => void dismiss(item.id)}
                />
              ) : (
                <JsonView data={item.payload} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function QuestionView({
  payload,
  onAnswer,
  onDismiss,
}: {
  payload: Record<string, unknown>;
  onAnswer: (question: string, value: string) => void;
  onDismiss: () => void;
}) {
  const questions = (payload['questions'] ?? []) as readonly {
    question: string;
    options?: readonly { label: string }[];
  }[];
  return (
    <>
      {questions.map((q) => (
        <div key={q.question} className="mb-1.5">
          <div className="mb-1 text-[11px] text-neutral-300">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {(q.options ?? []).map((opt) => (
              <ActionButton key={opt.label} onClick={() => onAnswer(q.question, opt.label)}>
                {opt.label}
              </ActionButton>
            ))}
            <ActionButton
              onClick={() => {
                const raw = window.prompt(q.question);
                if (raw !== null) onAnswer(q.question, raw);
              }}
            >
              Other…
            </ActionButton>
          </div>
        </div>
      ))}
      {questions.length === 0 ? <JsonView data={payload} /> : null}
      <div className="mt-1.5">
        <ActionButton danger onClick={onDismiss}>
          Dismiss
        </ActionButton>
      </div>
    </>
  );
}

/**
 * Render a wire payload field as display text: strings pass through,
 * numbers/booleans are stringified, anything else (or missing) falls back —
 * never "[object Object]".
 */
function payloadField(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
