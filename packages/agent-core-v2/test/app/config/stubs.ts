/**
 * `config` test stubs — shared config collaborators for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../config/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';

export function registerConfigServices(reg: ServiceRegistration): void {
  reg.defineInstance(IConfigRegistry, new ConfigRegistry());
  reg.definePartialInstance(IConfigService, {});
  reg.define(IAtomicTomlDocumentStore, TomlAtomicDocumentStore);
}
