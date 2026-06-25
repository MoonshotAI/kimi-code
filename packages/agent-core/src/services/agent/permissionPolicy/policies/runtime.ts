import type { PathClass } from '../../../../tools/policies/path-access';
import type {
  PermissionGitWorkTreeMarker,
  PermissionServiceOptions,
} from '../../permission/permission';

export interface PermissionPolicyRuntime {
  readonly options: PermissionServiceOptions;
  planModeActive(): boolean;
  planFilePath(): string | null;
  swarmModeIsActive(): boolean;
  pathClass(): PathClass;
  findGitWorkTreeMarker(cwd: string): Promise<PermissionGitWorkTreeMarker | null>;
  exitPlanMode(): { readonly isError: true; readonly output: string } | undefined;
  formatPermissionRuleDenyMessage(tool: string, reason: string | undefined): string;
}
