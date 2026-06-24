/**
 * `background` domain (L5) — per-agent background task manager.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface BackgroundTask {
  readonly id: string;
  readonly kind: string;
}

export interface IBackgroundService {
  readonly _serviceBrand: undefined;
  start(task: BackgroundTask): Promise<string>;
  stop(id: string): Promise<void>;
  list(): readonly BackgroundTask[];
  getOutput(id: string): Promise<string>;
}

export const IBackgroundService: ServiceIdentifier<IBackgroundService> =
  createDecorator<IBackgroundService>('backgroundService');
