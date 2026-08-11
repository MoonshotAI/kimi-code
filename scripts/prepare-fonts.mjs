#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compress } from 'woff2-encoder';

const FONT_DIR = fileURLToPath(new URL('../packages/app-ui/src/assets/fonts/', import.meta.url));
const FONT_SOURCES = [
  {
    name: 'Noto Sans SC Variable',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    sourceSha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
    output: 'NotoSansSC[wght].woff2',
    outputSha256: '43c2f58299a21aaa962886e536c9e69f3c284f6cb6be39c57ce54a89d05205aa',
  },
  {
    name: 'Schibsted Grotesk Variable',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/schibstedgrotesk/SchibstedGrotesk%5Bwght%5D.ttf',
    sourceSha256: '6ceeadf6be8e1fd7687011c7fa38ed0edd1abe967a0b73d97caec183552e823d',
    output: 'SchibstedGrotesk[wght].woff2',
    outputSha256: '2b3e47ab920343dfac1030548c09056f857bde58054202a2e64faef75dbb506a',
  },
  {
    name: 'Schibsted Grotesk Variable Italic',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/schibstedgrotesk/SchibstedGrotesk-Italic%5Bwght%5D.ttf',
    sourceSha256: 'b49fedb6f3a2ff9b43e13351888641505dc8e5f300941e597eecbc3f52ba357b',
    output: 'SchibstedGrotesk-Italic[wght].woff2',
    outputSha256: 'da16fdbb94a068ef75d1a27b5b136234bf0930e51ec24e8bf05ac1964e968d6c',
  },
];
const LOCK_DIR = fileURLToPath(
  new URL('../packages/app-ui/src/assets/fonts/.font-preparation.lock', import.meta.url),
);
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 2 * 60 * 1000;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fontPath(font) {
  return fileURLToPath(new URL(`../packages/app-ui/src/assets/fonts/${font.output}`, import.meta.url));
}

async function hasPreparedFont(font) {
  try {
    return sha256(await readFile(fontPath(font))) === font.outputSha256;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasPreparedFonts() {
  return (await Promise.all(FONT_SOURCES.map(hasPreparedFont))).every(Boolean);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(LOCK_DIR);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    if (await hasPreparedFonts()) return false;

    try {
      const lock = await stat(LOCK_DIR);
      if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
        await rm(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      continue;
    }

    await sleep(250);
  }
  throw new Error(`Timed out waiting for the font preparation lock: ${LOCK_DIR}`);
}

async function downloadSource(font) {
  let response;
  try {
    response = await fetch(font.url);
  } catch (error) {
    throw new Error(`Could not download ${font.name} from ${font.url}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Could not download ${font.name}: HTTP ${response.status} ${response.statusText}`);
  }
  const source = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(source);
  if (actual !== font.sourceSha256) {
    throw new Error(`${font.name} source checksum mismatch: expected ${font.sourceSha256}, got ${actual}`);
  }
  return source;
}

async function prepareFont(font) {
  if (await hasPreparedFont(font)) return;

  const outputPath = fontPath(font);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    process.stdout.write(`[fonts] Downloading ${font.name}…\n`);
    const source = await downloadSource(font);
    process.stdout.write(`[fonts] Converting ${font.name} to WOFF2…\n`);
    const output = await compress(source);
    const actual = sha256(output);
    if (actual !== font.outputSha256) {
      throw new Error(`${font.name} output checksum mismatch: expected ${font.outputSha256}, got ${actual}`);
    }
    await writeFile(temporaryPath, output);
    await rename(temporaryPath, outputPath);
    process.stdout.write(`[fonts] Prepared ${outputPath}\n`);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function prepare() {
  await mkdir(FONT_DIR, { recursive: true });
  if (await hasPreparedFonts()) return;

  const ownsLock = await acquireLock();
  if (!ownsLock) return;

  try {
    for (const font of FONT_SOURCES) await prepareFont(font);
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
}

await prepare();
