/**
 * Re-export the envelope helpers from `@moonshot-ai/protocol`.
 *
 * The wire-shape source of truth lives in `@moonshot-ai/protocol`. Re-exporting
 * the protocol helpers preserves field order and JSON output for daemon
 * responses.
 *
 * Keep this file as a re-export shim (not a direct re-export from the package
 * barrel) so downstream `from './envelope'` imports inside the daemon stay
 * stable and don't all need to be touched.
 */
export { okEnvelope, errEnvelope, type Envelope } from '@moonshot-ai/protocol';
