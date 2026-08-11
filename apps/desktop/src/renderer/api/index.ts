// apps/web src/api — thin barrel. The api client + transport now live in
// @moonshot-ai/app-core; this module exposes the apps/web-composed singleton
// (see ./bootstrap) so existing `import { getKimiWebApi } from '../api'` sites
// keep working unchanged.
export { api, getKimiWebApi } from './bootstrap';
