import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(scriptDir, "..");

function findLatestVsix() {
  const candidates = readdirSync(extensionDir)
    .filter((name) => /^kimi-code-.*\.vsix$/u.test(name))
    .map((name) => {
      const path = join(extensionDir, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.path;
}

function listVsixEntries(vsixPath) {
  const output = execFileSync("unzip", ["-l", vsixPath], { encoding: "utf8" });
  const entries = [];

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+?)\s*$/u);
    if (match?.[1]) {
      entries.push(match[1]);
    }
  }

  return entries;
}

function validateEntries(entries) {
  const failures = [];
  const bannedDirectoryPrefixes = [
    "src/",
    "shared/",
    "agent-sdk/",
    "agent-display-model/",
    "webview-ui/",
    "node_modules/",
    "tests/",
    "docs/",
    "scripts/",
  ];
  const bannedFileNames = new Set([
    "tsconfig.json",
    "esbuild.js",
    "dev.js",
    "eslint.config.mjs",
    "vite.config.ts",
    "components.json",
  ]);

  for (const entry of entries) {
    if (bannedDirectoryPrefixes.some((prefix) => entry.startsWith(prefix))) {
      failures.push(`${entry} matches a banned source/build directory`);
      continue;
    }

    if (/\.map$/iu.test(entry)) {
      failures.push(`${entry} is a source map`);
      continue;
    }

    if (/\.vsix$/iu.test(entry)) {
      failures.push(`${entry} is a nested VSIX`);
      continue;
    }

    if (bannedFileNames.has(basename(entry))) {
      failures.push(`${entry} is a source/build config`);
    }
  }

  const packageRoot = entries.every(
    (entry) => entry === "[Content_Types].xml" || entry === "extension.vsixmanifest" || entry.startsWith("extension/"),
  )
    ? "extension/"
    : "";
  const requiredEntries = ["dist/extension.js", "dist/webview.js", "package.json"].map((entry) => `${packageRoot}${entry}`);
  for (const requiredEntry of requiredEntries) {
    if (!entries.includes(requiredEntry)) {
      failures.push(`missing required runtime entry ${requiredEntry}`);
    }
  }

  return failures;
}

const vsixPath = process.argv[2] ? resolve(process.argv[2]) : findLatestVsix();
if (!vsixPath) {
  console.error("No kimi-code-*.vsix file found. Run `pnpm -C apps/vscode run package` first.");
  process.exit(1);
}

const entries = listVsixEntries(vsixPath);
const failures = validateEntries(entries);
if (failures.length > 0) {
  console.error(`VSIX content check failed for ${vsixPath}`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`VSIX content check passed: ${vsixPath}`);
console.log(`Entries: ${entries.length}`);
console.log("Required runtime entries found: dist/extension.js, dist/webview.js, package.json");
