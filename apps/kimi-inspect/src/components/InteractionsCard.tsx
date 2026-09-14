/**
 * Pending interactions card (approvals / questions) of one session — fetched
 * on demand over the public REST surface (`/api/v1/sessions/{id}/approvals`
 * and `.../questions`): the engine's interaction kernel is a process-global
 * singleton with no debug channel, and the session `interactions` push
 * stream went away with `/api/v2/ws`, so the card refreshes only when Load
 * is clicked.
 */

import { useState } from 'react';

import { useConnection } from '../connection';
import {
  answerQuestion,
  decideApproval,
  dismissQuestion,
  listPendingApprovals,
  listPendingQuestions,
  type QuestionAnswerWire,
  type QuestionWire,
} from '../interactions/api';
import { ActionButton, Badge, ErrorLine, JsonView } from '../ui';

interface PendingInteraction {
  readonly id: string;
  /** Known kinds: 'approval' | 'question'. */
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

export function InteractionsCard({ sessionId }: { sessionId: string }) {
  const { config, baseUrl } = useConnection();
  const [pending, setPending] = useState<readonly PendingInteraction[]>([]);
  const [error, setError] = useState<unknown>(null);
  const api = { baseUrl, token: config.token, sessionId };

  const reload = async () => {
    try {
      setError(null);
      const [approvals, questions] = await Promise.all([
        listPendingApprovals(api),
        listPendingQuestions(api),
      ]);
      setPending([
        ...approvals.map((p) => ({
          id: p.approval_id,
          kind: 'approval',
          payload: {
            toolName: p.tool_name,
            action: p.action,
            display: p.tool_input_display,
          },
        })),
        ...questions.map((p) => ({
          id: p.question_id,
          kind: 'question',
          payload: p as unknown as Record<string, unknown>,
        })),
      ]);
    } catch (error) {
      setError(error);
    }
  };

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await decideApproval(api, id, decision);
      await reload();
    } catch (error) {
      setError(error);
    }
  };
  const answer = async (id: string, answers: Readonly<Record<string, QuestionAnswerWire>>) => {
    try {
      await answerQuestion(api, id, answers, 'click');
      await reload();
    } catch (error) {
      setError(error);
    }
  };
  const dismiss = async (id: string) => {
    try {
      await dismissQuestion(api, id);
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
                  wire={item.payload as unknown as QuestionWire}
                  onAnswer={(answers) => void answer(item.id, answers)}
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
  wire,
  onAnswer,
  onDismiss,
}: {
  wire: QuestionWire;
  onAnswer: (answers: Readonly<Record<string, QuestionAnswerWire>>) => void;
  onDismiss: () => void;
}) {
  return (
    <>
      {wire.questions.map((q) => (
        <div key={q.id} className="mb-1.5">
          <div className="mb-1 text-[11px] text-neutral-300">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => (
              <ActionButton
                key={opt.id}
                onClick={() => onAnswer({ [q.id]: { kind: 'single', option_id: opt.id } })}
              >
                {opt.label}
              </ActionButton>
            ))}
            {q.allow_other === false ? null : (
              <ActionButton
                onClick={() => {
                  const raw = window.prompt(q.question);
                  if (raw !== null) onAnswer({ [q.id]: { kind: 'other', text: raw } });
                }}
              >
                Other…
              </ActionButton>
            )}
          </div>
        </div>
      ))}
      {wire.questions.length === 0 ? <JsonView data={wire} /> : null}
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
