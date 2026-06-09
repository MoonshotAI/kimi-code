#!/usr/bin/env node
/**
 * Enforce the VS Code-style service naming convention finalized in
 * Phase 5 of the 2026.06.07 services-alignment plan:
 *
 *   - packages/services/src/<domain>/<domain>.ts (+ <domain>Service.ts)
 *   - packages/daemon/src/services/<domain>.ts  (+ <domain>Service.ts)
 *
 * Domain dirs and service-related .ts files must be camelCase — never
 * kebab-case (no `-` in the name). Anything outside these two roots is
 * ignored (test fixtures, agent-core, etc.).
 *
 * Exit code 0 if clean, 1 with an actionable report otherwise.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVICES_SRC = join(ROOT, "packages/services/src");
const DAEMON_SERVICES_SRC = join(ROOT, "packages/daemon/src/services");

/** @type {Array<{ kind: string, path: string }>} */
const violations = [];

function isKebab(name) {
  return name.includes("-");
}

function report(kind, absPath) {
  violations.push({ kind, path: relative(ROOT, absPath) });
}

/**
 * packages/services/src is organised as <domain>/<files>.ts plus a few
 * top-level files (index.ts, module.ts). Flag kebab in dir names and in
 * any .ts file directly under a domain dir.
 */
function scanServicesSrc() {
  if (!existsSync(SERVICES_SRC)) return;
  for (const entry of readdirSync(SERVICES_SRC)) {
    const abs = join(SERVICES_SRC, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (isKebab(entry)) report("kebab-dir", abs);
      for (const f of readdirSync(abs)) {
        if (!f.endsWith(".ts")) continue;
        if (isKebab(f)) report("kebab-file", join(abs, f));
      }
    } else if (entry.endsWith(".ts") && isKebab(entry)) {
      report("kebab-file", abs);
    }
  }
}

/**
 * packages/daemon/src/services is a flat directory of <domain>.ts and
 * <domain>Service.ts modules (plus serviceCollection.ts wiring).
 */
function scanDaemonServicesSrc() {
  if (!existsSync(DAEMON_SERVICES_SRC)) return;
  for (const f of readdirSync(DAEMON_SERVICES_SRC)) {
    if (!f.endsWith(".ts")) continue;
    if (isKebab(f)) report("kebab-file", join(DAEMON_SERVICES_SRC, f));
  }
}

scanServicesSrc();
scanDaemonServicesSrc();

if (violations.length > 0) {
  console.error(
    "Service naming violations (no kebab-case allowed for service files/dirs):"
  );
  for (const v of violations) console.error(`  [${v.kind}] ${v.path}`);
  console.error(
    "\nRename to camelCase per VS Code convention: <domain>.ts + <domain>Service.ts."
  );
  process.exit(1);
}

console.log("Service naming check passed.");
