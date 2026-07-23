import { tryAcquireKernelFileLock } from '../src/index.js';

const path = process.argv[2];
if (path === undefined) throw new Error('lock path is required');

const handle = tryAcquireKernelFileLock(path);
if (handle === undefined) process.exit(2);

process.stdout.write('locked\n');
process.stdin.once('data', () => {
  handle.release();
  process.exit(0);
});
