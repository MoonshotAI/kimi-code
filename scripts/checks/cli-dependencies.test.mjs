import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintCliDependencies } from './cli-dependencies.mjs';

test('allows absent or empty dependencies alongside bundled and optional packages', () => {
  const manifest = { devDependencies: { qrcode: '^1' }, optionalDependencies: { clipboard: '^1' } };
  assert.equal(lintCliDependencies(manifest), null);
  assert.equal(lintCliDependencies({ ...manifest, dependencies: {} }), null);
});

test('reports each required CLI dependency and how to bundle it', () => {
  const error = lintCliDependencies({ dependencies: { ws: '^8', chokidar: '^4' } });
  assert.match(error, /apps\/kimi-code\/package\.json/);
  assert.match(error, /ws/);
  assert.match(error, /chokidar/);
  assert.match(error, /devDependencies/);
});
