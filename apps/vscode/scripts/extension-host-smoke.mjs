#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests, runVSCodeCommand } from "@vscode/test-electron";

import { isMainModule } from "./vsix-targets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const defaultCachePath = join(tmpdir(), "kimi-vscode-test-cache");

export async function runExtensionHostSmoke(options = {}) {
  const version = options.version ?? "stable";
  const cacheRoot = resolve(options.cachePath ?? process.env.VSCODE_TEST_CACHE ?? defaultCachePath);
  const vsixPath = resolve(options.vsixPath ?? defaultVsixPath());
  await access(vsixPath);
  await mkdir(cacheRoot, { recursive: true });

  // A stable request must never reuse an older stable download. @vscode/test-electron
  // falls back to a cached build when version discovery fails, which would turn an
  // offline run into a false green. Exact versions remain cached by version.
  const disposableCache = version === "stable";
  const cachePath = disposableCache
    ? await mkdtemp(join(cacheRoot, "stable-"))
    : cacheRoot;

  const root = await mkdtemp(join(tmpdir(), "kvh-"));
  const paths = {
    root,
    extensions: join(root, "ext"),
    installUserData: join(root, "install"),
    userData: join(root, "user"),
    kimiHome: join(root, "home"),
    osHome: join(root, "os-home"),
    workspace: join(root, "ws"),
    harness: join(root, "harness"),
    report: join(root, "extension-host-report.json"),
  };

  try {
    await Promise.all([
      paths.extensions,
      paths.installUserData,
      paths.userData,
      paths.kimiHome,
      paths.osHome,
      paths.workspace,
      paths.harness,
    ].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(paths.workspace, "README.md"), "# Kimi VSIX Extension Host smoke\n", "utf8");
    await writeHarnessManifest(paths.harness);

    const installProfileArgs = [
      `--extensions-dir=${paths.extensions}`,
      `--user-data-dir=${paths.installUserData}`,
    ];
    const profileArgs = [
      `--extensions-dir=${paths.extensions}`,
      `--user-data-dir=${paths.userData}`,
    ];
    const downloadOptions = { version, cachePath };
    const install = await runVSCodeCommand(
      ["--install-extension", vsixPath, "--force", ...installProfileArgs],
      downloadOptions,
    );
    const installOutput = `${install.stdout}\n${install.stderr}`;
    if (!/successfully installed|was successfully installed/i.test(installOutput)) {
      throw new Error(`VSIX installation did not report success:\n${installOutput.trim()}`);
    }

    await runTests({
      ...downloadOptions,
      extensionDevelopmentPath: paths.harness,
      extensionTestsPath: join(appDir, "test", "extension-host", "index.cjs"),
      launchArgs: [
        paths.workspace,
        ...profileArgs,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
      extensionTestsEnv: {
        KIMI_CODE_HOME: paths.kimiHome,
        KIMI_VSCODE_SMOKE_OS_HOME: paths.osHome,
        KIMI_VSCODE_SMOKE_REPORT: paths.report,
        KIMI_VSCODE_SMOKE_VSIX: basename(vsixPath),
      },
    });

    const report = JSON.parse(await readFile(paths.report, "utf8"));
    if (typeof report.vscode !== "string" || report.vscode.length === 0) {
      throw new Error("Extension Host smoke did not report its actual VS Code version");
    }
    if (version !== "stable" && report.vscode !== version) {
      throw new Error(
        `Extension Host ran VS Code ${report.vscode}, expected requested version ${version}`,
      );
    }

    return { version, vscodeVersion: report.vscode, vsixPath, cachePath };
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      disposableCache ? rm(cachePath, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}

function defaultVsixPath() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return join(appDir, "artifacts", "vsix", `kimi-code-${process.platform}-${arch}.vsix`);
}

async function writeHarnessManifest(directory) {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "kimi-vscode-extension-host-smoke",
      displayName: "Kimi VSCode Extension Host Smoke",
      publisher: "local-test",
      version: "0.0.0",
      engines: { vscode: "^1.70.0" },
      main: "./extension.cjs",
      activationEvents: ["*"],
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "extension.cjs"),
    "exports.activate = function activate() {}; exports.deactivate = function deactivate() {};\n",
    "utf8",
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--version") {
      options.version = requiredValue(argv[++index], argument);
    } else if (argument === "--vsix") {
      options.vsixPath = requiredValue(argv[++index], argument);
    } else if (argument === "--cache-path") {
      options.cachePath = requiredValue(argv[++index], argument);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function requiredValue(value, flag) {
  if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/extension-host-smoke.mjs [--version <stable|x.y.z>] [--vsix <path>] [--cache-path <path>]");
    return;
  }
  const result = await runExtensionHostSmoke(options);
  console.log(
    `VSIX Extension Host smoke passed: ${result.vsixPath} on VS Code ${result.vscodeVersion} (requested ${result.version})`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`VSIX Extension Host smoke failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
