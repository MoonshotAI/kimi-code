/**
 * Astron settings panel — toggle stream, temperature, max_tokens, search_disable.
 * Persisted to ~/.kimi-code/tui.toml [astron] section.
 */

import {
  Container,
  matchesKey,
  Key,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { t } from '#/i18n';
import {
  loadTuiConfig,
  saveTuiConfig as saveTuiConfigFile,
  type AstronSettings,
  ASTRON_DEFAULT_SETTINGS,
} from '#/tui/config';

interface SettingItem {
  key: keyof AstronSettings;
  labelKey: string;
  type: 'bool' | 'number';
}

const ITEMS: readonly SettingItem[] = [
  { key: 'stream', labelKey: 'tui.dialogs.astronSettings.stream', type: 'bool' },
  { key: 'temperature', labelKey: 'tui.dialogs.astronSettings.temperature', type: 'number' },
  { key: 'maxTokens', labelKey: 'tui.dialogs.astronSettings.maxTokens', type: 'number' },
  { key: 'searchDisable', labelKey: 'tui.dialogs.astronSettings.searchDisable', type: 'bool' },
];

export class AstronSettingsComponent extends Container implements Focusable {
  private settings: AstronSettings;
  private index = 0;
  private editing = false;
  private editBuffer = '';

  constructor() {
    super();
    this.settings = { ...ASTRON_DEFAULT_SETTINGS };
    this.load();
  }

  async focus(): Promise<void> {}

  unfocus(): void {}

  private async load(): Promise<void> {
    try {
      const config = await loadTuiConfig();
      this.settings = { ...config.astron };
    } catch {
      this.settings = { ...ASTRON_DEFAULT_SETTINGS };
    }
  }

  private async persist(): Promise<void> {
    try {
      const config = await loadTuiConfig();
      config.astron = { ...this.settings };
      await saveTuiConfigFile(config);
      this.emit({ type: 'saved' });
    } catch {
      // Silently fail — user can retry
    }
  }

  handleInput(key: Key): boolean {
    const item = ITEMS[this.index];
    if (item === undefined) return false;

    if (this.editing && item.type === 'number') {
      return this.handleNumberEdit(key, item);
    }
    return this.handleNavigate(key, item);
  }

  private handleNumberEdit(key: Key, item: SettingItem): boolean {
    if (matchesKey(key, Key.Enter) || matchesKey(key, Key.Escape)) {
      if (matchesKey(key, Key.Enter) && this.editBuffer.length > 0) {
        const val = Number(this.editBuffer);
        if (Number.isFinite(val)) {
          (this.settings as Record<string, unknown>)[item.key] = val;
        }
      }
      this.editing = false;
      this.editBuffer = '';
      this.needsRender = true;
      return true;
    }
    if (matchesKey(key, Key.Backspace)) {
      this.editBuffer = this.editBuffer.slice(0, -1);
      this.needsRender = true;
      return true;
    }
    const ch = typeof key === 'string' && key.length === 1 ? key : undefined;
    if (ch !== undefined && /[0-9.]/.test(ch)) {
      this.editBuffer += ch;
      this.needsRender = true;
      return true;
    }
    return false;
  }

  private handleNavigate(key: Key, item: SettingItem): boolean {
    if (matchesKey(key, Key.Up)) {
      this.index = (this.index - 1 + ITEMS.length) % ITEMS.length;
      this.needsRender = true;
      return true;
    }
    if (matchesKey(key, Key.Down)) {
      this.index = (this.index + 1) % ITEMS.length;
      this.needsRender = true;
      return true;
    }
    if (matchesKey(key, Key.Enter)) {
      if (item.type === 'bool') {
        (this.settings as Record<string, unknown>)[item.key] = !this.settings[item.key];
        this.needsRender = true;
      } else {
        this.editing = true;
        this.editBuffer = String(this.settings[item.key]);
        this.needsRender = true;
      }
      return true;
    }
    if (matchesKey(key, Key.Escape)) {
      this.emit({ type: 'cancel' });
      return true;
    }
    if (matchesKey(key, Key.Mod('s'))) {
      void this.persist();
      return true;
    }
    return false;
  }

  render(_x: number, _y: number, width: number, height: number): string[][] {
    const out: string[][] = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ' '),
    );

    const headerFg = currentTheme().getColor('primary' as ColorToken);
    const pointerFg = currentTheme().getColor('accent' as ColorToken);

    let row = 0;

    // Title
    write(out[row], 0, t('tui.dialogs.astronSettings.title'), headerFg);
    row++;
    write(out[row], 0, t('tui.dialogs.astronSettings.hint'));
    row++;
    row++; // blank line

    for (let i = 0; i < ITEMS.length && row < height; i++) {
      const item = ITEMS[i];
      const selected = i === this.index;
      const pointer = selected ? '► ' : '  ';
      const fg = selected ? pointerFg : undefined;

      let valueStr: string;
      if (item.type === 'bool') {
        valueStr = this.settings[item.key]
          ? `✓ ${t('tui.dialogs.astronSettings.on')}`
          : `✗ ${t('tui.dialogs.astronSettings.off')}`;
      } else if (this.editing && selected) {
        valueStr = this.editBuffer + '_';
      } else {
        valueStr = String(this.settings[item.key]);
      }

      const line = `${pointer}${t(item.labelKey)}: ${valueStr}`;
      write(out[row], 0, line, fg);
      row++;
    }

    return out;
  }
}

function write(row: string[], col: number, text: string, fg?: number): void {
  for (let i = 0; i < text.length && col + i < row.length; i++) {
    row[col + i] = fg !== undefined ? `\x1b[38;5;${fg}m${text[i]}\x1b[0m` : text[i];
  }
}