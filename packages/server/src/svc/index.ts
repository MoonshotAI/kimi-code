

export { resolveServiceManager } from './service';
export { createLaunchdManager, parseLaunchctlPrint } from './launchd';
export { buildLaunchAgentPlist } from './launchd-plist';
export { createSystemdManager } from './systemd';
export { buildSystemdUnit, parseSystemctlShow } from './systemd-unit';
export { createSchtasksManager } from './schtasks';
export { buildScheduledTaskXml, parseSchtasksQuery } from './schtasks-xml';
export { buildInstallPlan, readInstallPlan, writeInstallPlan } from './install-plan';
export type { InstallPlan } from './install-plan';
export {
  KIMI_SERVER_LABEL,
  KIMI_SERVER_PLIST_FILENAME,
  KIMI_SERVER_SYSTEMD_UNIT,
  KIMI_SERVER_TASK_NAME,
} from './paths';
export {
  ServiceUnavailableError,
  ServiceUnsupportedError,
  type InstallArgs,
  type InstallResult,
  type LifecycleResult,
  type ServiceManager,
  type ServiceStatus,
} from './types';
