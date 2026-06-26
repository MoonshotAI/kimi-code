/**
 * `cron` domain (L5) — schedules cron tasks and coordinates their firing.
 *
 * Defines the public contract of session cron: the `CronTask` / `CronFiredEvent`
 * models, the `ICronService` used to create, list, and delete tasks and observe
 * `onDidFire`, and the `ICronFireCoordinator` that reacts to fires.
 * Session-scoped — one instance per session.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly recurring?: boolean;
}

export interface CronFiredEvent {
  readonly taskId: string;
  readonly content: string;
  readonly origin?: string;
}

export interface ICronService {
  readonly _serviceBrand: undefined;
  readonly onDidFire: Event<CronFiredEvent>;
  create(task: CronTask): Promise<string>;
  list(): readonly CronTask[];
  delete(id: string): Promise<void>;
}

export const ICronService: ServiceIdentifier<ICronService> =
  createDecorator<ICronService>('cronService');

export interface ICronFireCoordinator {
  readonly _serviceBrand: undefined;
}

export const ICronFireCoordinator: ServiceIdentifier<ICronFireCoordinator> =
  createDecorator<ICronFireCoordinator>('cronFireCoordinator');
