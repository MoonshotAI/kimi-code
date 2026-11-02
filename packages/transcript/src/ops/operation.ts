import type {
  AgentId,
  FrameId,
  StepId,
  TurnId,
} from '../model/ids';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem, TranscriptMarker } from '../model/item';
import type { TranscriptPrompt } from '../model/prompt';
import type { TranscriptStep, TranscriptTurn } from '../model/turn';

export type TurnHeader = Omit<TranscriptTurn, 'steps'>;
export type StepHeader = Omit<TranscriptStep, 'frames'>;

export interface ResetOp {
  readonly op: 'reset';
  readonly agentId: AgentId;
  readonly snapshot: AgentTranscriptSnapshot;
}

export interface TurnUpsertOp {
  readonly op: 'turn.upsert';
  readonly turn: TurnHeader;
}

export interface StepUpsertOp {
  readonly op: 'step.upsert';
  readonly turnId: TurnId;
  readonly step: StepHeader;
}

export interface FrameUpsertOp {
  readonly op: 'frame.upsert';
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly frame: TranscriptFrame;
}

export interface AppendTarget {
  readonly type: 'frame';
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly frameId: FrameId;
}

export interface AppendOp {
  readonly op: 'append';
  readonly target: AppendTarget;
  readonly offset: number;
  readonly text: string;
}

export interface MarkerUpsertOp {
  readonly op: 'marker.upsert';
  readonly item: TranscriptMarker;
  readonly beforeTurn?: number;
}

export interface InteractionUpsertOp {
  readonly op: 'interaction.upsert';
  readonly interaction: TranscriptInteraction;
}

export interface AttachmentUpsertOp {
  readonly op: 'attachment.upsert';
  readonly attachment: TranscriptAttachment;
}

export interface PromptUpsertOp {
  readonly op: 'prompt.upsert';
  readonly prompt: TranscriptPrompt;
}

export interface ItemsRemoveOp {
  readonly op: 'items.remove';
  readonly ids: readonly string[];
}

export type TranscriptOperation =
  | ResetOp
  | TurnUpsertOp
  | StepUpsertOp
  | FrameUpsertOp
  | AppendOp
  | MarkerUpsertOp
  | InteractionUpsertOp
  | AttachmentUpsertOp
  | PromptUpsertOp
  | ItemsRemoveOp;

export interface TranscriptOpBatch {
  readonly agentId: AgentId;
  readonly ops: readonly TranscriptOperation[];
}

export interface AgentTranscriptSnapshot {
  readonly items: readonly TranscriptItem[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly prompts: readonly TranscriptPrompt[];
  readonly hasMoreOlder?: boolean;
}

export interface AppliedOps {
  readonly accepted: readonly TranscriptOperation[];
  readonly gap?: { readonly target: AppendTarget; readonly expected: number; readonly got: number };
}

export interface TranscriptChangeEvent {
  readonly agentId: AgentId;
  readonly ops: readonly TranscriptOperation[];
}
