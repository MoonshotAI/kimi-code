/**
 * `kosong/contract.messageHelpers` — runtime helpers for building and
 * inspecting wire messages / content parts / tool calls.
 *
 * Constructors: `createAssistantMessage | createToolMessage | createUserMessage`.
 * Utilities: `extractText | mergeInPlace` (in-place merge of streamed
 * tool-call argument deltas).
 *
 * Values live in `./message` beside the wire types; this module re-exports
 * them so callers can take the helper surface without pulling in the entire
 * wire-type module.
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
