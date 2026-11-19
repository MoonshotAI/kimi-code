export type DesktopFailureKind = 'external-link' | 'screenshot-save';

export function isDesktopFailureKind(value: unknown): value is DesktopFailureKind {
  return value === 'external-link' || value === 'screenshot-save';
}
