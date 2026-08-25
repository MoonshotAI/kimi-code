#!/usr/bin/env node
// GYM — Operator Forging runner (extension build).
//
// Adapted from the reference gym.mjs into an installable, project-agnostic form:
//   - locations + timeout come from gym-config.yml (defaults: gym/ + exercises/)
//   - warmup reps expose verify(ctx); graded exercises expose evaluate(sandbox)
//   - the gate (gym/.gate) opens only when every rep is grown and every exercise passed
//   - degrades gracefully: empty curriculum -> gate open; thrown verify/evaluate -> fail
//
// Subcommands: init | run | warmup | gate   (drop is handled by drop.mjs)
//   node gym-runner.mjs run
//   GYM_EXERCISES=skip node gym-runner.mjs run   (warmup only)
//   GYM_TIMEOUT=20 node gym-runner.mjs run
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..'); // .specify/extensions/gym
const CONFIG_PATH = path.join(EXT_DIR, 'gym-config.yml');
const DEFAULTS = {
  warmup_location: 'gym/',
  exercises_location: 'exercises/',
  exercise_timeout_sec: 60,
  warmup_only: false,
  drop_stores: ['local', 'ledger'],
};

// --- minimal YAML reader (flat keys + block/inline lists; no nesting) ---------
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
    for (const k of Object.keys(DEFAULTS)) {
      if (parsed[k] !== undefined) cfg[k] = parsed[k];
    }
  } catch {
    /* defaults */
  }
  return cfg;
}

const config = loadConfig();
const repoRoot = process.cwd();
const warmupDir = path.resolve(repoRoot, config.warmup_location);
const exercisesDir = path.resolve(repoRoot, config.exercises_location);
const SANDBOX = path.join(warmupDir, '.sandbox');
const gatePath = path.join(warmupDir, '.gate');

const ctx = {
  fs,
  path: (...p) => path.join(repoRoot, ...p),
  sandbox: SANDBOX,
  async read(p) {
    try { return await fs.readFile(p, 'utf8'); } catch { return null; }
  },
  async write(p, s) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, s, 'utf8');
  },
  log: (m) => process.stdout.write('    ' + m + '\n'),
};

async function loadModules(dir) {
  const mods = [];
  if (!existsSync(dir)) return mods;
  const files = globSync('*.mjs', { cwd: dir }).sort();
  for (const f of files) {
    try {
      const mod = await import(path.join(dir, f));
      if (mod.default) mods.push({ file: f, ...mod.default });
    } catch (e) {
      console.log(`    SKIP ${f} — ${e.message}`);
    }
  }
  return mods;
}

async function writeGate(state) {
  await fs.mkdir(path.dirname(gatePath), { recursive: true });
  await fs.writeFile(gatePath, state, 'utf8');
}

async function waitForSubmit(sandbox, timeoutSec) {
  const marker = path.join(sandbox, '.submitted');
  const deadline = Date.now() + timeoutSec * 1000;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        await fs.access(marker);
        return resolve(true);
      } catch {
        if (Date.now() >= deadline) return resolve(false);
        process.stdout.write('.');
        setTimeout(tick, 2000);
      }
    };
    tick();
  });
}

