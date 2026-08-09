/**
 * `kosong/contract.messageHelpers` — runtime helpers for building and
 * inspecting wire messages / content parts / tool calls.
 *
 * Constructors: `createAssistantMessage | createToolMessage | createUserMessage`.
 * Utilities: `extractText | mergeInPlace` (in-place merge of streamed
 * tool-call argument deltas).
 *
 * Re-exports the helper surface so callers can take it without pulling in the
 * entire wire-type module.
 */

export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  isToolDeclarationOnlyMessage,
  mergeInPlace,
} from './message';
