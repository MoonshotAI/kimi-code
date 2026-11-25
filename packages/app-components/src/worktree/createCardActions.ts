import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { openWorktreeSettings } from '@moonshot-ai/app-client/composables';
import {
  createDecisionCardView,
  createInvalidCardView,
  type CreateCardActionId,
  type CreateCardView,
} from './createPresentation';

export interface CreateCardActions {
  card: ComputedRef<CreateCardView | null>;
  busyAction: Ref<CreateCardActionId | null>;
  run: (id: CreateCardActionId) => Promise<void>;
}

export function useCreateCardActions(): CreateCardActions {
  const client = useKimiWebClient();
  const { t } = useI18n();
  const busyAction = ref<CreateCardActionId | null>(null);

  const card = computed<CreateCardView | null>(
    () =>
      createInvalidCardView(client.activeSessionWorktree.value, t) ??
      createDecisionCardView(client.activeSessionWorktree.value, t),
  );

  function dispatch(sessionId: string, id: CreateCardActionId): Promise<boolean> {
    switch (id) {
      case 'retry':
        return client.retrySessionWorktree(sessionId);
      case 'createFromLocal':
        return client.retrySessionWorktree(sessionId, { useRemote: false });
      case 'createFromRemote':
        return client.retrySessionWorktree(sessionId, { useRemote: true, includeLocalChanges: false });
      case 'useLocal':
        return client.useLocalForSessionWorktree(sessionId);
      case 'recreate':
        return client.recreateSessionWorktree(sessionId);
      case 'stop':
        return client.cancelSessionWorktree(sessionId);
      case 'manage':
      case 'viewOutput':
        return Promise.resolve(false);
      default:
        return Promise.resolve(false);
    }
  }

  async function run(id: CreateCardActionId): Promise<void> {
    if (id === 'manage') {
      openWorktreeSettings();
      return;
    }
    const sessionId = client.activeSessionId.value;
    if (sessionId === undefined || sessionId === null || busyAction.value !== null) return;
    busyAction.value = id;
    try {
      await dispatch(sessionId, id);
    } finally {
      busyAction.value = null;
    }
  }

  return { card, busyAction, run };
}
