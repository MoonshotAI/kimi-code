import { Container, Key, matchesKey, type Focusable } from '@moonshot-ai/pi-tui';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { t } from '#/i18n';

export interface CodingPlanConfigOptions {
  readonly currentConfig: Record<string, unknown>;
  readonly onSave: (config: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}

export class CodingPlanConfigComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CodingPlanConfigOptions;
  private readonly fields: Record<string, string> = {};
  private selectedField = 0;
  private readonly fieldOrder: string[];
  private errorMsg = '';

  constructor(opts: CodingPlanConfigOptions) {
    super();
    this.opts = opts;
    this.fieldOrder = [
      'protocol', 'stream', 'temperature', 'maxTokens',
      'enableThinking', 'searchDisable', 'showRefLabel',
      'loraId', 'reasoningEffort',
    ];
    for (const key of this.fieldOrder) {
      const value = opts.currentConfig[key];
      this.fields[key] = value !== undefined ? String(value) : '';
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.errorMsg = '';
      const config: Record<string, unknown> = {};
      for (const key of this.fieldOrder) {
        const raw = this.fields[key];
        if (raw === undefined || raw.length === 0) continue;
        const schema = FIELD_SCHEMAS[key];
        if (schema !== undefined) {
          const parsed = schema.parse(raw);
          if (schema.validate !== undefined && !schema.validate(parsed)) {
            this.errorMsg = t('tui.codingPlan.invalidValue', { key, raw });
            return;
          }
          config[key] = parsed;
        } else {
          config[key] = raw;
        }
      }
      this.opts.onSave(config);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedField = Math.max(0, this.selectedField - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedField = Math.min(this.fieldOrder.length - 1, this.selectedField + 1);
      return;
    }
    // Type into the selected field
    if (this.selectedField >= this.fieldOrder.length) return;
    const field = this.fieldOrder[this.selectedField];
    if (field === undefined) return;
    if (matchesKey(data, Key.backspace)) {
      const current = this.fields[field];
      this.fields[field] = current !== undefined ? current.slice(0, -1) : '';
    } else {
      // Accept printable input only (including paste): arrow keys, Tab and
      // Ctrl combos must not leak escape bytes into the field value.
      const ch = printableChar(data);
      if (ch.length > 0) {
        const current = this.fields[field] ?? '';
        this.fields[field] = current + ch;
      }
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', t('tui.codingPlan.title')),
      '',
    ];
    for (let i = 0; i < this.fieldOrder.length; i++) {
      const key = this.fieldOrder[i]!;
      const label = fieldLabel(key);
      const value = this.fields[key];
      const isSelected = i === this.selectedField;
      const pointer = isSelected ? '>' : ' ';
      const field = isSelected
        ? currentTheme.boldFg('primary', `${label}: ${value}█`)
        : ` ${label}: ${value}`;
      lines.push(` ${pointer} ${field}`);
    }
    lines.push('');
    if (this.errorMsg.length > 0) {
      lines.push(currentTheme.fg('error', ` ${this.errorMsg}`));
    }
    lines.push(currentTheme.fg('textMuted', t('tui.codingPlan.navHint')));
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => line.slice(0, width));
  }
}

function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    protocol: t('tui.codingPlan.fieldProtocol'),
    stream: t('tui.codingPlan.fieldStream'),
    temperature: t('tui.codingPlan.fieldTemperature'),
    maxTokens: t('tui.codingPlan.fieldMaxTokens'),
    enableThinking: t('tui.codingPlan.fieldEnableThinking'),
    searchDisable: t('tui.codingPlan.fieldSearchDisable'),
    showRefLabel: t('tui.codingPlan.fieldShowRefLabel'),
    loraId: t('tui.codingPlan.fieldLoraId'),
    reasoningEffort: t('tui.codingPlan.fieldReasoningEffort'),
  };
  return labels[key] ?? key;
}

interface FieldSchema {
  parse: (raw: string) => unknown;
  validate?: (value: unknown) => boolean;
}

const FIELD_SCHEMAS: Record<string, FieldSchema> = {
  protocol: { parse: (raw) => raw },
  stream: { parse: (raw) => raw === 'true' },
  temperature: {
    parse: (raw) => Number(raw),
    validate: (v) => typeof v === 'number' && !Number.isNaN(v) && (v as number) >= 0 && (v as number) <= 2,
  },
  maxTokens: {
    parse: (raw) => Number(raw),
    validate: (v) => typeof v === 'number' && !Number.isNaN(v) && Number.isInteger(v) && (v as number) >= 1,
  },
  enableThinking: { parse: (raw) => raw === 'true' },
  searchDisable: { parse: (raw) => raw === 'true' },
  showRefLabel: { parse: (raw) => raw === 'true' },
  loraId: { parse: (raw) => raw },
  reasoningEffort: { parse: (raw) => raw },
};