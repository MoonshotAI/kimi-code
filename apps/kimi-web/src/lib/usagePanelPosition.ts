// apps/kimi-web/src/lib/usagePanelPosition.ts
// Pure viewport placement for the usage-limits popup.

export interface UsagePanelAnchorRect {
  top: number;
  right: number;
  bottom: number;
}

export interface UsagePanelViewport {
  width: number;
  height: number;
}

export interface UsagePanelPosition {
  right: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

const PANEL_GAP_PX = 8;
const VIEWPORT_GUTTER_PX = 8;

/** Place the panel on the side with more room and cap it to that available
 *  height, leaving a gutter between the panel and the viewport edge. */
export function calculateUsagePanelPosition(
  anchor: UsagePanelAnchorRect,
  viewport: UsagePanelViewport,
  panelWidth: number,
): UsagePanelPosition {
  const above = Math.max(
    0,
    Math.floor(anchor.top - PANEL_GAP_PX - VIEWPORT_GUTTER_PX),
  );
  const below = Math.max(
    0,
    Math.floor(viewport.height - anchor.bottom - PANEL_GAP_PX - VIEWPORT_GUTTER_PX),
  );
  const alignedRight = Math.round(viewport.width - anchor.right);
  const maxRight = Math.max(
    0,
    Math.floor(viewport.width - panelWidth - VIEWPORT_GUTTER_PX),
  );
  const right = Math.max(0, Math.min(alignedRight, maxRight));

  if (above >= below) {
    return {
      right,
      bottom: Math.max(0, Math.round(viewport.height - anchor.top + PANEL_GAP_PX)),
      maxHeight: above,
    };
  }

  return {
    right,
    top: Math.max(0, Math.round(anchor.bottom + PANEL_GAP_PX)),
    maxHeight: below,
  };
}
