import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string;
};

export type PlanFilePath = string | null;

/**
 * Why plan mode was exited:
 * - `approved`: the plan was accepted (user-approved or auto-approved in
 *   `auto` permission mode) and execution may proceed.
 * - `rejected`: the user chose "Reject and Exit".
 * - `host`: the host toggled plan mode off through the session API.
 */
export type PlanExitReason = 'approved' | 'rejected' | 'host';

export interface PlanEnteredContext {
  readonly id: string;
  readonly path: string;
}

export interface PlanExitedContext {
  readonly id: string;
  readonly path: string;
  readonly reason: PlanExitReason;
}

export interface PlanCancelledContext {
  readonly id?: string;
}

export interface IAgentPlanService {
  readonly _serviceBrand: undefined;

  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(reason: PlanExitReason, id?: string): void;
  status(): Promise<PlanData>;

  readonly onDidEnter: Event<PlanEnteredContext>;
  readonly onDidExit: Event<PlanExitedContext>;
  readonly onDidCancel: Event<PlanCancelledContext>;
}

export const IAgentPlanService =
  createDecorator<IAgentPlanService>('agentPlanService');
