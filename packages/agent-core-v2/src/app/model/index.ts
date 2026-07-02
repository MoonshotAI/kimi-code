/**
 * `model` domain barrel — re-exports the model contract (`model`) and its scoped
 * service (`modelService`). Importing this barrel registers the `IModelService`
 * binding into the scope registry, loads the `configSection` (self-registering
 * the `models` config section), and registers the `KIMI_MODEL_*` effective
 * overlay via `modelService`.
 */

import './configSection';

export * from './completionBudget';
export * from './model';
export type {
  AuthProvider,
  LLMRequestInput,
  Model,
  LLMEvent as ModelRequestEvent,
} from './modelInstance';
export * from './modelOverrides';
export * from './modelResolver';
export * from './modelResolverService';
export * from './modelService';
