
export type SessionDisplayStatus =
  | 'awaiting-approval'
  | 'awaiting-question'
  | 'running'
  | 'aborted'
  | 'unread'
  | 'idle';

export interface SessionDisplayStatusInput {
  busy: boolean;
  unread: boolean;
  questionCount: number;
  approvalCount: number;
  pendingInteraction?: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function sessionDisplayStatus(input: SessionDisplayStatusInput): SessionDisplayStatus {
  if (input.approvalCount > 0) return 'awaiting-approval';
  if (input.questionCount > 0) return 'awaiting-question';
  if (input.pendingInteraction === 'approval') return 'awaiting-approval';
  if (input.pendingInteraction === 'question') return 'awaiting-question';
  if (input.busy) return 'running';
  if (input.lastTurnReason === 'failed') return 'aborted';
  if (input.unread) return 'unread';
  return 'idle';
}

export type OpenTabAttention = 'approval' | 'question' | 'aborted' | 'unread' | null;

export function openTabAttention(rows: SessionDisplayStatusInput[]): OpenTabAttention {
  let best: OpenTabAttention = null;
  for (const row of rows) {
    const s = sessionDisplayStatus(row);
    if (s === 'awaiting-approval') return 'approval';
    if (s === 'awaiting-question') {
      best = 'question';
    } else if (s === 'aborted') {
      if (best !== 'question') best = 'aborted';
    } else if (s === 'unread') {
      if (best === null) best = 'unread';
    }
  }
  return best;
}
