/**
 * `protocol` domain barrel — re-exports the protocol contract and its
 * App-scoped adapter registry. Importing this barrel registers the
 * `IProtocolAdapterRegistry` binding.
 */

/**
 * `protocol` domain barrel — re-exports the protocol contract and its
 * App-scoped adapter registry. Importing this barrel registers the
 * `IProtocolAdapterRegistry` binding.
 *
 * Also re-exports the kosong wire runtime that v2 currently delegates to
 * (`ChatProvider`, `GenerateResult`, `generate`) — sourced from `llmProtocol`
 * (the kosong wire source, kept flat there) and re-exported behind the
 * protocol boundary, the only kosong runtime v2 code should reach. Phase 8
 * replaces the underlying implementation; this re-export path stays.
 */

import './errors';

export type { ChatProvider } from '#/app/llmProtocol/provider';
export type { GenerateResult } from '#/app/llmProtocol/generate';
export { generate } from '#/app/llmProtocol/generate';

export * from './errors';
export * from './protocol';
export * from './protocolAdapterRegistry';
