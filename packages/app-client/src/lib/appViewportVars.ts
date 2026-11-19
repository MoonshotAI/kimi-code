export interface AppViewportVars {
  height: number;
  top: number;
}

export interface AppViewportVarsTarget {
  setProperty(name: string, value: string): void;
}

export function createAppViewportVarsWriter(
  target: AppViewportVarsTarget,
): (vars: AppViewportVars) => boolean {
  let lastHeight: number | null = null;
  let lastTop: number | null = null;
  return ({ height, top }) => {
    let wrote = false;
    if (height !== lastHeight) {
      lastHeight = height;
      target.setProperty('--app-height', `${height}px`);
      wrote = true;
    }
    if (top !== lastTop) {
      lastTop = top;
      target.setProperty('--app-top', `${top}px`);
      wrote = true;
    }
    return wrote;
  };
}
