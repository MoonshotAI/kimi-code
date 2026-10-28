import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from '../commands/dispatch';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import { occupiedHolderClientId } from '../utils/session-lock-errors';
import { CLI_MSH_PLATFORM } from '#/constant/app';

type SessionOccupancyHost = Pick<
  SlashCommandHost,
  'track' | 'showError' | 'mountEditorReplacement' | 'restoreEditor'
>;

interface SessionOccupancyPrompt {
  readonly session: Session;
  readonly error: unknown;
  /** The rejected request was already a Retry, so offer takeover instead. */
  readonly retried: boolean;
  readonly retry: () => void;
  readonly restore: () => void;
}

export function showSessionOccupancyPrompt(
  host: SessionOccupancyHost,
  prompt: SessionOccupancyPrompt,
): void {
  if (prompt.retried) {
    showSessionTakeover(host, prompt);
  } else {
    showSessionOccupied(host, prompt);
  }
}

function showSessionOccupied(
  host: SessionOccupancyHost,
  { error, retry, restore }: SessionOccupancyPrompt,
): void {
  const holderClient = occupiedHolderClientId(error);
  host.track('occupied_prompt_shown', {
    holder_client: holderClient,
    opener_client: CLI_MSH_PLATFORM,
  });
  const cancel = (): void => {
    host.track('occupied_choice', { choice: 'cancel', holder_client: holderClient });
    restore();
  };
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Session in use',
      notice: error instanceof Error ? error.message : String(error),
      noticeTone: 'warning',
      options: [
        { value: 'retry', label: 'Retry', description: 'send again now' },
        { value: 'cancel', label: 'Cancel', description: 'get your message back' },
      ],
      spaceSelect: false,
      onSelect: (action) => {
        if (action !== 'retry') {
          cancel();
          return;
        }
        host.track('occupied_choice', { choice: 'retry', holder_client: holderClient });
        host.restoreEditor();
        retry();
      },
      onCancel: cancel,
    }),
  );
}

function showSessionTakeover(
  host: SessionOccupancyHost,
  { session, error, retry, restore }: SessionOccupancyPrompt,
): void {
  const holderClient = occupiedHolderClientId(error);
  const cancel = (): void => {
    host.track('occupied_choice', { choice: 'cancel', holder_client: holderClient });
    restore();
  };
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Session still in use',
      notice: 'If another Kimi Code process is still running, taking over may mix up the history.',
      noticeTone: 'warning',
      options: [
        { value: 'cancel', label: 'Cancel', description: 'get your message back' },
        {
          value: 'takeover',
          label: 'Take over',
          tone: 'danger',
          description: 'send your message anyway',
        },
      ],
      spaceSelect: false,
      onSelect: (action) => {
        if (action !== 'takeover') {
          cancel();
          return;
        }
        host.track('occupied_choice', { choice: 'takeover', holder_client: holderClient });
        host.restoreEditor();
        void session.takeOverLock().then(retry, (takeoverError: unknown) => {
          host.showError(`Failed to take over the session: ${formatErrorMessage(takeoverError)}`);
          restore();
        });
      },
      onCancel: cancel,
    }),
  );
}
