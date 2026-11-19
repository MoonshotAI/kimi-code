export const BOOT_STAGES = ['auth', 'server', 'config', 'sessions', 'session'] as const;

export type BootStage = (typeof BOOT_STAGES)[number];
