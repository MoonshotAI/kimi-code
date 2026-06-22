/**
 * Barrel for the di-v3 scope identity contexts.
 *
 * Re-exports the four scope identity contexts. Each name carries both the
 * interface type and the `createDecorator` value (declaration merging), so a
 * single `import { IAgentContext }` gives consumers the type and the decorator.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md` (I*Context) plus
 * DR10 (context field-name normalization: `id` / `parentId` / `abortSignal` /
 * `executionScope`).
 */

export { IAgentContext } from './agentContext';
export { ISessionContext } from './sessionContext';
export { IToolCallContext } from './toolCallContext';
export { ITurnContext } from './turnContext';
