export interface Expandable {
  setExpanded(expanded: boolean): void;
}

/**
 * An expandable component that can say whether ctrl+o would change what it
 * shows — content it keeps out of its collapsed form. Drives the footer's
 * `ctrl+o expand` / `ctrl+o collapse` hint.
 */
export interface HidesContent extends Expandable {
  hasHiddenContent(): boolean;
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

export function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}
