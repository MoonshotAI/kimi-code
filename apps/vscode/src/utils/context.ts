import * as vscode from "vscode";
import type { LocalKimiHarness } from "../sdk-local/harness";

export async function updateLoginContext(harness: LocalKimiHarness): Promise<boolean> {
  const status = await harness.auth.status();
  const loggedIn = status.providers.some((provider) => provider.hasToken);
  await vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", loggedIn);
  return loggedIn;
}
