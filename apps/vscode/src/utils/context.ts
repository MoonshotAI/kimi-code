import * as vscode from "vscode";
import type { KimiConfig, KimiHarness } from "@moonshot-ai/kimi-code-sdk";

export async function updateLoginContext(harness: KimiHarness): Promise<boolean> {
  const status = await harness.auth.status();
  let loggedIn = status.providers.some((provider) => provider.hasToken);
  if (!loggedIn) {
    const config = await harness.getConfig();
    loggedIn = hasConfiguredProviderCredentials(config);
  }
  await vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", loggedIn);
  return loggedIn;
}

/**
 * A statically provisioned provider (e.g. an api_key in config.toml) is just
 * as usable as an OAuth session, so it counts as signed in. Mirrors the CLI,
 * which only asks for login when the active provider actually needs OAuth.
 */
export function hasConfiguredProviderCredentials(config: KimiConfig): boolean {
  return Object.values(config.providers ?? {}).some(
    (provider) => typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0,
  );
}
