import { TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';
import type { Locator, Page } from '@playwright/test';

import type { Product, ToolExpectation, ToolName, ToolStatus } from '../support/verbs';

const REJECTION_NOTICE = 'was not run because the user rejected the approval request';
const TOOL_LABELS: Readonly<Record<ToolName, string>> = { Read: 'Read', Edit: 'Edit', Write: 'Write', Bash: 'Run' };
const INTERRUPT = /^(?:Interrupt|Press Esc again to interrupt)$/;
const SHOWN = ':not([inert], [inert] *)';
const LIST = '[role="list"]';
const ROW = '[role="listitem"]';
const STATE = '[role="status"]';
const DISCLOSURE = 'button[aria-expanded]';
const FOLDED = 'button[aria-expanded="false"]';
const MARKDOWN = 'p, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, table';
const BLOCK = `${ROW}${SHOWN}:not(:has(${LIST}))`;
const REPLY = `:not(:has(${DISCLOSURE})):not(:has(${STATE})):has(${MARKDOWN})`;
const ON_A_CARD = `${SHOWN}:not(:is(${MARKDOWN}), :is(${MARKDOWN}) *)`;
const DESCRIBED_LINES = 80;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containing(text: string): RegExp {
  return new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export class RendererSurface implements Product {
  private readonly page: Page;
  private readonly workspace: string;
  private turn: { readonly position: number; readonly text: string } | undefined;

  constructor(page: Page, workspace: string) {
    this.page = page;
    this.workspace = workspace;
  }

  async send(text: string): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(`send() needs an idle product, but a turn is running or an approval is pending.\n${await this.describe()}`);
    }
    const before = await this.conversationSize();
    await this.press('send()', 'the message input', this.composer());
    await this.page.keyboard.type(text);
    await this.page.keyboard.press('Enter');
    const position = await this.wait(`the user message ${JSON.stringify(text)} to appear in the conversation`, () => this.messageAfter(before, text));
    this.turn = { position, text };
  }

  approve(): Promise<void> {
    return this.answerApproval('approve()', this.approveButton());
  }

  reject(): Promise<void> {
    return this.answerApproval('reject()', this.rejectButton());
  }

  async stop(): Promise<void> {
    if (await this.approvalShown()) {
      throw new Error(`stop() cannot stop a turn while an approval is pending; answer it first.\n${await this.describe()}`);
    }
    if (await this.idle()) throw new Error(`stop() needs a running turn, but the product is idle.\n${await this.describe()}`);
    await this.press('stop()', 'Interrupt', this.interruptButton());
    await this.wait('the turn to stop', async () => ((await this.idle()) ? true : undefined));
    const replied = (await this.turnItems().count()) > 0;
    const stopped = await this.turnItems().locator(STATE).filter({ hasText: 'Manually stopped' }).count();
    if (replied && stopped === 0) {
      throw new Error(`stop() did not interrupt the turn: it ended on its own before the stop took effect.\n${await this.describe()}`);
    }
  }

  async waitIdle(): Promise<void> {
    if ((await this.settle('the turn to end', () => this.approvalShown())) === 'found') {
      throw new Error(`waitIdle() found a pending approval; answer it with approve() or reject() first.\n${await this.describe()}`);
    }
  }

  async expectTool(expectation: ToolExpectation): Promise<void> {
    const wanted = `${expectation.name} on ${JSON.stringify(expectation.target)} with status ${expectation.status}`;
    const stuck: string[] = [];
    const settled = await this.settle(`the tool ${wanted}`, async () => {
      stuck.push(...(await this.unfoldGroups()));
      return this.showsTool(expectation);
    });
    if (settled === 'over') {
      const folded = stuck.length === 0 ? '' : `A folded group of tools could not be opened: ${stuck.join('; ')}\n`;
      throw new Error(`expectTool() did not find ${wanted}. ${folded}The turn ended and it shows:\n${await this.describe()}`);
    }
  }

  async expectReply(text: string): Promise<void> {
    const settled = await this.settle(
      `the reply ${JSON.stringify(text)}`,
      async () => (await this.replies().filter({ hasText: containing(text) }).count()) > 0,
    );
    if (settled === 'over') {
      throw new Error(`expectReply() did not find ${JSON.stringify(text)} in an assistant reply. The turn ended and it shows:\n${await this.describe()}`);
    }
  }

  async idle(): Promise<boolean> {
    if (await this.approvalShown()) return false;
    if (await this.interruptButton().isVisible()) return false;
    return this.composer().isVisible();
  }

  async describe(): Promise<string> {
    if (this.page.isClosed()) return 'The page is closed.';
    try {
      const tree = await this.page.locator('body').ariaSnapshot();
      return `Page:\n${tree.split('\n').slice(-DESCRIBED_LINES).join('\n')}`;
    } catch (error) {
      return `The page could not be read: ${reasonOf(error)}`;
    }
  }

  private composer(): Locator {
    return this.page.getByRole('combobox', { name: 'Message input' });
  }

  private interruptButton(): Locator {
    return this.page.getByRole('button', { name: INTERRUPT });
  }

  private approveButton(): Locator {
    return this.page.getByRole('button', { name: 'Approve', exact: true });
  }

  private rejectButton(): Locator {
    return this.page.getByRole('button', { name: 'Reject', exact: true });
  }

  private conversation(): Locator {
    return this.page
      .locator(LIST)
      .filter({ has: this.page.getByRole('button', { name: 'Copy', exact: true }) })
      .first();
  }

  private async conversationSize(): Promise<number> {
    const rows = this.conversation().locator(`:scope > ${ROW}`);
    if ((await rows.count()) === 0) return 0;
    const size = Number(await rows.last().getAttribute('aria-setsize', { timeout: TIMEOUTS.wait }));
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`send() could not tell how many messages the conversation holds.\n${await this.describe()}`);
    }
    return size;
  }

  private userMessages(from: number, text: string): Locator {
    return this.conversation()
      .locator(`xpath=./*[@role="listitem" and number(@aria-posinset) >= ${from}]`)
      .filter({ hasNot: this.page.locator(LIST) })
      .filter({ has: this.page.getByText(text, { exact: true }) });
  }

  private async messageAfter(size: number, text: string): Promise<number | undefined> {
    const message = this.userMessages(size + 1, text).first();
    if ((await message.count()) === 0) return undefined;
    const position = Number(await message.getAttribute('aria-posinset', { timeout: TIMEOUTS.wait }));
    return Number.isInteger(position) ? position : undefined;
  }

  private turnItems(): Locator {
    if (this.turn === undefined) return this.page.locator(':not(*)');
    return this.userMessages(this.turn.position, this.turn.text).last().locator('xpath=following-sibling::*[@role="listitem"]');
  }

  private replies(): Locator {
    return this.turnItems().locator(`${BLOCK}${REPLY}`);
  }

  private toolCards({ name, target }: ToolExpectation): Locator {
    const onCard = this.page.locator(ON_A_CARD);
    const labelled = this.turnItems()
      .locator(`${BLOCK}:not(${REPLY})`)
      .filter({ has: this.page.getByText(TOOL_LABELS[name], { exact: true }).and(onCard) });
    if (name === 'Bash') return labelled.filter({ has: this.page.getByText(target, { exact: true }).and(onCard) });
    const file = this.page
      .getByRole('button', { name: target.slice(target.lastIndexOf('/') + 1), exact: true })
      .and(this.page.locator(`[data-file-path=${quoted(target)}], [data-file-path=${quoted(`${this.workspace}/${target}`)}]`))
      .and(onCard);
    return labelled.filter({ has: file });
  }

  private async toolStatus(card: Locator): Promise<ToolStatus | undefined> {
    if ((await card.locator(`${STATE}${SHOWN}`).count()) === 0) return 'done';
    if ((await card.locator(`${STATE}[aria-label="cancelled"]${SHOWN}`).count()) > 0) return 'failed';
    if ((await card.locator(`${STATE}[aria-label="error"]${SHOWN}`).count()) === 0) return undefined;
    return (await card.getByText(REJECTION_NOTICE).count()) > 0 ? 'rejected' : 'failed';
  }

  private async showsTool(expectation: ToolExpectation): Promise<boolean> {
    const cards = this.toolCards(expectation);
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      if ((await this.toolStatus(cards.nth(index))) === expectation.status) return true;
    }
    return false;
  }

  private async unfoldGroups(): Promise<string[]> {
    const folded = this.turnItems()
      .locator(`${FOLDED}${SHOWN}`)
      .filter({ has: this.page.locator(STATE) });
    const failures: string[] = [];
    for (const head of await folded.elementHandles()) {
      try {
        await head.click({ timeout: TIMEOUTS.wait });
      } catch (error) {
        failures.push(reasonOf(error));
      }
    }
    return failures;
  }

  private async approvalShown(): Promise<boolean> {
    return (await this.approveButton().isVisible()) && (await this.rejectButton().isVisible());
  }

  private async answerApproval(verb: string, button: Locator): Promise<void> {
    if ((await this.settle('an approval request', () => this.approvalShown())) === 'over') {
      throw new Error(`${verb} found no approval: the turn ended without asking for one.\n${await this.describe()}`);
    }
    const pressed = await button.elementHandle({ timeout: TIMEOUTS.wait });
    if (pressed === null) throw new Error(`${verb} lost the approval before it could answer it.\n${await this.describe()}`);
    await pressed.click({ timeout: TIMEOUTS.wait });
    await pressed.waitForElementState('hidden', { timeout: TIMEOUTS.server });
  }

  private async press(verb: string, name: string, control: Locator): Promise<void> {
    try {
      await control.click({ timeout: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`${verb} could not press ${name}: ${reasonOf(cause)}\n${await this.describe()}`, { cause });
    }
  }

  private settle(label: string, evidence: () => Promise<boolean>): Promise<'found' | 'over'> {
    let settled: string | undefined;
    return this.wait(label, async () => {
      if (await evidence()) return 'found';
      if (!(await this.idle())) {
        settled = undefined;
        return undefined;
      }
      const shown = (await this.turnItems().allTextContents()).join('\n');
      if (settled === shown) return 'over';
      settled = shown;
      return undefined;
    });
  }

  private async wait<T>(label: string, check: () => Promise<T | undefined>): Promise<T> {
    let outcome: { readonly value: T } | { readonly closed: true };
    try {
      outcome = await until(
        label,
        async () => {
          if (this.page.isClosed()) return { closed: true as const };
          const value = await check();
          return value === undefined ? undefined : { value };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      throw new Error(`${reasonOf(cause)}\n${await this.describe()}`, { cause });
    }
    if ('closed' in outcome) throw new Error(`The page closed while the test waited for ${label}.`);
    return outcome.value;
  }
}
