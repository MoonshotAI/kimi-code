import type { EnvironmentRegistrySnapshot } from '#/environment/environmentRegistry';

export function buildEnvironmentsInfo(
  snapshot: EnvironmentRegistrySnapshot,
  currentEnvironmentId: string,
): string {
  return snapshot.environments
    .map((environment) => {
      const current = environment.environmentId === currentEnvironmentId ? ', current' : '';
      return `- \`${environment.environmentId}\` (${environment.status}${current})`;
    })
    .join('\n');
}
