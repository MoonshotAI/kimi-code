// test/e2e/helpers/lock-racer.ts
//
// Child-side counterpart of the kernel-lock stress test. Sits in a loop;
// for each round it waits for `go-<round>` to appear in the gate directory,
// then races to acquire the lock and prints "R<round> <pid> <0|1>".

import fs from 'node:fs';
import { LockFile } from '../../../src/lockfile.js';

const lockPath = process.argv[2]!;
const gateDir = process.argv[3]!;
const rounds = Number(process.argv[4] ?? 200);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Signal readiness; the parent plants go-0 only once every racer is parked at
// the gate. Without this, per-round "holders > 1" conflates true simultaneous
// holders with plain boot-staggered sequential acquisitions.
console.log('READY');

for (let r = 0; r < rounds; r++) {
  const gate = `${gateDir}/go-${r}`;
  for (;;) {
    try {
      fs.statSync(gate);
      break;
    } catch {
      // Yield instead of spinning synchronously: a statSync busy-loop blocks
      // this process's event loop and delays its stdout flushes, which
      // misattributes outputs across rounds on the parent side.
      await sleep(1);
    }
  }
  const lf = new LockFile(lockPath);
  const got = await lf.acquire();
  process.stdout.write(`R${r} ${process.pid} ${got ? 1 : 0}\n`);
  if (got) {
    // Hold until the parent has collected every racer's line for this round
    // (it plants release-<r> once all RACERS lines are in). No fixed hold
    // duration survives per-round wake-up stagger: on a loaded runner a racer
    // can be descheduled past any hold+release window and then acquire
    // SEQUENTIALLY, truthfully reporting 1 — which the parent would misread
    // as two simultaneous holders. The gate makes every late racer see a
    // live, held lock and resolve as a loser deterministically. The timeout
    // is only a safety net for a dead parent.
    const releaseGate = `${gateDir}/release-${r}`;
    for (let waited = 0; ; waited += 1) {
      try {
        fs.statSync(releaseGate);
        break;
      } catch {
        if (waited >= 30_000) break;
        await sleep(1);
      }
    }
    lf.releaseSync();
  }
}
