// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import ConfirmDialogHost from '../src/dialogs/ConfirmDialogHost.vue';
import PastedTextDialog from '../src/dialogs/PastedTextDialog.vue';
import { closePastedTextDialog, openPastedTextDialog } from '../src/dialogs/pastedTextDialog';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => [h(PastedTextDialog), h(ConfirmDialogHost)] });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
});

afterEach(() => {
  closePastedTextDialog();
  app?.unmount();
  app = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === label);
}

function edit(value: string): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea.pasted-text-dialog__text')!;
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
  return textarea;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick();
}

describe('PastedTextDialog', () => {
  it('shows the full pasted text in a read-only text box and closes', async () => {
    expect(document.querySelector('textarea')).toBeNull();
    openPastedTextDialog('alpha\nbeta\ngamma');
    await nextTick();
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea.pasted-text-dialog__text');
    expect(textarea?.value).toBe('alpha\nbeta\ngamma');
    expect(textarea?.readOnly).toBe(true);
    expect(document.body.textContent).toContain('3 lines · 16 characters');
    const close = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Close');
    close!.click();
    await nextTick();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('saves edited text through the save callback', async () => {
    const save = vi.fn();
    openPastedTextDialog('alpha', save);
    await nextTick();
    expect(button('Save')).toBeUndefined();
    expect(edit('alpha beta').readOnly).toBe(false);
    await nextTick();
    expect(document.body.textContent).toContain('1 line · 10 characters');
    button('Save')!.click();
    await nextTick();
    expect(save).toHaveBeenCalledWith('alpha beta');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('asks before discarding unsaved edits', async () => {
    const save = vi.fn();
    openPastedTextDialog('alpha', save);
    await nextTick();
    edit('changed');
    await nextTick();
    document.querySelector<HTMLButtonElement>('.ui-dialog__close')!.click();
    await settle();
    expect(document.body.textContent).toContain('Discard changes?');
    button('Discard')!.click();
    await settle();
    expect(document.querySelector('textarea')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
