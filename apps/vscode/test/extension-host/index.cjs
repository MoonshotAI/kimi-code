const assert = require("node:assert/strict");
const { readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "moonshot-ai.kimi-code";
const EXPECTED_COMMANDS = [
  "kimi.clearAllState",
  "kimi.focusInput",
  "kimi.insertMention",
  "kimi.logout",
  "kimi.migrateLegacyData",
  "kimi.newConversation",
  "kimi.openInSideBar",
  "kimi.openInTab",
  "kimi.resetKimi",
  "kimi.showLogs",
];

exports.run = async function run() {
  const isolatedHome = process.env.KIMI_VSCODE_SMOKE_OS_HOME;
  assert.ok(isolatedHome, "isolated OS home must be provided");
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  const root = path.parse(isolatedHome).root;
  process.env.HOMEDRIVE = process.platform === "win32" ? root.replace(/[\\/]+$/, "") : root;
  process.env.HOMEPATH = process.platform === "win32"
    ? `${path.sep}${isolatedHome.slice(root.length)}`
    : isolatedHome;

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the isolated Extension Host`);
  const sourceManifest = JSON.parse(
    await readFile(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  );
  assert.equal(extension.packageJSON.version, sourceManifest.version);
  assert.equal(extension.packageJSON.main, "./dist/extension.js");
  assert.ok(process.env.KIMI_CODE_HOME, "KIMI_CODE_HOME must point at the isolated test home");
  assert.equal(process.env.HOME, isolatedHome);
  assert.equal(process.env.USERPROFILE, isolatedHome);
  assert.equal(os.homedir(), isolatedHome);

  await extension.activate();
  assert.equal(extension.isActive, true, "extension activation did not complete");

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of EXPECTED_COMMANDS) {
    assert.ok(commands.has(command), `missing registered command: ${command}`);
  }

  const config = vscode.workspace.getConfiguration("kimi");
  assert.equal(config.get("autosave"), true);
  assert.equal(config.get("executablePath"), undefined, "removed Python CLI setting is still contributed");
  assert.equal(config.get("environmentVariables"), undefined, "removed global CLI env setting is still contributed");

  await vscode.commands.executeCommand("kimi.openInTab");
  await waitFor(() => {
    return vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) =>
        tab.input instanceof vscode.TabInputWebview && isKimiPanelViewType(tab.input.viewType)));
  }, 5_000, () => `Kimi Webview tab did not open; tabs=${describeTabs()}`);

  await vscode.commands.executeCommand("kimi.showLogs");
  await vscode.commands.executeCommand("kimi.resetKimi");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  console.log(
    JSON.stringify({
      extension: EXTENSION_ID,
      version: extension.packageJSON.version,
      vscode: vscode.version,
      remoteName: vscode.env.remoteName ?? null,
      commands: EXPECTED_COMMANDS.length,
      webview: "opened",
    }),
  );
  assert.ok(process.env.KIMI_VSCODE_SMOKE_REPORT, "Extension Host report path must be provided");
  await writeFile(
    process.env.KIMI_VSCODE_SMOKE_REPORT,
    JSON.stringify({ vscode: vscode.version }),
    "utf8",
  );
};

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

function describeTabs() {
  return JSON.stringify(vscode.window.tabGroups.all.map((group) =>
    group.tabs.map((tab) => ({
      label: tab.label,
      input: tab.input?.constructor?.name,
      viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined,
      active: tab.isActive,
    }))));
}

function isKimiPanelViewType(viewType) {
  // VS Code 1.100 exposes the internal `mainThreadWebview-` prefix here;
  // newer hosts expose the extension's original view type.
  return viewType === "kimiPanel" || viewType.endsWith("-kimiPanel");
}
