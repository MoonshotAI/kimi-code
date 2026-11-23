import { iconSvg } from '../shared/icons';

export type WorkModeKind = 'plan' | 'goal';

export interface WorkModePillSpec {
  mode: WorkModeKind;
  label: string;
  dismissLabel: string;
}

export type WorkModePillLane = 'inline' | 'block';

export interface WorkModePillRect {
  left: number;
  top: number;
}

export interface WorkModePillBox extends WorkModePillRect {
  right: number;
  bottom: number;
}

export interface WorkModePillLayout {
  left: number;
  top: number;
  inlineReserve: number;
  blockReserve: number;
  box: WorkModePillBox;
}

export interface WorkModePillMetrics {
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  lane: WorkModePillLane;
}

export function workModePillLayout(
  paragraph: WorkModePillRect,
  host: WorkModePillRect,
  scroll: { left: number; top: number },
  metrics: WorkModePillMetrics,
): WorkModePillLayout {
  const boxLeft = paragraph.left + metrics.marginLeft;
  const boxTop = paragraph.top + metrics.marginTop;
  return {
    left: paragraph.left - host.left + scroll.left,
    top: paragraph.top - host.top + scroll.top,
    inlineReserve:
      metrics.lane === 'inline'
        ? Math.max(0, metrics.marginLeft + metrics.width + metrics.marginRight)
        : 0,
    blockReserve:
      metrics.lane === 'block'
        ? Math.max(0, metrics.marginTop + metrics.height + metrics.marginBottom)
        : 0,
    box: {
      left: boxLeft,
      right: boxLeft + metrics.width,
      top: boxTop,
      bottom: boxTop + metrics.height,
    },
  };
}

export function buildWorkModePill(spec: WorkModePillSpec, onDismiss: () => void): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'wm-pill';
  pill.dataset.workMode = spec.mode;
  const icon = document.createElement('span');
  icon.className = 'wm-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconSvg(spec.mode === 'goal' ? 'target' : 'file-edit', 'sm');
  const label = document.createElement('span');
  label.textContent = spec.label;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'wm-x';
  dismiss.setAttribute('aria-label', spec.dismissLabel);
  dismiss.title = spec.dismissLabel;
  dismiss.innerHTML = iconSvg('close', 'sm');
  pill.addEventListener('mousedown', (event) => event.preventDefault());
  dismiss.addEventListener('click', () => onDismiss());
  pill.append(icon, label, dismiss);
  return pill;
}
