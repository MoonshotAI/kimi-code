/**
 * `acp-fs` barrel — registers the ACP-backed `IHostFileSystem` (Session scope)
 * and its App-scope connection holder.
 *
 * Imported for its module side effects by `start.ts` before any session is
 * created, so the `IHostFileSystem` shadow is in place when the first session
 * scope is built.
 */

import './acpConnection';
import './acpFsService';

export { AcpConnection, IAcpConnection, type IAcpFsClient } from './acpConnection';
export { AcpHostFileSystem } from './acpFsService';
