import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import DEVOPS_INFRA_BODY from './devops-infra/SKILL.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_BODY from './devops-infra/chaos-engineer/SKILL.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_BODY from './devops-infra/cli-developer/SKILL.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_BODY from './devops-infra/cloud-architect/SKILL.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_BODY from './devops-infra/devops-engineer/SKILL.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_BODY from './devops-infra/kubernetes-specialist/SKILL.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_BODY from './devops-infra/monitoring-expert/SKILL.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_BODY from './devops-infra/sre-engineer/SKILL.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_BODY from './devops-infra/terraform-engineer/SKILL.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${dirName}/SKILL.md`,
    skillDirName: dirName,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    name: dirName,
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      disableModelInvocation: true,
      ...extraMetadata,
    },
  };
}

export const DEVOPS_INFRA_SKILL = makeBuiltin(
  DEVOPS_INFRA_BODY,
  'devops-infra',
  'builtin://devops-infra',
  { 'has-sub-skill': true },
);

export const DEVOPS_INFRA_CHAOS_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_CHAOS_ENGINEER_BODY,
  'devops-infra.chaos-engineer',
  'builtin://devops-infra/chaos-engineer',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_CLI_DEVELOPER_SKILL = makeBuiltin(
  DEVOPS_INFRA_CLI_DEVELOPER_BODY,
  'devops-infra.cli-developer',
  'builtin://devops-infra/cli-developer',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_CLOUD_ARCHITECT_SKILL = makeBuiltin(
  DEVOPS_INFRA_CLOUD_ARCHITECT_BODY,
  'devops-infra.cloud-architect',
  'builtin://devops-infra/cloud-architect',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_DEVOPS_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_DEVOPS_ENGINEER_BODY,
  'devops-infra.devops-engineer',
  'builtin://devops-infra/devops-engineer',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_KUBERNETES_SPECIALIST_SKILL = makeBuiltin(
  DEVOPS_INFRA_KUBERNETES_SPECIALIST_BODY,
  'devops-infra.kubernetes-specialist',
  'builtin://devops-infra/kubernetes-specialist',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_MONITORING_EXPERT_SKILL = makeBuiltin(
  DEVOPS_INFRA_MONITORING_EXPERT_BODY,
  'devops-infra.monitoring-expert',
  'builtin://devops-infra/monitoring-expert',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_SRE_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_SRE_ENGINEER_BODY,
  'devops-infra.sre-engineer',
  'builtin://devops-infra/sre-engineer',
  { isSubSkill: true },
);

export const DEVOPS_INFRA_TERRAFORM_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_TERRAFORM_ENGINEER_BODY,
  'devops-infra.terraform-engineer',
  'builtin://devops-infra/terraform-engineer',
  { isSubSkill: true },
);

