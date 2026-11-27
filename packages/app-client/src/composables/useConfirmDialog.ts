import { computed, ref, shallowRef } from 'vue';

export type ConfirmVariant = 'primary' | 'danger';

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  initialFocus?: 'confirm' | 'cancel';
  action?: () => unknown;
};

export type ConfirmCheckbox = {
  label: string;
  checked: boolean;
};

export type ConfirmCheckboxResult = {
  confirmed: boolean;
  checked: boolean;
};

type ConfirmRequest = ConfirmOptions & {
  seq: number;
  checkbox?: ConfirmCheckbox;
  resolve: (ok: boolean) => void;
  reject: (err: unknown) => void;
};

const current = ref<ConfirmRequest | null>(null);
const busy = ref(false);
const confirmSurfaces = shallowRef<(() => boolean)[]>([]);
const isConfirmOpen = computed(() => current.value !== null || confirmSurfaces.value.some((isOpen) => isOpen()));

export function registerConfirmSurface(isOpen: () => boolean): void {
  confirmSurfaces.value = [...confirmSurfaces.value, isOpen];
}

function settle(ok: boolean): void {
  const req = current.value;
  if (!req || busy.value) return;
  current.value = null;
  req.resolve(ok);
}

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

let confirmSeq = 0;

function open(options: ConfirmOptions, checkbox?: ConfirmCheckbox): Promise<boolean> {
  if (busy.value) return Promise.resolve(false);
  if (current.value) settle(false);
  return new Promise<boolean>((resolve, reject) => {
    confirmSeq += 1;
    current.value = { ...options, checkbox, seq: confirmSeq, resolve, reject };
  });
}

function confirm(options: ConfirmOptions): Promise<boolean> {
  return open(options);
}

async function confirmWithCheckbox(
  options: ConfirmOptions & { checkbox: ConfirmCheckbox },
): Promise<ConfirmCheckboxResult> {
  const checkbox = { ...options.checkbox };
  const confirmed = await open(options, checkbox);
  return { confirmed, checked: checkbox.checked };
}

function setCheckboxChecked(checked: boolean): void {
  const req = current.value;
  if (!req?.checkbox || busy.value) return;
  req.checkbox.checked = checked;
}

export function useConfirmDialog(): {
  current: typeof current;
  busy: typeof busy;
  isConfirmOpen: typeof isConfirmOpen;
  confirm: typeof confirm;
  confirmWithCheckbox: typeof confirmWithCheckbox;
  setCheckboxChecked: typeof setCheckboxChecked;
  settle: typeof settle;
  runAction: typeof runAction;
} {
  return { current, busy, isConfirmOpen, confirm, confirmWithCheckbox, setCheckboxChecked, settle, runAction };
}
