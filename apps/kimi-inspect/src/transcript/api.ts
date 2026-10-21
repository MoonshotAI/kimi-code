import {
  transcriptOpsCatchupResponseSchema,
  transcriptPlanResponseSchema,
  transcriptResponseSchema,
  type AttachmentSource,
  type TranscriptAttachment,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptMeta,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTodo,
} from '@moonshot-ai/transcript';

type StoredAttachmentSource = Extract<AttachmentSource, { kind: 'file' | 'session_media' }>;

export interface FetchTranscriptAttachmentOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly source: StoredAttachmentSource;
  readonly fetchImpl?: typeof fetch;
}

export function transcriptAttachmentUrl(
  baseUrl: string,
  sessionId: string,
  source: AttachmentSource,
): string {
  if (source.kind === 'url') return source.url;
  if (source.kind === 'file') {
    return `${baseUrl}/api/v1/files/${encodeURIComponent(source.fileId)}`;
  }
  return `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(source.fileId)}`;
}

export async function fetchTranscriptAttachment(
  opts: FetchTranscriptAttachmentOptions,
): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    transcriptAttachmentUrl(opts.baseUrl, opts.sessionId, opts.source),
    { headers },
  );
  if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
  return res.blob();
}

export interface TranscriptPage {
  readonly items: readonly TranscriptItem[];
  readonly hasMoreOlder: boolean;
  readonly tasks: readonly TranscriptTask[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly todos: readonly TranscriptTodo[];
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: readonly string[];
  readonly seq?: number | undefined;
}

export const TRANSCRIPT_PAGE_SIZE = 1;

export interface FetchTranscriptPageOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly beforeTurn?: string | undefined;
  readonly pageSize?: number | undefined;
  readonly fetchImpl?: typeof fetch;
}

export async function fetchTranscriptPage(
  opts: FetchTranscriptPageOptions,
): Promise<TranscriptPage> {
  const params = new URLSearchParams({
    agent_id: opts.agentId,
    page_size: String(opts.pageSize ?? TRANSCRIPT_PAGE_SIZE),
  });
  if (opts.beforeTurn !== undefined) params.set('before_turn', opts.beforeTurn);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl}/api/v1/sessions/${encodeURIComponent(opts.sessionId)}/transcript?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`transcript page failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = transcriptResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('transcript page: unexpected response shape');
  }
  const items: readonly TranscriptItem[] = parsed.data.items;
  const tasks: readonly TranscriptTask[] = parsed.data.tasks;
  const interactions: readonly TranscriptInteraction[] = parsed.data.interactions;
  const attachments: readonly TranscriptAttachment[] = parsed.data.attachments;
  const todos: readonly TranscriptTodo[] = parsed.data.todos;
  return {
    items,
    hasMoreOlder: parsed.data.has_more,
    tasks,
    interactions,
    attachments,
    todos,
    meta: parsed.data.meta,
    pendingInteractions: parsed.data.pending_interactions,
    seq: parsed.data.seq,
  };
}

export interface TranscriptOpBatch {
  readonly seq: number;
  readonly ops: readonly TranscriptOperation[];
}

export interface TranscriptOpsCatchup {
  readonly batches: readonly TranscriptOpBatch[];
  readonly latestSeq: number;
  readonly complete: boolean;
}

export interface FetchTranscriptOpsOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly sinceSeq: number;
  readonly fetchImpl?: typeof fetch;
}

export async function fetchTranscriptOps(
  opts: FetchTranscriptOpsOptions,
): Promise<TranscriptOpsCatchup> {
  const params = new URLSearchParams({
    agent_id: opts.agentId,
    since_seq: String(opts.sinceSeq),
  });
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl}/api/v1/sessions/${encodeURIComponent(opts.sessionId)}/transcript/ops?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`transcript ops failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = transcriptOpsCatchupResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('transcript ops: unexpected response shape');
  }
  return {
    batches: parsed.data.batches,
    latestSeq: parsed.data.latest_seq,
    complete: parsed.data.complete,
  };
}

export interface TranscriptPlanReview {
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly selectedOption?: string | undefined;
  readonly feedback?: string | undefined;
}

export interface TranscriptPlanInfo {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly source: 'interaction' | 'display' | 'output';
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly { label: string; description?: string | undefined }[] | undefined;
  readonly review?: TranscriptPlanReview | undefined;
}

export interface FetchTranscriptPlanOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolCallId?: string | undefined;
  readonly fetchImpl?: typeof fetch;
}

export async function fetchTranscriptPlan(
  opts: FetchTranscriptPlanOptions,
): Promise<TranscriptPlanInfo[]> {
  const params = new URLSearchParams({ agent_id: opts.agentId });
  if (opts.toolCallId !== undefined && opts.toolCallId !== '') {
    params.set('tool_call_id', opts.toolCallId);
  }
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl}/api/v1/sessions/${encodeURIComponent(opts.sessionId)}/transcript/plan?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`transcript plan failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = transcriptPlanResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('transcript plan: unexpected response shape');
  }
  return parsed.data.plans.map((entry) => ({
    toolCallId: entry.tool_call_id,
    turnId: entry.turn_id,
    source: entry.source,
    plan: entry.plan,
    path: entry.path,
    options: entry.options,
    review:
      entry.review === undefined
        ? undefined
        : {
            state: entry.review.state,
            selectedOption: entry.review.selected_option,
            feedback: entry.review.feedback,
          },
  }));
}
