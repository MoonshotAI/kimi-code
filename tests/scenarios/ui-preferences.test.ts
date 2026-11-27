import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KapFrame, KapSocket } from '@moonshot-ai/testkit/kap';
import { test as base, describe, expect } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const IMPORT_PATH = `/api/v1/ui-preferences:import`;

const test = base.extend<ScenarioFixtures>(scenarioFixtures());

interface Preferences {
  readonly revision: number;
  readonly values: Record<string, unknown>;
}

interface PreferencesFrame extends KapFrame {
  readonly type: 'ui_preferences';
  readonly revision: number;
  readonly changed: Record<string, unknown>;
  readonly client_id?: string;
}

function preferencesFrame(socket: KapSocket, key: string, value: unknown): Promise<PreferencesFrame> {
  return socket.waitFor(
    (frame) =>
      frame.type === 'ui_preferences' &&
      JSON.stringify((frame as PreferencesFrame).changed[key]) === JSON.stringify(value),
  ) as Promise<PreferencesFrame>;
}

describe('UI preferences over KAP', () => {
  test('a change from one client reaches another connected client with its revision', async ({ kap }) => {
    const first = await kap.rest.get<Preferences>('/api/v1/ui-preferences');
    expect(first).toEqual({ revision: 0, values: {} });
    const other = await kap.connect();

    const pending = preferencesFrame(other, 'sidebar.pinned_sessions', ['s1']);
    const patched = await kap.rest.patch<{ revision: number; changed: Record<string, unknown> }>(
      '/api/v1/ui-preferences',
      { ops: [{ op: 'add', key: 'sidebar.pinned_sessions', value: 's1' }], client_id: 'web-a' },
    );
    const frame = await pending;

    expect(patched).toEqual({ revision: 1, changed: { 'sidebar.pinned_sessions': ['s1'] } });
    expect(frame).toMatchObject({ revision: 1, client_id: 'web-a' });
    expect(await kap.rest.get<Preferences>('/api/v1/ui-preferences')).toEqual({
      revision: 1,
      values: { 'sidebar.pinned_sessions': ['s1'] },
    });
  });

  test('two clients pinning different sessions keep both', async ({ kap }) => {
    await Promise.all([
      kap.rest.patch('/api/v1/ui-preferences', { ops: [{ op: 'add', key: 'sidebar.pinned_sessions', value: 'a' }] }),
      kap.rest.patch('/api/v1/ui-preferences', { ops: [{ op: 'add', key: 'sidebar.pinned_sessions', value: 'b' }] }),
    ]);
    const { values } = await kap.rest.get<Preferences>('/api/v1/ui-preferences');
    expect([...(values['sidebar.pinned_sessions'] as string[])].toSorted()).toEqual(['a', 'b']);
  });

  test('imports merge per key type and never override what the user changed', async ({ kap }) => {
    const fromWeb = await kap.rest.post<{ imported: string[]; skipped: string[] }>(IMPORT_PATH, {
      values: {
        'sidebar.pinned_sessions': ['a'],
        'sidebar.view_mode': 'flat',
        'sidebar.pinned_order': ['session:a'],
        'onboarding.completed': false,
      },
    });
    expect(fromWeb.imported.toSorted()).toEqual([
      'onboarding.completed',
      'sidebar.pinned_order',
      'sidebar.pinned_sessions',
      'sidebar.view_mode',
    ]);
    expect(fromWeb.skipped).toEqual([]);

    const fromDesktop = await kap.rest.post<{ imported: string[]; skipped: string[] }>(IMPORT_PATH, {
      values: {
        'sidebar.pinned_sessions': ['b', 'a'],
        'sidebar.view_mode': 'grouped',
        'sidebar.pinned_order': ['session:b', 'session:a'],
        'onboarding.completed': true,
      },
    });
    expect(fromDesktop.imported.toSorted()).toEqual(['onboarding.completed', 'sidebar.pinned_order', 'sidebar.pinned_sessions']);
    expect(fromDesktop.skipped).toEqual(['sidebar.view_mode']);

    await kap.rest.patch('/api/v1/ui-preferences', { ops: [{ op: 'remove', key: 'sidebar.pinned_sessions', value: 'b' }] });
    const late = await kap.rest.post<{ imported: string[]; skipped: string[] }>(IMPORT_PATH, {
      values: { 'sidebar.pinned_sessions': ['c'] },
    });
    expect(late).toMatchObject({ imported: [], skipped: ['sidebar.pinned_sessions'] });

    expect((await kap.rest.get<Preferences>('/api/v1/ui-preferences')).values).toEqual({
      'sidebar.pinned_sessions': ['a'],
      'sidebar.view_mode': 'flat',
      'sidebar.pinned_order': ['session:a', 'session:b'],
      'onboarding.completed': true,
    });
  });

  test('keeps the preferences in ui-preferences.json at the root of the data directory', async ({ kap }) => {
    await kap.rest.patch('/api/v1/ui-preferences', { ops: [{ op: 'add', key: 'sidebar.pinned_sessions', value: 's1' }] });

    const saved = JSON.parse(await readFile(join(kap.home.dataDir, 'ui-preferences.json'), 'utf8')) as unknown;
    expect(saved).toEqual({
      version: 1,
      revision: 1,
      values: { 'sidebar.pinned_sessions': ['s1'] },
      origins: { 'sidebar.pinned_sessions': 'user' },
    });
  });

  test('a corrupted preferences file found by a read is kept as a backup and the preferences start over', async ({ kap }) => {
    const file = join(kap.home.dataDir, 'ui-preferences.json');
    await mkdir(kap.home.dataDir, { recursive: true });
    await writeFile(file, '{"revision": ', 'utf8');

    expect(await kap.rest.get<Preferences>('/api/v1/ui-preferences')).toEqual({ revision: 0, values: {} });
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('{"revision": ');

    const socket = await kap.connect();
    const pending = preferencesFrame(socket, 'sidebar.pinned_sessions', ['s1']);
    const patched = await kap.rest.patch<{ revision: number }>('/api/v1/ui-preferences', {
      ops: [{ op: 'add', key: 'sidebar.pinned_sessions', value: 's1' }],
    });
    expect(patched.revision).toBe(1);
    expect((await pending).revision).toBe(1);
  });

  test('a corrupted preferences file found by a write is kept as a backup and the write still applies', async ({ kap }) => {
    const file = join(kap.home.dataDir, 'ui-preferences.json');
    await kap.rest.patch('/api/v1/ui-preferences', { ops: [{ op: 'set', key: 'sidebar.view_mode', value: 'flat' }] });
    await writeFile(file, '{"values": []}', 'utf8');

    const patched = await kap.rest.patch<{ revision: number }>('/api/v1/ui-preferences', {
      ops: [{ op: 'add', key: 'sidebar.pinned_sessions', value: 's1' }],
    });

    expect(patched.revision).toBe(1);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('{"values": []}');
    expect((await kap.rest.get<Preferences>('/api/v1/ui-preferences')).values).toEqual({ 'sidebar.pinned_sessions': ['s1'] });
  });
});
