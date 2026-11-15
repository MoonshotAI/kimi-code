export interface Expandable {
  setExpanded(expanded: boolean): void;
}

/**
 * An expandable component that can say whether ctrl+o would change what it
 * shows — content it keeps out of its collapsed form.
 */
export interface HidesContent extends Expandable {
  hasHiddenContent(): boolean;
  isExpanded(): boolean;
}

export interface OmitsExpandHint {
  omitsExpandHint(): boolean;
}

export interface HasRowDetail {
  renderRowDetail(width: number): string[];
}

export interface HasStatusMarker {
  statusMarker(): string;
}

export interface Disposable {
  dispose(): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'setExpanded' in obj &&
    typeof (obj as Expandable).setExpanded === 'function'
  );
}

export function hasHiddenContent(obj: unknown): boolean {
  return (
    isExpandable(obj) &&
    'hasHiddenContent' in obj &&
    typeof (obj as HidesContent).hasHiddenContent === 'function' &&
    (obj as HidesContent).hasHiddenContent()
  );
}

export function countedByExpandHint(obj: unknown): boolean {
  if (omitsExpandHint(obj)) return false;
  return hasHiddenContent(obj);
}

function omitsExpandHint(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'omitsExpandHint' in obj &&
    typeof (obj as OmitsExpandHint).omitsExpandHint === 'function' &&
    (obj as OmitsExpandHint).omitsExpandHint()
  );
}

/** Whether an expandable component currently shows its expanded form. */
export function isExpandedComponent(obj: unknown): boolean {
  return (
    isExpandable(obj) &&
    'isExpanded' in obj &&
    typeof (obj as HidesContent).isExpanded === 'function' &&
    (obj as HidesContent).isExpanded()
  );
}

export function hasRowDetail(obj: unknown): obj is HasRowDetail {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'renderRowDetail' in obj &&
    typeof (obj as HasRowDetail).renderRowDetail === 'function'
  );
}

export function hasStatusMarker(obj: unknown): obj is HasStatusMarker {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'statusMarker' in obj &&
    typeof obj.statusMarker === 'function'
  );
}

export function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}
