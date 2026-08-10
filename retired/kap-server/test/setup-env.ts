/**
 * Test isolation: pin the Kimi home to a scratch dir so the engine (spawned
 * as a stdio subprocess, inheriting this env) never reads the developer's
 * real `~/.kimi-code/config.toml`. Tests that pass their own `homeDir` to
 * startServer also need this, because the engine resolves the config path
 * from `KIMI_CODE_HOME` (or the user home) on its own.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'kimi-kap-server-test-'));
process.env['KIMI_CODE_HOME'] = scratch;
// Isolate the engine's persistent store (sessions.db) the same way: fixed
// session ids across runs would otherwise leak stale work_dir/metadata
// records from the real agent home.
process.env['KIMI_AGENT_HOME'] = join(scratch, 'agent');
