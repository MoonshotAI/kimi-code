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
      source: { uuid: name, sessionDir: join(FIXTURES, name), contextPath: join(join(FIXTURES, name), 'context.jsonl') },
      workdirPath: '/Users/example/proj',
      targetHome: target,
    });
    if (name === 'broken-state-json') {
      expect(['migrated', 'failed']).toContain(result.outcome);
      return;
    }
    expect(result.outcome).toBe('migrated');
    if (result.outcome !== 'migrated') return;

    const wire = await readFile(join(result.targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const state = await readFile(join(result.targetDir, 'state.json'), 'utf-8');
    const stableState = state
      .replace(/"createdAt":\s*("[^"]*"|\d+)/, '"createdAt": "<REDACTED>"')
      .replace(/"updatedAt":\s*("[^"]*"|\d+)/, '"updatedAt": "<REDACTED>"')
      .replace(/"imported_at": ".+?"/, '"imported_at": "<REDACTED>"')
      .replace(/"kimi_cli_source_path": ".+?"/, '"kimi_cli_source_path": "<REDACTED>"')
      .replaceAll('\\\\', '/')
      .split(target.replaceAll('\\', '/'))
      .join('<TARGET>');
    const stableWire = wire
      .replace(/"created_at":\s*\d+/, '"created_at":<REDACTED>')
      .replaceAll(/"time":\s*\d+/g, '"time":<REDACTED>');
    expect({ wire: stableWire, state: stableState }).toMatchSnapshot();
  });
});
