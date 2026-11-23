import { nextTick } from 'vue';

export function focusClosedPanelToggle(): void {
  const toggle = document.querySelector<HTMLElement>('.right-panel-toggle');
  if (toggle && toggle.getClientRects().length > 0) { toggle.focus(); return; }
  const candidates = [
    ...document.querySelectorAll<HTMLElement>('.ch-panel, .session-admin .sa-back'),
  ];
  const visible = candidates.find((el) => el.getClientRects().length > 0);
  visible?.focus();
}

export function focusAfterTabClose(): void {
  void nextTick(() => {
    const next = document.querySelector<HTMLElement>('.ptb-tab.on .ptb-tab-main');
    if (next) {
      next.focus();
      return;
    }
    focusClosedPanelToggle();
  });
}
