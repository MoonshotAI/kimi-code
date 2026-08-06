/**
 * `debug` domain — `IDebugCascadeService`: cascade history, waiting area, and
 * triggers (L5 debug surface, plan §5.11).
 *
 * Public contract. `history()` folds every engine's history ring of the scope
 * tree (each entry tagged with its orchestrating scope's path); `pending()`
 * reports the waiting area and the sticky-failed units per scope. The
 * triggers address a unit by `(scopePath, token)` and drive the kernel's
 * public cascade entries:
 *
 *   - `unprovide` — registration removal through the container's
 *     registry-level `unprovide` (the same entry business code calls);
 *   - `update` — restart: `cascade.update` without a config, or a config
 *     patch + reload through the fiber host when `config` is given;
 *   - `dispose` — the plan §5.11 `dispose(handle)` spelling: an awaited
 *     cascade `unprovide` submission. The kernel exposes no retire-only entry,
 *     so `dispose` and `unprovide` reach the same end state (registration
 *     removed, dependents cascaded to the waiting area); they differ only in
 *     the entry exercised. Both settle the cascade before returning.
 *
 * The service is also the producer of the `event.di.unit_changed` global
 * event: while active it watches every engine of the tree (including
 * late-joined scopes) and republishes unit state transitions on
 * `IEventService`. Bound at App scope. All payloads are JSON-serializable
 * wire data.
 */

import type { CascadeAction, UnitState } from '#/_base/di/cascadeEngine';
import { createDecorator } from '#/_base/di/instantiation';

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

export const DI_UNIT_CHANGED_EVENT = 'event.di.unit_changed';

export interface DiUnitChangedPayload {
  readonly scope: string;
  readonly token: string;
  readonly state: UnitState;
  readonly error?: string;
}

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
