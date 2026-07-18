#!/usr/bin/env node
// Merge the per-arch mac updater metadata back into one feed file.
//
// desktop-build.yml renames each mac leg's `latest-mac.yml` to
// `latest-mac-<arch>.yml` (same-name files would collide when release.yml
// merges the per-target artifacts into one directory). Before creating the
// GitHub Release we merge them back: one `latest-mac.yml` whose `files` list
// covers both arm64 and x64 — electron-updater picks the zip matching the
// client's arch from that list. `path` / top-level `sha512` stay with the
// arm64 zip (alphabetical base) as the documented fallback.
//
// electron-builder's yml emitter is stable (2-space indent, each files entry
// starts with `  - url:`), so the merge is textual: take the alphabetically
// first file as base and insert the other files' entry blocks right before
// its `path:` line. No YAML dependency — this runs on a bare CI runner.
//
// Usage: node scripts/merge-mac-update-yml.mjs [dir]   (dir defaults to cwd)

import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';

const parts = readdirSync(dir)
  .filter((name) => /^latest-mac-(?:arm64|x64)\.yml$/.test(name))
  .sort();

if (parts.length === 0) {
  console.log('merge-mac-update-yml: no latest-mac-<arch>.yml found, nothing to do');
  process.exit(0);
}

// Entry blocks inside `files:`: each starts with `  - url:` and continues with
// more-indented lines (sha512 / size) until the next entry or a top-level key.
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

writeFileSync(join(dir, 'latest-mac.yml'), merged);
for (const name of parts) {
  unlinkSync(join(dir, name));
}

console.log(
  `merge-mac-update-yml: merged ${parts.join(' + ')} -> latest-mac.yml (+${extraEntries.length} files entries)`,
);
