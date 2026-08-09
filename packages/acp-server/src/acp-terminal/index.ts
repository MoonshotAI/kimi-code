/**
 * `acp-terminal` barrel — registers the ACP-backed Agent-scope
 * `ISessionProcessRunner`.
 *
 * Imported for its module side effects by `start.ts` before any session is
 * created, so the runner shadow is in place when the first agent scope is
 * built.
 */

import './acpTerminalRunner';

export { AcpProcessRunner } from './acpTerminalRunner';
