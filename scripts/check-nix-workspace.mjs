#!/usr/bin/env node
/**
 * Recursively resolve workspace dependencies starting from apps/kimi-code
 * and verify they are all present in flake.nix workspaceNames/workspacePaths.
 *
 * Exit code 0 if everything is in sync, 1 otherwise.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FLAKE_NIX = join(ROOT, "flake.nix");
const START_PKG = "@moonshot-ai/kimi-code";

/**
 * Parse pnpm-workspace.yaml to get workspace directory globs.
 */
function getWorkspaceGlobs() {
  const yamlPath = join(ROOT, "pnpm-workspace.yaml");
  const content = readFileSync(yamlPath, "utf8");
  const lines = content.split("\n");
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (line.startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^\s+-\s+(.+)$/);
      if (match) {
        globs.push(match[1]);
      } else if (line.trim() !== "" && !line.startsWith(" ")) {
        break;
      }
    }
  }
  return globs;
}

/**
 * Expand globs like "packages/*" into actual directories.
 */
function expandGlobsSafe(globs) {
  const dirs = [];
  for (const g of globs) {
    if (g.endsWith("/*")) {
      const base = g.slice(0, -2);
      const basePath = join(ROOT, base);
      if (!existsSync(basePath)) continue;
      for (const entry of readdirSync(basePath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(join(base, entry.name));
        }
      }
    } else {
      const p = join(ROOT, g);
      if (existsSync(p)) {
        dirs.push(g);
      }
    }
  }
  return dirs;
}

/**
 * Build a map of package name -> relative directory for all workspace packages.
 */
function buildWorkspaceMap(dirs) {
  const map = new Map();
  for (const dir of dirs) {
    const pkgPath = join(ROOT, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name) {
      map.set(pkg.name, dir);
    }
  }
  return map;
}

/**
 * Recursively collect all workspace dependencies (transitive closure).
 */
function resolveWorkspaceDeps(workspaceMap, startName) {
  const visited = new Set();
  const closure = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);

    const dir = workspaceMap.get(name);
    if (!dir) return;

    const pkgPath = join(ROOT, dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const depSections = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
    ];

    for (const section of depSections) {
      if (!section) continue;
      for (const [depName, specifier] of Object.entries(section)) {
        if (
          typeof specifier === "string" &&
          (specifier.includes("workspace") || specifier.startsWith("link:"))
        ) {
          closure.add(depName);
          visit(depName);
        }
      }
    }
  }

  visit(startName);
  return closure;
}

/**
 * Parse workspaceNames and workspacePaths from flake.nix.
 */
function parseFlakeNix() {
  const content = readFileSync(FLAKE_NIX, "utf8");

  function extractArray(label) {
    const regex = new RegExp(
      `${label}\\s*=\\s*\\[(.*?)\\]`,
      "s"
    );
    const match = content.match(regex);
    if (!match) {
      throw new Error(`Could not find ${label} in flake.nix`);
    }
    const items = [];
    // workspaceNames uses quoted strings, workspacePaths uses bare Nix paths
    const itemRegex = label === "workspacePaths" ? /\.\/[^\s\]]+/g : /"([^"]+)"/g;
    let m;
    if (label === "workspacePaths") {
      while ((m = itemRegex.exec(match[1])) !== null) {
        items.push(m[0]);
      }
    } else {
      while ((m = itemRegex.exec(match[1])) !== null) {
        items.push(m[1]);
      }
    }
    return items;
  }

  return {
    names: extractArray("workspaceNames"),
    paths: extractArray("workspacePaths"),
  };
}

function main() {
  const globs = getWorkspaceGlobs();
  const dirs = expandGlobsSafe(globs);
  const workspaceMap = buildWorkspaceMap(dirs);

  if (!workspaceMap.has(START_PKG)) {
    console.error(`Start package ${START_PKG} not found in workspace.`);
    process.exit(1);
  }

  const closure = resolveWorkspaceDeps(workspaceMap, START_PKG);
  /** @type {string[]} */
  const closureNames = [...closure].sort((a, b) => a.localeCompare(b));

  const flake = parseFlakeNix();
  const flakeNameSet = new Set(flake.names);
  const flakePathSet = new Set(flake.paths);

  const missingNames = closureNames.filter((n) => !flakeNameSet.has(n));
  /** @type {Array<{name: string, path: string}>} */
  const missingPaths = [];
  for (const name of closureNames) {
    const dir = workspaceMap.get(name);
    if (dir && !flakePathSet.has(`./${dir}`)) {
      missingPaths.push({ name, path: `./${dir}` });
    }
  }

  // Also check that the start package itself is in flake.nix
  if (!flakeNameSet.has(START_PKG)) {
    missingNames.unshift(START_PKG);
  }
  const startDir = workspaceMap.get(START_PKG);
  if (startDir && !flakePathSet.has(`./${startDir}`)) {
    missingPaths.unshift({ name: START_PKG, path: `./${startDir}` });
  }

  const ok = missingNames.length === 0 && missingPaths.length === 0;

  if (!ok) {
    console.error("❌ flake.nix workspace lists are out of sync.\n");

    if (missingNames.length > 0) {
      console.error(
        "The following workspace packages are missing from flake.nix workspaceNames:"
      );
      for (const n of missingNames) {
        console.error(`  - ${n}`);
      }
      console.error("");
    }

    if (missingPaths.length > 0) {
      console.error(
        "The following workspace paths are missing from flake.nix workspacePaths:"
      );
      for (const { name, path } of missingPaths) {
        console.error(`  - ${path}  (${name})`);
      }
      console.error("");
    }

    console.error(
      "Please add the missing entries to both workspaceNames and workspacePaths in flake.nix."
    );
    console.error(
      `\nExpected workspaceNames (${flake.names.length + missingNames.length} total):`
    );
    const expectedNames = new Set([...flake.names, ...missingNames.map((m) => m)]);
    for (const n of [...expectedNames].sort((a, b) => a.localeCompare(b))) {
      console.error(`  ${n}`);
    }

    process.exit(1);
  }

  console.log(
    `✅ All ${closureNames.length} recursive workspace dependencies are present in flake.nix.`
  );
}

main();
