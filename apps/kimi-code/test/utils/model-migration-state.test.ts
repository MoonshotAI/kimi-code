import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeModelMigration,
  readModelMigrationAcknowledgements,
} from '#/utils/model-migration-state';

describe('model-migration-state', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-model-migration-state-'));
    file = join(dir, 'model-migrations.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads no acknowledgements when the file is missing', async () => {
    await expect(readModelMigrationAcknowledgements(file)).resolves.toEqual({});
  });

  it('merges acknowledgements into the stored record', async () => {
    await acknowledgeModelMigration('acme/current', 'next', file);
    await acknowledgeModelMigration('other/current', 'newer', file);
    await acknowledgeModelMigration('acme/current', 'latest', file);

    await expect(readModelMigrationAcknowledgements(file)).resolves.toEqual({
      'acme/current': 'latest',
      'other/current': 'newer',
    });
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({
      version: 1,
      acknowledged: { 'acme/current': 'latest', 'other/current': 'newer' },
    });
  });

  it.each([
    ['corrupt', 'not json'],
    ['mismatched', JSON.stringify({ version: 2, acknowledged: {} })],
  ])('reads no acknowledgements from a %s file', async (_case, text) => {
    await writeFile(file, text, 'utf-8');
    await expect(readModelMigrationAcknowledgements(file)).resolves.toEqual({});
  });
});
