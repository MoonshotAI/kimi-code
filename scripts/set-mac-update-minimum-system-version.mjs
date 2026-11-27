#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2] ?? '.';
const manifests = readdirSync(directory).filter((name) => /^[a-z]+-mac\.yml$/.test(name));
if (manifests.length !== 1) {
  throw new Error(`Expected exactly one macOS update manifest, found: ${manifests.join(', ') || 'none'}`);
}

const manifest = join(directory, manifests[0]);
const source = readFileSync(manifest, 'utf8');
const current = source.match(/^minimumSystemVersion:[ \t]*(\S+)[ \t]*$/m)?.[1];
if (current !== undefined && current !== '22.0.0') {
  throw new Error(`Unexpected macOS update minimum system version: ${current}`);
}
if (current === undefined) {
  writeFileSync(manifest, `${source}minimumSystemVersion: 22.0.0\n`);
}
