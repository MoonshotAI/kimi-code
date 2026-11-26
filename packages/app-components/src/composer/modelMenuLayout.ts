export const MODEL_MENU_WIDTH = 240;
export const MODEL_MENU_MAX_HEIGHT = 480;
export const MODEL_MENU_ROW_HEIGHT = 32;
export const SEARCH_MENU_MAX_ITEMS = 8;
export const VIEWPORT_EDGE_GAP = 8;
export const SUBMENU_GAP = 4;

export function clampModelMenuMaxHeight(availableAboveAnchor: number): number {
  return Math.max(
    MODEL_MENU_ROW_HEIGHT * 2,
    Math.min(MODEL_MENU_MAX_HEIGHT, Math.floor(availableAboveAnchor - VIEWPORT_EDGE_GAP * 2)),
  );
}

export interface AnchoredFlyoutInput {
  menuLeft: number;
  menuTop: number;
  menuWidth: number;
  triggerTop: number;
  triggerHeight: number;
  flyoutWidth: number;
  flyoutHeight: number;
  firstOptionOffset: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface AnchoredFlyoutPosition {
  side: 'right' | 'left';
  top: number;
}

export function computeAnchoredFlyoutPosition(input: AnchoredFlyoutInput): AnchoredFlyoutPosition {
  const {
    menuLeft,
    menuTop,
    menuWidth,
    triggerTop,
    triggerHeight,
    flyoutWidth,
    flyoutHeight,
    firstOptionOffset,
    viewportWidth,
    viewportHeight,
  } = input;
  const rightEdge = menuLeft + menuWidth + SUBMENU_GAP + flyoutWidth;
  const side: 'right' | 'left' =
    rightEdge <= viewportWidth - VIEWPORT_EDGE_GAP || menuLeft - SUBMENU_GAP - flyoutWidth < VIEWPORT_EDGE_GAP
      ? 'right'
      : 'left';

  const absoluteTriggerTop = menuTop + triggerTop;
  const maxTop = viewportHeight - VIEWPORT_EDGE_GAP - flyoutHeight;
  let top = absoluteTriggerTop - firstOptionOffset;
  if (top > maxTop) {
    const lowestCoveringTrigger = absoluteTriggerTop + triggerHeight - flyoutHeight;
    top = Math.max(maxTop, Math.min(absoluteTriggerTop, lowestCoveringTrigger));
  }
  top = Math.min(Math.max(VIEWPORT_EDGE_GAP, top), Math.max(VIEWPORT_EDGE_GAP, maxTop));
  return { side, top: top - menuTop };
}
