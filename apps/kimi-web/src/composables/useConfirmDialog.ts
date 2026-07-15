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
  /** Async work started when the user confirms. While it runs, the dialog
   *  stays open with the confirm button in a loading state (cancel / Esc /
   *  overlay-click are suppressed), then closes and resolves true. A
   *  rejection closes the dialog and rethrows to the confirm() caller. */
  action?: () => unknown;
};

type ConfirmRequest = ConfirmOptions & {
  resolve: (ok: boolean) => void;
  reject: (err: unknown) => void;
};

const current = ref<ConfirmRequest | null>(null);
/** True while a confirmed request's `action` is still running. */
const busy = ref(false);

function settle(ok: boolean): void {
  const req = current.value;
  if (!req || busy.value) return;
  current.value = null;
  req.resolve(ok);
}

/** Invoked by the host when the user confirms. Runs the request's `action`
 *  (keeping the dialog open with a loading state until it settles), or just
 *  resolves true when the request has none. Never rejects. */
async function runAction(): Promise<void> {
  const req = current.value;
  if (!req || busy.value) return;
  if (!req.action) {
    settle(true);
    return;
  }
  busy.value = true;
  try {
    await req.action();
    if (current.value === req) current.value = null;
    req.resolve(true);
  } catch (error) {
    if (current.value === req) current.value = null;
    req.reject(error);
  } finally {
    busy.value = false;
  }
}

function confirm(options: ConfirmOptions): Promise<boolean> {
  // A confirmed action is still in flight: a second dialog can't supersede the
  // busy one (it would inherit the global busy state and open inert), so the
  // new request resolves unconfirmed instead.
  if (busy.value) return Promise.resolve(false);
  // If a confirm is already open, treat it as cancelled before showing the new
  // one so its caller isn't left hanging.
  if (current.value) settle(false);
  return new Promise<boolean>((resolve, reject) => {
    current.value = { ...options, resolve, reject };
  });
}

export function useConfirmDialog(): {
  current: typeof current;
  busy: typeof busy;
  confirm: typeof confirm;
  settle: typeof settle;
  runAction: typeof runAction;
} {
  return { current, busy, confirm, settle, runAction };
}
