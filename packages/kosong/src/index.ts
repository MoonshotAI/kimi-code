// Message types
export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from './message';
export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from './message';

// Provider interfaces
export * from './provider';
export { createProvider } from './providers';
export type { ProviderConfig, ProviderType } from './providers';

// Model capability matrix
export { UNKNOWN_CAPABILITY, isUnknownCapability } from './capability';
export type { ModelCapability } from './capability';

// Model catalog (models.dev-style) metadata
export {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
} from './catalog';
export type { Catalog, CatalogModel, CatalogModelEntry, CatalogProviderEntry } from './catalog';

// Core functions
export { generate } from './generate';
export type { GenerateCallbacks, GenerateResult } from './generate';

// Tool wire schema
export type { Tool } from './tool';

// Token usage
export { addUsage, emptyUsage, grandTotal, inputTotal } from './usage';
export type { TokenUsage } from './usage';

// Errors
export {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from './errors';

/**
 * Concrete provider adapters stay off the root barrel because their SDK type
 * graphs pollute downstream declaration bundles. Import them from subpaths:
 * `@moonshot-ai/kosong/providers/kimi`,
 * `@moonshot-ai/kosong/providers/openai-legacy`, etc.
 */