async function runWorkout(warmupOnly) {
  const reps = (await loadModules(warmupDir)).filter((e) => typeof e.verify === 'function');
  const exercises = warmupOnly
    ? []
    : (await loadModules(exercisesDir)).filter((e) => typeof e.evaluate === 'function');

  if (reps.length === 0 && exercises.length === 0) {
    console.log('GYM — no curriculum defined. Nothing to train.');
    await writeGate('open');
    return { gate: 'open', grown: 0, reps: 0, passed: 0, exercises: 0 };
  }

  console.log(`GYM — ${reps.length} warmup rep(s), ${exercises.length} exercise(s).`);
  console.log(`sandbox: ${SANDBOX}\n`);

  console.log(`PHASE 1 — WARMUP (${reps.length} rep(s)). Grow or stay weak.\n`);
  let grown = 0;
  let passed = 0;
  for (const ex of reps) {
    process.stdout.write(`[${ex.id}] ${ex.name}  (muscle: ${ex.muscle})\n    ${ex.brief}\n`);
    try {
      const res = await ex.verify(ctx);
      if (res && res.ok) { console.log('    GROWN\n'); grown++; }
      else { console.log(`    WEAK — ${res?.note || 'verify returned false'}\n`); }
    } catch (e) {
      console.log(`    WEAK — ${e.message}\n`);
    }
  }
  console.log(`BOARD: ${grown}/${reps.length} muscles grown.\n`);
  if (grown < reps.length) {
    console.log('NOT READY. Finish the warmup before any exercise.');
  }

  const warmupBlocks = reps.length > 0 && grown < reps.length;
  if (!warmupOnly && !warmupBlocks) {
    console.log(`PHASE 2 — EXERCISES (${exercises.length}). Build it solo, then submit. The gate grades you.\n`);
    for (const ex of exercises) {
      process.stdout.write(`[${ex.id}] ${ex.name}  (muscle: ${ex.muscle})\n    ${ex.brief}\n    sandbox: ${SANDBOX}\n`);
      process.stdout.write(`    waiting for .submitted (${config.exercise_timeout_sec}s)\n    `);
      const submitted = await waitForSubmit(SANDBOX, config.exercise_timeout_sec);
      if (!submitted) console.log('\n    NO SUBMISSION within timeout.');
      else console.log('\n    SUBMITTED.');
      try {
        const r = await ex.evaluate(SANDBOX);
        if (r && r.pass) { console.log(`    PASSED — ${r.notes || ''}\n`); passed++; }
        else { console.log(`    FAILED — ${r?.notes || 'evaluate returned false'}\n`); }
      } catch (e) {
        console.log(`    FAILED — ${e.message}\n`);
      }
    }
    console.log(`EXERCISES: ${passed}/${exercises.length} passed.`);
  } else if (!warmupOnly && warmupBlocks) {
    console.log('WARMUP INCOMPLETE — exercises skipped. The gate stays closed.');
  }

  if (warmupOnly) {
    const gate = reps.length === 0 ? 'open' : 'closed';
    await writeGate(gate);
    if (grown === reps.length) {
      console.log('READY (warmup). Re-run without warmup-only to clear the gate.');
      return { gate, grown, reps: reps.length, passed: 0, exercises: 0 };
    }
    console.log('GATE CLOSED (warmup only).');
    return { gate, grown, reps: reps.length, passed: 0, exercises: 0 };
  }

  const repsOk = grown === reps.length;
  const exOk = passed === exercises.length;
  const gate = repsOk && exOk ? 'open' : 'closed';
  await writeGate(gate);
  if (gate === 'open') console.log('GATE OPEN. You wield it. Go.');
  else console.log('GATE CLOSED. You did not clear the exercises.');
  return { gate, grown, reps: reps.length, passed, exercises: exercises.length };
}

async function doInit() {
  await fs.mkdir(warmupDir, { recursive: true });
  await fs.mkdir(exercisesDir, { recursive: true });
  const exWarm = path.join(EXT_DIR, 'examples', 'gym');
  const exEx = path.join(EXT_DIR, 'examples', 'exercises');
  const copied = [];
  for (const f of existsSync(exWarm) ? globSync('*.mjs', { cwd: exWarm }) : []) {
    await fs.copyFile(path.join(exWarm, f), path.join(warmupDir, f));
    copied.push(path.join(warmupDir, f));
  }
  for (const f of existsSync(exEx) ? globSync('*.mjs', { cwd: exEx }) : []) {
    await fs.copyFile(path.join(exEx, f), path.join(exercisesDir, f));
    copied.push(path.join(exercisesDir, f));
  }
  const cfgDest = path.join(EXT_DIR, 'gym-config.yml');
  if (!existsSync(cfgDest)) {
    await fs.copyFile(path.join(EXT_DIR, 'config-template.yml'), cfgDest);
    copied.push(cfgDest);
  }
  console.log('GYM curriculum scaffolded:');
  copied.forEach((f) => console.log('  + ' + path.relative(repoRoot, f)));
}

async function doGate() {
  let state = 'closed';
  try { state = (await fs.readFile(gatePath, 'utf8')).trim() || 'closed'; } catch { /* not run yet */ }
  console.log(state);
  return state;
}

async function main() {
  const mode = process.argv[2] || 'run';
  if (mode === 'init') { await doInit(); return; }
  if (mode === 'gate') {
    const s = await doGate();
    process.exit(s === 'open' ? 0 : 1);
  }
  const warmupOnly = mode === 'warmup' || config.warmup_only || process.env.GYM_EXERCISES === 'skip';
  const r = await runWorkout(warmupOnly);
  if (warmupOnly) process.exit(r.grown === r.reps ? 0 : 1);
  process.exit(r.gate === 'open' ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
