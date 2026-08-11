/**
 * `wire` domain — the `WireModelContribution` collection token (D12), its
 * per-domain record shape, and the fold that collapses the built-in layer
 * plus live contribution records into the lookup structure the wire runtime
 * consults.
 *
 * A unit contributes one bundle of wire vocabulary per domain with
 * `this.provide(WireModelContribution, …)`: `models` (the `defineModel`
 * products), `ops` (the `OpDescriptor`s), `crossReducers` (cross-model
 * reducers keyed by foreign op type), and `checkpointedModels` (the
 * `defineCheckpointedModel` products). The fold lives in `WireService`
 * (Agent scope): it refolds from the built-in layer and the view's surviving
 * records on every `onDidChange` — the collection edge enters the dependency
 * graph for introspection but never rebuilds the service. A withdrawn record
 * removes its vocabulary, so replaying that domain's historical wire records
 * lands on the generic unknown-op path (skip + count): persisted facts stay
 * readable when the contributing unit is long gone.
 *
 * The built-in layer is the module tables (`OP_REGISTRY`, `MODEL_REGISTRY`,
 * `MODEL_CROSS_REDUCERS`, `CHECKPOINTED_MODELS`), drained at fold time:
 * `defineOp` / `defineModel` / `defineCheckpointedModel` ("import =
 * register") stay the static built-in data channel, every table is filled at
 * module load — long before any scope constructs a `WireService` — and no op
 * module is ever imported lazily, so draining at fold time is equivalent to
 * the old live reads. (Routing the built-in layer through an App-scope
 * assembly unit as just another collection record was considered and
 * rejected: every bare-container `WireService` construction — unit tests
 * included — would then have to materialize that assembly first. The sibling
 * folds drain their module collectors at fold construction the same way.)
 *
 * Conflict semantics: `defineOp` keeps its module-load fail-fast
 * (`DuplicateOpError`). The fold is an event path and never throws — a later
 * record whose op type collides with an already-folded type is skipped and
 * reported through `onUnexpectedError`, and the built-in layer always folds
 * first so built-ins win every collision (a persistent conflict re-logs on
 * each refold). Scope-agnostic.
 */

import { collection } from '#/_base/di/collection';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import {
  CHECKPOINTED_MODELS,
  type Checkpointed,
} from '#/agent/contextMemory/conversationTime';

import { WireError, WireErrors } from './errors';
import {
  MODEL_CROSS_REDUCERS,
  MODEL_REGISTRY,
  type ModelCrossReducerEntry,
  type ModelDef,
} from './model';
import { OP_REGISTRY, type OpDescriptor } from './op';

export interface WireModelContributionRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly models?: readonly ModelDef<any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ops?: readonly OpDescriptor<any, any, any>[];
  readonly crossReducers?: ReadonlyMap<string, readonly ModelCrossReducerEntry[]>;
  readonly checkpointedModels?: readonly ModelDef<Checkpointed<unknown>>[];
}

export const WireModelContribution = collection<WireModelContributionRecord>('wire-model');

export interface FoldedWireRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ops: ReadonlyMap<string, OpDescriptor<any, any, any>>;
  readonly crossReducers: ReadonlyMap<string, readonly ModelCrossReducerEntry[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly models: readonly ModelDef<any>[];
  readonly checkpointedModels: readonly ModelDef<Checkpointed<unknown>>[];
}

export function builtinWireContribution(): WireModelContributionRecord {
  return {
    models: [...MODEL_REGISTRY],
    ops: [...OP_REGISTRY.values()],
    crossReducers: MODEL_CROSS_REDUCERS,
    checkpointedModels: [...CHECKPOINTED_MODELS],
  };
}

export function foldWireContributions(
  records: readonly WireModelContributionRecord[],
): FoldedWireRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops = new Map<string, OpDescriptor<any, any, any>>();
  const crossReducers = new Map<string, ModelCrossReducerEntry[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models: ModelDef<any>[] = [];
  const checkpointedModels: ModelDef<Checkpointed<unknown>>[] = [];
  for (const record of records) {
    for (const op of record.ops ?? []) {
      if (ops.has(op.type)) {
        onUnexpectedError(
          new WireError(
            WireErrors.codes.WIRE_DUPLICATE_OP,
            `Duplicate Op type contributed: '${op.type}'; keeping the already-folded registration`,
            { details: { type: op.type } },
          ),
        );
        continue;
      }
      ops.set(op.type, op);
    }
    for (const [opType, entries] of record.crossReducers ?? []) {
      let list = crossReducers.get(opType);
      if (list === undefined) {
        list = [];
        crossReducers.set(opType, list);
      }
      for (const entry of entries) {
        const duplicate = list.some(
          (existing) => existing.model === entry.model && existing.reducer === entry.reducer,
        );
        if (!duplicate) {
          list.push(entry);
        }
      }
    }
    for (const model of record.models ?? []) {
      if (!models.includes(model)) {
        models.push(model);
      }
    }
    for (const model of record.checkpointedModels ?? []) {
      if (!checkpointedModels.includes(model)) {
        checkpointedModels.push(model);
      }
    }
  }
  return { ops, crossReducers, models, checkpointedModels };
}
