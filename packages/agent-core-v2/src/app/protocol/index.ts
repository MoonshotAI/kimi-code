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
 * (`ChatProvider`, `GenerateResult`, `generate`) — these live behind the
 * protocol boundary and are the only kosong runtime v2 code should reach.
 * Phase 8 replaces the underlying implementation; this re-export path stays.
 */

import './errors';

export type { ChatProvider, GenerateResult } from '@moonshot-ai/kosong';
export { generate } from '@moonshot-ai/kosong';

export * from './errors';
export * from './protocol';
export * from './protocolAdapterRegistry';
