declare const __KIMI_CODE_BUILT_IN_CATALOG__: string | undefined;

export const BUILT_IN_MODELS_DEV_JSON: string | undefined =
  typeof __KIMI_CODE_BUILT_IN_CATALOG__ === 'string'
    ? __KIMI_CODE_BUILT_IN_CATALOG__
    : undefined;
