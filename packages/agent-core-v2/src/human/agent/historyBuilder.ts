import type { ContentPart, UserMessage } from '#/llm/message';

export type TextContentType = 'text/xml' | 'text/markdown' | 'text/plain';

export function systemReminderText(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

export class HistoryMessageBuilder {
  private readonly content: ContentPart[] = [];

  plain(text: string): this {
    return this.appendText(text, 'text/plain');
  }

  markdown(text: string): this {
    return this.appendText(text, 'text/markdown');
  }

  xml(text: string): this {
    return this.appendText(text, 'text/xml');
  }

  systemReminder(content: string): this {
    return this.xml(systemReminderText(content));
  }

  parts(): readonly ContentPart[] {
    return [...this.content];
  }

  userMessage(): UserMessage {
    return { role: 'user', content: [...this.content] };
  }

  private appendText(text: string, contentType: TextContentType): this {
    this.content.push({ type: 'text', text, contentType });
    return this;
  }
}

export function createHistoryMessageBuilder(): HistoryMessageBuilder {
  return new HistoryMessageBuilder();
}
