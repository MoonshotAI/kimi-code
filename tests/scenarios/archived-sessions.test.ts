import type { KapFrame } from '@moonshot-ai/testkit/kap';
import { expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures());

function sessionFrame(frame: KapFrame, sessionId: string, change: string): Readonly<Record<string, unknown>> | undefined {
  if (frame.type !== 'session' || frame['change'] !== change) return undefined;
  const session = frame['session'] as Readonly<Record<string, unknown>> | undefined;
  return session?.['id'] === sessionId ? session : undefined;
}

test('keeps a session archived in the session frames that follow its archive', async ({ kap }) => {
  const socket = await kap.connect();
  const { id } = await kap.createSession();

  await kap.rest.post(`/api/v1/sessions/${id}:archive`, {});
  const archived = sessionFrame(await socket.waitFor((frame) => sessionFrame(frame, id, 'archived') !== undefined), id, 'archived');
  expect(archived).toMatchObject({ archived: true, archived_at: expect.any(String), activity: 'idle' });

  await kap.rest.post(`/api/v1/sessions/${id}/profile`, { title: 'Renamed after archive' });
  const renamed = await socket.waitFor((frame) => sessionFrame(frame, id, 'updated')?.['title'] === 'Renamed after archive');

  expect(sessionFrame(renamed, id, 'updated')).toMatchObject({ archived: true, archived_at: archived?.['archived_at'] });
  expect(await kap.session(id)).toMatchObject({
    title: 'Renamed after archive',
    archived: true,
    archived_at: archived?.['archived_at'],
  });
});
