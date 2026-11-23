import type { KapTurn } from '#/kap/frames';

export interface KapSession {
  readonly id: string;
  readonly workspace_id: string;
  readonly cwd: string;
  readonly title: string;
  readonly activity: 'idle' | 'turn' | 'background';
  readonly pending_interaction: 'none' | 'approval' | 'question';
  readonly last_turn_outcome?: 'completed' | 'interrupted' | 'failed';
  readonly archived: boolean;
  readonly [key: string]: unknown;
}

export interface KapPromptItem {
  readonly prompt_id: string;
  readonly user_message_id: string;
  readonly status: 'running' | 'blocked' | 'failed' | 'queued';
  readonly accepted_as?: 'turn' | 'steer' | 'queue';
  readonly turn_id?: string;
  readonly [key: string]: unknown;
}

export interface KapPromptQueue {
  readonly active: KapPromptItem | null;
  readonly queued: readonly KapPromptItem[];
}

export interface KapPendingInteraction {
  readonly interaction_id: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly kind: 'approval' | 'question';
  readonly tool_call_id?: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface KapWaitResult {
  readonly session: KapSession;
  readonly pending_interactions: readonly KapPendingInteraction[];
  readonly timed_out: boolean;
}

export interface KapTurnsPage {
  readonly turns: readonly KapTurn[];
  readonly has_more: boolean;
}

export type KapInteractionResponse =
  | {
      readonly kind: 'approval';
      readonly decision: 'approved' | 'rejected' | 'cancelled';
      readonly scope?: 'session';
      readonly feedback?: string;
    }
  | { readonly kind: 'question'; readonly answers: Readonly<Record<string, unknown>> }
  | { readonly kind: 'question'; readonly dismissed: true };

export type KapContentPart = Readonly<Record<string, unknown>> & { readonly type: string };

export type PermissionMode = 'manual' | 'auto' | 'yolo';
