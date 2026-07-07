import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateOneSession } from '../../src/sessions/migrate-one.js';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

const SCENARIOS = [
  'tiny-hello-world',
  'with-tool-calls',
  'with-thinking',
  'with-image',
  'with-subagent-collapsed',
  'legacy-protocol-1.3',
  'recent-protocol-1.10',
  'broken-state-json',
  'archived',
  'large-100msgs',
] as const;

let target: string;
beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), 'fixtures-snap-'));
});
afterEach(async () => {
  await rm(target, { recursive: true, force: true });
});

describe.each(SCENARIOS)('migration snapshot: %s', (name) => {
  it('migration succeeds and matches snapshot', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, name),
      oldSessionUuid: name,
      workdirPath: '/Users/example/proj',
      targetHome: target,
    });
    if (name === 'broken-state-json') {
      // Defaults should kick in; still succeed or fail gracefully.
      expect(['migrated', 'failed']).toContain(result.outcome);
      return;
    }
    expect(result.outcome).toBe('migrated');
    if (result.outcome !== 'migrated') return;

    const wire = await readFile(join(result.targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const state = await readFile(join(result.targetDir, 'state.json'), 'utf-8');
    // Redact clock-dependent fields (createdAt/updatedAt/imported_at) and the
    // machine-dependent source/target paths so the snapshot is stable across
    // hosts. `agents.main.homedir` is an absolute path under the temp target
    // dir — replace that prefix so only the stable suffix is snapshotted.
    const stableState = state
      .replace(/"createdAt": ".+?"/, '"createdAt": "<REDACTED>"')
      .replace(/"updatedAt": ".+?"/, '"updatedAt": "<REDACTED>"')
      .replace(/"imported_at": ".+?"/, '"imported_at": "<REDACTED>"')
      .replace(/"kimi_cli_source_path": ".+?"/, '"kimi_cli_source_path": "<REDACTED>"')
      .replaceAll('\\\\', '/')
      .split(target.replaceAll('\\', '/'))
      .join('<TARGET>');
    // Redact wire created_at timestamp (derived from wire_mtime or Date.now()).
    const stableWire = wire.replace(/"created_at":\s*\d+/, '"created_at":<REDACTED>');
    expect({ wire: stableWire, state: stableState }).toMatchSnapshot();
  });
});
