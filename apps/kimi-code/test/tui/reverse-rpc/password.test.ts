import type { PasswordRequest } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { adaptPasswordRequest } from '#/tui/reverse-rpc/password/adapter';
import { PasswordController } from '#/tui/reverse-rpc/password/controller';
import { createPasswordRequestHandler } from '#/tui/reverse-rpc/password/handler';

function passwordEvent(overrides: Partial<PasswordRequest> = {}): PasswordRequest {
  return {
    prompt: '[sudo] password for alice:',
    command: 'sudo ls /root',
    ...overrides,
  };
}

describe('password reverse-rpc adapter', () => {
  it('carries the prompt and command and assigns a unique id', () => {
    const first = adaptPasswordRequest(passwordEvent());
    const second = adaptPasswordRequest(passwordEvent());

    expect(first.prompt).toBe('[sudo] password for alice:');
    expect(first.command).toBe('sudo ls /root');
    expect(first.id).not.toBe(second.id);
  });

  it('omits the command when the engine did not supply one', () => {
    const data = adaptPasswordRequest(passwordEvent({ command: undefined }));
    expect(data.command).toBeUndefined();
  });
});

describe('password reverse-rpc controller', () => {
  it('queues concurrent requests and resolves them in order', async () => {
    const controller = new PasswordController();
    const shown: string[] = [];
    controller.setUIHooks({
      showPanel: (payload) => {
        shown.push(payload.id);
      },
      hidePanel: () => {},
    });

    const first = controller.show({ id: 'p-1', prompt: 'first' });
    const second = controller.show({ id: 'p-2', prompt: 'second' });

    controller.respond({ kind: 'submitted', password: 'one' });
    await expect(first).resolves.toEqual({ kind: 'submitted', password: 'one' });
    // The second request only surfaces after the first resolves.
    expect(shown).toEqual(['p-1', 'p-2']);
    expect(controller.hasPending()).toBe(true);

    controller.respond({ kind: 'cancelled' });
    await expect(second).resolves.toEqual({ kind: 'cancelled' });
  });

  it('cancels pending requests with a cancelled result', async () => {
    const controller = new PasswordController();
    const pending = controller.show({ id: 'p-1', prompt: 'first' });

    controller.cancelAll('closed');

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
  });
});

describe('password reverse-rpc handler', () => {
  it('adapts the request through the controller and returns its result', async () => {
    const controller = new PasswordController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({
      kind: 'submitted',
      password: 's3cret',
    });
    const handler = createPasswordRequestHandler(controller);

    await expect(handler(passwordEvent())).resolves.toEqual({
      kind: 'submitted',
      password: 's3cret',
    });
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '[sudo] password for alice:',
        command: 'sudo ls /root',
      }),
    );
  });

  it('falls back to cancelled when the controller throws', async () => {
    const controller = new PasswordController();
    vi.spyOn(controller, 'show').mockRejectedValue(new Error('boom'));
    const handler = createPasswordRequestHandler(controller);

    await expect(handler(passwordEvent())).resolves.toEqual({ kind: 'cancelled' });
  });
});
