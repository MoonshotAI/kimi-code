/**
 * OpenAIProviderImportDialog — native `/provider` form for adding or editing
 * an OpenAI-compatible provider. It collects provider id, base URL, and API key,
 * then the command handler fetches `${baseUrl}/models` and writes model aliases.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface OpenAIProviderImportValue {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export type OpenAIProviderImportResult =
  | { readonly kind: 'ok'; readonly value: OpenAIProviderImportValue }
  | { readonly kind: 'cancel' };

const TITLE_ADD = 'Add OpenAI-compatible provider';
const TITLE_EDIT = 'Edit OpenAI-compatible provider';
const SUBTITLE_DEFAULT = 'Enter provider details. Models will be fetched automatically.';
const SUBTITLE_PROVIDER_EMPTY = 'Provider ID cannot be empty.';
const SUBTITLE_PROVIDER_INVALID = 'Provider ID may only contain letters, numbers, dot, underscore, colon, or dash.';
const SUBTITLE_BASE_URL_EMPTY = 'Base URL cannot be empty.';
const SUBTITLE_API_KEY_EMPTY = 'API key cannot be empty.';
const FOOTER_NOT_LAST = 'Tab / Up Down to switch  ·  Enter for next field  ·  Esc to cancel';
const FOOTER_LAST = 'Tab / Up Down to switch  ·  Enter to submit  ·  Esc to cancel';

const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]+$/;

type FieldId = 'providerId' | 'baseUrl' | 'apiKey';
type Hint = 'none' | 'provider-empty' | 'provider-invalid' | 'base-url-empty' | 'api-key-empty';

function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replaceAll(/[^ ]/g, '*');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export class OpenAIProviderImportDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly providerIdInput = new Input();
  private readonly baseUrlInput = new Input();
  private readonly apiKeyInput = new Input();
  private readonly onDone: (result: OpenAIProviderImportResult) => void;
  private activeField: FieldId = 'providerId';
  private done = false;
  private hint: Hint = 'none';

  constructor(
    onDone: (result: OpenAIProviderImportResult) => void,
    defaults: Partial<OpenAIProviderImportValue> = {},
  ) {
    super();
    this.onDone = onDone;
    if (defaults.providerId !== undefined) this.providerIdInput.setValue(defaults.providerId);
    if (defaults.baseUrl !== undefined) this.baseUrlInput.setValue(defaults.baseUrl);
    if (defaults.apiKey !== undefined) this.apiKeyInput.setValue(defaults.apiKey);

    this.providerIdInput.onSubmit = () => {
      this.focusField('baseUrl');
    };
    this.baseUrlInput.onSubmit = () => {
      this.focusField('apiKey');
    };
    this.apiKeyInput.onSubmit = () => {
      this.handleSubmit();
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.toggleField(matchesKey(data, Key.shift('tab')) ? -1 : 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.toggleField(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.toggleField(-1);
      return;
    }

    if (this.hint !== 'none') this.hint = 'none';

    if (this.activeField === 'providerId') {
      this.providerIdInput.handleInput(data);
    } else if (this.activeField === 'baseUrl') {
      this.baseUrlInput.handleInput(data);
    } else {
      this.apiKeyInput.handleInput(data);
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.providerIdInput.invalidate();
    this.baseUrlInput.invalidate();
    this.apiKeyInput.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && !this.done;
    this.providerIdInput.focused = dialogActive && this.activeField === 'providerId';
    this.baseUrlInput.focused = dialogActive && this.activeField === 'baseUrl';
    this.apiKeyInput.focused = dialogActive && this.activeField === 'apiKey';

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg(
      'textStrong',
      this.providerIdInput.getValue().trim().length > 0 ? TITLE_EDIT : TITLE_ADD,
    );
    const subtitleStyled = currentTheme.fg('textDim', this.subtitleText());
    const footerStyled = currentTheme.fg(
      'textDim',
      this.activeField === 'apiKey' ? FOOTER_LAST : FOOTER_NOT_LAST,
    );

    const providerLabelLine = this.labelLine('Provider ID', 'providerId', innerWidth);
    const baseUrlLabelLine = this.labelLine('Base URL', 'baseUrl', innerWidth);
    const apiKeyLabelLine = this.labelLine('API Key', 'apiKey', innerWidth);
    const providerInputLine = this.providerIdInput.render(innerWidth)[0] ?? '> ';
    const baseUrlInputLine = this.baseUrlInput.render(innerWidth)[0] ?? '> ';
    const rawApiKeyInputLine = this.apiKeyInput.render(innerWidth)[0] ?? '> ';
    const apiKeyInputLine = maskInputLine(rawApiKeyInputLine);

    const contentLines: string[] = [
      truncateToWidth(titleStyled, innerWidth, '...'),
      '',
      truncateToWidth(subtitleStyled, innerWidth, '...'),
      '',
      providerLabelLine,
      providerInputLine,
      '',
      baseUrlLabelLine,
      baseUrlInputLine,
      '',
      apiKeyLabelLine,
      apiKeyInputLine,
      '',
      truncateToWidth(footerStyled, innerWidth, '...'),
    ];

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '...'))];
    }

    const lines: string[] = [
      '',
      border('+' + '-'.repeat(safeWidth - 2) + '+'),
      border('|') + ' '.repeat(safeWidth - 2) + border('|'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('|') + pad + content + ' '.repeat(rightPad) + border('|'));
    }

    lines.push(border('|') + ' '.repeat(safeWidth - 2) + border('|'));
    lines.push(border('+' + '-'.repeat(safeWidth - 2) + '+'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '...'));
  }

  private labelLine(label: string, field: FieldId, width: number): string {
    const styled =
      this.activeField === field
        ? currentTheme.boldFg('accent', label)
        : currentTheme.fg('textDim', label);
    return truncateToWidth(styled, width, '...');
  }

  private subtitleText(): string {
    switch (this.hint) {
      case 'provider-empty':
        return SUBTITLE_PROVIDER_EMPTY;
      case 'provider-invalid':
        return SUBTITLE_PROVIDER_INVALID;
      case 'base-url-empty':
        return SUBTITLE_BASE_URL_EMPTY;
      case 'api-key-empty':
        return SUBTITLE_API_KEY_EMPTY;
      case 'none':
        return SUBTITLE_DEFAULT;
    }
  }

  private toggleField(delta: 1 | -1): void {
    const fields: readonly FieldId[] = ['providerId', 'baseUrl', 'apiKey'];
    const current = fields.indexOf(this.activeField);
    const next = (current + delta + fields.length) % fields.length;
    this.focusField(fields[next]!);
  }

  private focusField(field: FieldId): void {
    this.hint = 'none';
    this.activeField = field;
  }

  private handleSubmit(): void {
    if (this.done) return;

    const providerId = this.providerIdInput.getValue().trim();
    const baseUrl = this.baseUrlInput.getValue().trim();
    const apiKey = this.apiKeyInput.getValue().trim().replace(/^Bearer\s+/i, '');

    if (providerId.length === 0) {
      this.hint = 'provider-empty';
      this.activeField = 'providerId';
      return;
    }
    if (!PROVIDER_ID_RE.test(providerId)) {
      this.hint = 'provider-invalid';
      this.activeField = 'providerId';
      return;
    }
    if (baseUrl.length === 0) {
      this.hint = 'base-url-empty';
      this.activeField = 'baseUrl';
      return;
    }
    if (apiKey.length === 0) {
      this.hint = 'api-key-empty';
      this.activeField = 'apiKey';
      return;
    }

    this.done = true;
    this.onDone({ kind: 'ok', value: { providerId, baseUrl, apiKey } });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
