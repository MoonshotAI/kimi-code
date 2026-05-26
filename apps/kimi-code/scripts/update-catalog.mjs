#!/usr/bin/env node
/**
 * Fetches models.dev/api.json, strips fields not needed by kimi-code, and
 * writes the result as raw JSON for release builds to inline.
 *
 * This script intentionally does not write into src/. The source tree keeps a
 * placeholder so the generated catalog is not committed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const scriptDir = import.meta.dirname;
const outFile = resolveOutputFile(process.argv.slice(2));
const modelsUrl = process.env.MODELS_DEV_URL || "https://models.dev/api.json";

const KEEP_PROVIDER = new Set(["id", "name", "api", "env", "npm", "type", "models"]);
const KEEP_MODEL = new Set([
  "id",
  "name",
  "family",
  "limit",
  "tool_call",
  "reasoning",
  "interleaved",
  "modalities",
]);

function resolveOutputFile(args) {
  const index = args.indexOf("--out");
  if (index !== -1) {
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw new Error("Missing value for --out");
    }
    return resolve(process.cwd(), value);
  }
  return resolve(scriptDir, "../dist/built-in-catalog.json");
}

function stripModel(model) {
  if (typeof model !== "object" || model === null) return undefined;
  const result = {};
  for (const key of Object.keys(model)) {
    if (KEEP_MODEL.has(key)) result[key] = model[key];
  }
  return result;
}

function stripProvider(provider) {
  if (typeof provider !== "object" || provider === null) return undefined;
  const result = {};
  for (const key of Object.keys(provider)) {
    if (!KEEP_PROVIDER.has(key)) continue;
    const value = provider[key];
    if (key === "models") {
      const stripped = {};
      for (const [mId, m] of Object.entries(value)) {
        const s = stripModel(m);
        if (s !== undefined) stripped[mId] = s;
      }
      if (Object.keys(stripped).length > 0) result[key] = stripped;
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function fetchCatalog(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid payload shape");
  }
  const stripped = {};
  for (const [k, v] of Object.entries(raw)) {
    const p = stripProvider(v);
    if (p !== undefined && Object.keys(p).length > 0) stripped[k] = p;
  }
  return JSON.stringify(stripped);
}

async function main() {
  console.log(`Fetching ${modelsUrl} ...`);
  const json = await fetchCatalog(modelsUrl);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json, "utf-8");
  console.log(`Wrote ${outFile} (${(json.length / 1024).toFixed(0)} KB JSON)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
