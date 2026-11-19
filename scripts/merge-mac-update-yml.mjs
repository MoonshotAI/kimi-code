#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';

const CHANNEL_MAC_PART = /^([a-z]+)-mac-(?:arm64|x64)\.yml$/;

const parts = readdirSync(dir)
  .filter((name) => CHANNEL_MAC_PART.test(name))
  .sort();

if (parts.length === 0) {
  console.log('merge-mac-update-yml: no <channel>-mac-<arch>.yml found, nothing to do');
  process.exit(0);
}

const channels = new Set(parts.map((name) => name.match(CHANNEL_MAC_PART)[1]));
if (channels.size !== 1) {
  console.error(`merge-mac-update-yml: mixed channels in ${parts.join(', ')}`);
  process.exit(1);
}
const [channel] = channels;

function extractFileEntries(yml) {
  const entries = [];
  let current = null;
  for (const line of yml.split('\n')) {
    if (line.startsWith('  - url: ')) {
      if (current !== null) entries.push(current);
      current = [line];
    } else if (current !== null && (line.startsWith('    ') || line.trim() === '')) {
      current.push(line);
    } else if (current !== null) {
      entries.push(current);
      current = null;
    }
  }
  if (current !== null) entries.push(current);
  return entries.map((lines) => lines.join('\n').replace(/\n+$/, ''));
}

const [baseName, ...restNames] = parts;
const base = readFileSync(join(dir, baseName), 'utf8');
const extraEntries = restNames.flatMap((name) =>
  extractFileEntries(readFileSync(join(dir, name), 'utf8')),
);

if (extraEntries.length === 0) {
  console.error(`merge-mac-update-yml: no files entries found in ${restNames.join(', ')}`);
  process.exit(1);
}

const merged = base.replace(/^path:/m, `${extraEntries.join('\n')}\npath:`);
if (merged === base) {
  console.error(`merge-mac-update-yml: ${baseName} has no top-level \`path:\` line to anchor on`);
  process.exit(1);
}

writeFileSync(join(dir, `${channel}-mac.yml`), merged);
for (const name of parts) {
  unlinkSync(join(dir, name));
}

console.log(
  `merge-mac-update-yml: merged ${parts.join(' + ')} -> ${channel}-mac.yml (+${extraEntries.length} files entries)`,
);
