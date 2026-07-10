// apps/kimi-web/src/composables/useConfirmDialog.ts
// Promise-based modal confirmation. A module-level singleton holds the pending
// request; ConfirmDialogHost (mounted once in App.vue) renders it. Callers
// `await confirm(...)` from anywhere — components or composables — which is
// what lets it replace native `confirm()` inside composables too.
import { ref } from 'vue';

export type ConfirmVariant = 'primary' | 'danger';

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
};

type ConfirmRequest = ConfirmOptions & {
  resolve: (ok: boolean) => void;
};

const current = ref<ConfirmRequest | null>(null);

function settle(ok: boolean): void {
  const req = current.value;
  if (!req) return;
  current.value = null;
  req.resolve(ok);
}

function confirm(options: ConfirmOptions): Promise<boolean> {
  // If a confirm is already open, treat it as cancelled before showing the new
  // one so its caller isn't left hanging.
  if (current.value) settle(false);
  return new Promise<boolean>((resolve) => {
    current.value = { ...options, resolve };
  });
}

export function useConfirmDialog(): {
  current: typeof current;
  confirm: typeof confirm;
  settle: typeof settle;
} {
  return { current, confirm, settle };
}
