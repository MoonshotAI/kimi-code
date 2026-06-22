export {
  createServices,
  TestInstantiationService,
} from './testInstantiationService';
export type { ServiceIdCtorPair } from './testInstantiationService';
// Test-only/internal helper from the instantiation submodule. Re-exported here
// (not from the production barrel) so tests can inspect decorator metadata
// without polluting the public DI surface.
export { _util } from './instantiation';
