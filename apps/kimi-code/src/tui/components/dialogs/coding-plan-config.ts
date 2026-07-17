import { Container, Key, matchesKey, type Focusable } from '@moonshot-ai/pi-tui';
import { currentTheme } from '#/tui/theme';

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
            this.errorMsg = `"${key}" 的值无效: ${raw}`;
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
    } else if (data.length > 0 && !matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
      // Accept any printable character input (including paste)
      const current = this.fields[field] ?? '';
      this.fields[field] = current + data;
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Coding Plan 配置'),
      '',
    ];
    for (let i = 0; i < this.fieldOrder.length; i++) {
      const key = this.fieldOrder[i]!;
      const label = FIELD_LABELS[key] ?? key;
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
    lines.push(currentTheme.fg('textMuted', ' ↑↓ 选择字段 · 输入修改 · Enter 保存 · Esc 取消'));
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => line.slice(0, width));
  }
}

const FIELD_LABELS: Record<string, string> = {
  protocol: '协议 (openai/anthropic/response)',
  stream: '流式 (true/false)',
  temperature: '温度 (0.0-2.0)',
  maxTokens: '最大Token数',
  enableThinking: '思考开关 (true/false)',
  searchDisable: '关闭搜索 (true/false)',
  showRefLabel: '显示信源 (true/false)',
  loraId: '微调模型ID',
  reasoningEffort: '思考强度 (off/low/medium/high/max)',
};

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