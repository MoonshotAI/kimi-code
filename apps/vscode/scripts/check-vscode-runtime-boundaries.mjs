import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

const roots = [
  path.join(appRoot, "src"),
  path.join(appRoot, "shared"),
  path.join(appRoot, "webview-ui", "src"),
  path.join(appRoot, "agent-sdk"),
  path.join(appRoot, "agent-display-model", "src"),
];

const skipDirs = new Set(["node_modules", "dist", "coverage", ".turbo", ".vite"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const forbiddenPackages = [
  "@moonshot-ai/agent-core",
  "@moonshot-ai/kimi-code-sdk",
  "@moonshot-ai/kaos",
];

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        await walk(path.join(dir, entry.name), files);
      }
      continue;
    }

    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function isAllowedAcpProtocolImport(lines, index) {
  const line = lines[index];
  if (!line.includes("@moonshot-ai/acp-adapter/protocol")) {
    return true;
  }

  const window = lines.slice(Math.max(0, index - 10), index + 1).join("\n");
  return /\bimport\s+type\b/.test(window);
}

function checkFile(relativeFile, text) {
  const violations = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const pkg of forbiddenPackages) {
      if (line.includes(pkg)) {
        violations.push({ lineNumber, text: line.trim(), reason: `forbidden runtime package ${pkg}` });
      }
    }

    if (line.includes("@moonshot-ai/acp-adapter") && !isAllowedAcpProtocolImport(lines, index)) {
      violations.push({
        lineNumber,
        text: line.trim(),
        reason: "only `import type ... from '@moonshot-ai/acp-adapter/protocol'` is allowed in VS Code runtime code",
      });
    }
  }

  return violations;
}

async function main() {
  const files = (await Promise.all(roots.map((root) => walk(root)))).flat();
  const violations = [];

  for (const file of files) {
    const relativeFile = path.relative(appRoot, file).replaceAll(path.sep, "/");
    const text = await readFile(file, "utf8");
    violations.push(...checkFile(relativeFile, text).map((violation) => ({ file: relativeFile, ...violation })));
  }

  if (violations.length > 0) {
    console.error("VS Code runtime boundary check failed:\n");
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.lineNumber}: ${violation.reason}`);
      console.error(`  ${violation.text}`);
    }
    process.exit(1);
  }

  console.log("VS Code runtime boundary check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
