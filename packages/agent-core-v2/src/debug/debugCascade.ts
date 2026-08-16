/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { CascadeAction, UnitState } from '#/_base/di/cascadeEngine';
import { createDecorator } from '#/_base/di/instantiation';
import { Event2 } from '#/app/event/event2';

export interface DebugCascadeEntry {
  readonly scopePath: string;
  readonly seq: number;
  readonly reason: string;
  readonly changes: ReadonlyArray<{ token: string; action: CascadeAction }>;
  readonly affected: readonly string[];
  readonly tornDown: readonly string[];
  readonly rebuilt: readonly string[];
  readonly failed: readonly string[];
  readonly abortWaited: boolean;
  readonly abortTimedOut: boolean;
  readonly durationMs: number;
}

export interface DebugPendingUnit {
  readonly token: string;
  readonly missing: string[];
}

export interface DebugFailedUnit {
  readonly token: string;
  readonly error?: string;
}

export interface DebugPendingGroup {
  readonly scopePath: string;
  readonly waiting: DebugPendingUnit[];
  readonly failed: DebugFailedUnit[];
}

export interface DiUnitChangedPayload {
  readonly scope: string;
  readonly token: string;
  readonly state: UnitState;
  readonly error?: string;
}

export class DiUnitChanged extends Event2<{ readonly payload: DiUnitChangedPayload }> {
  static override readonly type = 'event.di.unit_changed';
}
export interface DiUnitChanged {
  readonly payload: DiUnitChangedPayload;
}

export const DI_UNIT_CHANGED_EVENT = DiUnitChanged.type;

export interface IDebugCascadeService {
  readonly _serviceBrand: undefined;

  history(): DebugCascadeEntry[];
  pending(): DebugPendingGroup[];
  unprovide(scopePath: string, token: string): Promise<void>;
  update(scopePath: string, token: string, config?: unknown): Promise<void>;
  dispose(scopePath: string, token: string): Promise<void>;
}

export const IDebugCascadeService =
  createDecorator<IDebugCascadeService>('debugCascadeService');
