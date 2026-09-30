import * as vscode from "vscode";
import type { KimiAuthFacade } from "@moonshot-ai/kimi-code-sdk";

export async function updateLoginContext(auth: KimiAuthFacade): Promise<boolean> {
  const status = await auth.status();
  const loggedIn = status.providers.some((provider) => provider.hasToken);
  await vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", loggedIn);
  return loggedIn;
}
