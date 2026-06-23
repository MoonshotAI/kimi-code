import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';

// Verbatim from packages/kimi-core/src/harness/configs/toml.ts:42
export const DEFAULT_CONFIG_FILE_TEXT =
  '# ~/.kimi-code/config.toml\n' +
  '# Runtime settings for Kimi Code.\n' +
  '# This file starts empty so built-in defaults can apply.\n' +
  '# Login will populate managed Kimi provider and model entries.\n';

// Verbatim from apps/kimi-code/src/tui/config.ts:renderTuiConfig(DEFAULT_TUI_CONFIG)
export const DEFAULT_TUI_RENDER =
  '# ~/.kimi-code/tui.toml\n' +
  '# Client preferences for kimi-code.\n' +
  '# Agent/runtime settings stay in ~/.kimi-code/config.toml.\n' +
  '\n' +
  'theme = "auto" # "auto" | "dark" | "light" | custom theme name\n' +
  '\n' +
  '[editor]\n' +
  'command = "" # Empty uses $VISUAL / $EDITOR\n' +
  '\n' +
  '[notifications]\n' +
  'enabled = true # true | false\n' +
  'notification_condition = "unfocused" # "unfocused" | "always"\n' +
  '\n' +
  '[upgrade]\n' +
  'auto_install = true # true | false\n' +
  '\n' +
  '[terminal]\n' +
  'show_hardware_cursor = false # true | false\n';

export async function isConfigStubOrMissing(configPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch {
    return true; // missing = ok to overwrite
  }
  return text === DEFAULT_CONFIG_FILE_TEXT;
}

export async function isTuiStubOrMissing(tuiPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(tuiPath, 'utf-8');
  } catch {
    return true;
  }
  if (text === DEFAULT_TUI_RENDER) return true;

  // Fallback: parse and compare fields semantically
  try {
    const parsed = parseToml(text) as Record<string, unknown>;
    const theme = parsed['theme'];
    const editor = parsed['editor'] as Record<string, unknown> | undefined;
    const notifications = parsed['notifications'] as Record<string, unknown> | undefined;
    const upgrade = parsed['upgrade'] as Record<string, unknown> | undefined;
    const terminal = parsed['terminal'] as Record<string, unknown> | undefined;

    const themeOk = theme === undefined || theme === 'auto';
    const editorOk =
      editor === undefined || editor['command'] === undefined || editor['command'] === '';
    const notifEnabledOk =
      notifications === undefined ||
      notifications['enabled'] === undefined ||
      notifications['enabled'] === true;
    const notifCondOk =
      notifications === undefined ||
      notifications['notification_condition'] === undefined ||
      notifications['notification_condition'] === 'unfocused';
    const upgradeOk =
      upgrade === undefined ||
      upgrade['auto_install'] === undefined ||
      upgrade['auto_install'] === true;
    const terminalOk =
      terminal === undefined ||
      terminal['show_hardware_cursor'] === undefined ||
      terminal['show_hardware_cursor'] === false;

    return themeOk && editorOk && notifEnabledOk && notifCondOk && upgradeOk && terminalOk;
  } catch {
    return false; // unparseable = treat as user-modified, do not overwrite
  }
}
