export function playwrightEnv(headless: boolean, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { KIMI_E2E_HEADED: _headed, KIMI_E2E_HEADLESS: _headless, ...rest } = env;
  return headless ? { ...rest, KIMI_E2E_HEADLESS: '1' } : rest;
}
