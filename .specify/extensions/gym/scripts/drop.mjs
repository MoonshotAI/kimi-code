#!/usr/bin/env node
// GYM — drop card recorder.
//
// Records a mis-fire as a card to the configured redundant stores (default:
// <project>/drops/ + the extension's append-only .drop-ledger.md). A card is a
// discovery to keep, never a mistake to punish.
//
//   node drop.mjs --agent <you> --where "GYM ex-1" \
//     --did "..." --expected "..." --happened "..."
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(EXT_DIR, 'gym-config.yml');
const DEFAULTS = { drop_stores: ['local', 'ledger'] };

function scalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) { i++; continue; }
    const m = t.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2].trim();
    if (val === '') {
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const t2 = lines[j].trim();
        if (t2.startsWith('- ')) { list.push(t2.slice(2).trim()); j++; }
        else if (t2 === '' || t2.startsWith('#')) { j++; }
        else break;
      }
      out[key] = list;
      i = j;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      out[key] = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else {
      out[key] = scalar(val);
      i++;
    }
  }
  return out;
}
function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const parsed = parseSimpleYaml(readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed.drop_stores !== undefined) cfg.drop_stores = parsed.drop_stores;
  } catch { /* defaults */ }
  return cfg;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') o.agent = argv[++i];
    else if (a === '--where') o.where = argv[++i];
    else if (a === '--did') o.did = argv[++i];
    else if (a === '--expected') o.expected = argv[++i];
    else if (a === '--happened') o.happened = argv[++i];
  }
  return o;
}

async function main() {
  const cfg = loadConfig();
  const stores = Array.isArray(cfg.drop_stores) && cfg.drop_stores.length ? cfg.drop_stores : ['local', 'ledger'];
  const o = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const date = new Date().toISOString().slice(0, 10);
  const agent = o.agent || 'unknown';

  const card =
    `# Drop Card\n\n` +
    `- **Agent**: ${o.agent || '(missing)'}\n` +
    `- **Where**: ${o.where || '(missing)'}\n` +
    `- **Did**: ${o.did || '(missing)'}\n` +
    `- **Expected**: ${o.expected || '(missing)'}\n` +
    `- **Happened**: ${o.happened || '(missing)'}\n` +
    `- **When**: ${new Date().toISOString()}\n`;

  const written = [];
  for (const store of stores) {
    if (store === 'local') {
      const dir = path.join(repoRoot, 'drops');
      await fs.mkdir(dir, { recursive: true });
      const p = path.join(dir, `DROP-${agent}-${date}.md`);
      await fs.writeFile(p, card, 'utf8');
      written.push(p);
    } else if (store === 'ledger') {
      const p = path.join(EXT_DIR, '.drop-ledger.md');
      await fs.appendFile(p, '\n---\n' + card, 'utf8');
      written.push(p);
    } else if (store === 'issue') {
      try {
        execFileSync('gh', ['issue', 'create', '--title', `Drop: ${o.where || agent}`, '--body', card], { stdio: 'ignore' });
        written.push('github-issue');
      } catch {
        /* gh unavailable or failed — skip */
      }
    }
  }

  console.log('Drop card recorded:');
  written.forEach((p) => console.log('  + ' + p));
  const missing = ['agent', 'where', 'did', 'expected', 'happened'].filter((k) => !o[k]);
  if (missing.length) console.log(`Note: missing fields flagged: ${missing.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
