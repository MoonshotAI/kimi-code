import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { PromptHandle } from '#/agent/loop/loop';
import type { UserEntry } from '#human/agent/turn';

export type PromptDelivery = 'queue' | 'steer';

export type PromptLaunchMode = 'plan' | 'swarm' | 'goal';

export type PromptAcceptance = 'turn' | 'steer' | 'queue' | 'compact';

export interface QueuedPromptInput {
  readonly kind: 'input';
  readonly id: string;
  readonly delivery: PromptDelivery;
  readonly entry: UserEntry;
  readonly mode?: PromptLaunchMode;
  readonly createdAt: string;
}

export interface QueuedCompaction {
  readonly kind: 'compact';
  readonly id: string;
  readonly delivery: 'queue';
  readonly instruction?: string;
  readonly createdAt: string;
}

export type QueuedPromptItem = QueuedPromptInput | QueuedCompaction;

export interface PromptQueueSnapshot {
  readonly paused: boolean;
  readonly items: readonly QueuedPromptItem[];
}

export interface PromptQueueInputRequest {
  readonly id: string;
  readonly entry: UserEntry;
  readonly delivery: PromptDelivery;
  readonly mode?: PromptLaunchMode;
  readonly prepare?: () => Promise<void>;
  readonly onDrop?: () => void;
}

export interface PromptQueueCompactionRequest {
  readonly id: string;
  readonly instruction?: string;
}

export interface PromptQueueSubmitResult {
  readonly acceptedAs: PromptAcceptance;
  readonly handle?: PromptHandle;
}

export interface IAgentPromptQueueService {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<PromptQueueSnapshot>;

  snapshot(): PromptQueueSnapshot;

  hasPendingInputs(): boolean;

  hasPendingItems(): boolean;

  submitInput(request: PromptQueueInputRequest): Promise<PromptQueueSubmitResult>;

  submitCompaction(request: PromptQueueCompactionRequest): PromptQueueSubmitResult;

  pause(): void;

  resume(): void;

  steer(id: string): void;

  move(id: string, beforeId?: string): void;

  cancel(id: string): void;
}

export const IAgentPromptQueueService = createDecorator<IAgentPromptQueueService>('agentPromptQueueService');
