import { readFileSync } from 'node:fs';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { EVENT2_REGISTRY } from '#/app/event/event2';
import { AGENT_WIRE_RECORD_TYPES, HUMAN_AGENT_DOMAIN } from '#/wire/human';

import { buildWireManifest, MANIFEST_PATH } from '../../scripts/gen-wire-manifest.mts';

describe('wire manifest', () => {
  it('docs/wire-manifest.d.ts is up to date', async () => {
    const expected = await buildWireManifest();
    const actual = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(actual).toBe(expected);
    for (const type of EVENT2_REGISTRY.keys()) {
      expect(type.startsWith(`${HUMAN_AGENT_DOMAIN}.`)).toBe(false);
    }
    expect([...AGENT_WIRE_RECORD_TYPES].toSorted()).toEqual([
      'agent.input.cancelled',
      'agent.input.drained',
      'agent.input.notified',
      'agent.input.reminded',
      'agent.input.steered',
      'agent.input.submitted',
      'agent.message.appended',
      'agent.notifications.drained',
      'agent.queue.drained',
      'agent.switched',
      'agent.turn.ended',
      'agent.turn.started',
      'context.append_loop_event',
      'context.append_message',
      'context.apply_compaction',
      'context.clear',
      'context.undo',
      'context.undone',
      'turn.cancel',
      'turn.ended',
      'turn.prompt',
      'turn.steer',
    ]);
  }, 60_000);

  it('docs/wire-manifest.d.ts parses as TypeScript', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      'wire-manifest.d.ts',
      readFileSync(MANIFEST_PATH, 'utf-8'),
    );
    const diagnostics = (sourceFile.compilerNode as { parseDiagnostics?: readonly unknown[] })
      .parseDiagnostics;
    expect(diagnostics ?? []).toEqual([]);
  });
});
