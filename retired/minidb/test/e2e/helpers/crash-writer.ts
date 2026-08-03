// test/e2e/helpers/crash-writer.js
// Child process: writes keys k0,k1,k2,... sequentially with fsyncPolicy='always'
// (so every *completed* set is durable), optionally compacting every N writes.
// Runs until killed by the parent (crash injection).
//
//   node crash-writer.js <dir> [compactEvery]

import { MiniDb } from '../../../src/index.js';

const dir = process.argv[2];
const compactEvery = Number(process.argv[3] || 0);
if (!dir) {
  console.error('usage: crash-writer.js <dir> [compactEvery]');
  process.exit(2);
}

const db = await MiniDb.open({
  dir,
  valueCodec: 'json',
  fsyncPolicy: 'always',
  autoCompact: false,
});

let i = 0;
for (;;) {
  await db.set('k' + i, { i, pad: 'x'.repeat(40) });
  i++;
  if (compactEvery && i % compactEvery === 0) {
    try {
      await db.compact();
    } catch {
      /* compaction may race with the kill; ignore */
    }
  }
  if (i % 25 === 0) console.log(String(i));
}
