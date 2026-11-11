import { fileURLToPath } from 'node:url';

import { copySqlitePrebuilds } from '../../../build/copy-sqlite-prebuilds.mjs';

await copySqlitePrebuilds(fileURLToPath(new URL('../dist/better-sqlite3/', import.meta.url)));
