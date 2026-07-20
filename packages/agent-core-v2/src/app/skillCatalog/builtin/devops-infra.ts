/**
 * `skillCatalog` domain (L3) — builtin `devops-infra` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import DEVOPS_INFRA_BODY from './devops-infra/SKILL.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_BODY from './devops-infra/chaos-engineer/SKILL.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_CHAOS_TOOLS from './devops-infra/chaos-engineer/references/chaos-tools.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_EXPERIMENT_DESIGN from './devops-infra/chaos-engineer/references/experiment-design.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_GAME_DAYS from './devops-infra/chaos-engineer/references/game-days.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_INFRASTRUCTURE_CHAOS from './devops-infra/chaos-engineer/references/infrastructure-chaos.md?raw';
import DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_KUBERNETES_CHAOS from './devops-infra/chaos-engineer/references/kubernetes-chaos.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_BODY from './devops-infra/cli-developer/SKILL.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_DESIGN_PATTERNS from './devops-infra/cli-developer/references/design-patterns.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_GO_CLI from './devops-infra/cli-developer/references/go-cli.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_NODE_CLI from './devops-infra/cli-developer/references/node-cli.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_PYTHON_CLI from './devops-infra/cli-developer/references/python-cli.md?raw';
import DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_UX_PATTERNS from './devops-infra/cli-developer/references/ux-patterns.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_BODY from './devops-infra/cloud-architect/SKILL.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_AWS from './devops-infra/cloud-architect/references/aws.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_AZURE from './devops-infra/cloud-architect/references/azure.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_COST from './devops-infra/cloud-architect/references/cost.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_GCP from './devops-infra/cloud-architect/references/gcp.md?raw';
import DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_MULTI_CLOUD from './devops-infra/cloud-architect/references/multi-cloud.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_BODY from './devops-infra/devops-engineer/SKILL.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_DEPLOYMENT_STRATEGIES from './devops-infra/devops-engineer/references/deployment-strategies.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_DOCKER_PATTERNS from './devops-infra/devops-engineer/references/docker-patterns.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_GITHUB_ACTIONS from './devops-infra/devops-engineer/references/github-actions.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_INCIDENT_RESPONSE from './devops-infra/devops-engineer/references/incident-response.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_KUBERNETES from './devops-infra/devops-engineer/references/kubernetes.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_PLATFORM_ENGINEERING from './devops-infra/devops-engineer/references/platform-engineering.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_RELEASE_AUTOMATION from './devops-infra/devops-engineer/references/release-automation.md?raw';
import DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_TERRAFORM_IAC from './devops-infra/devops-engineer/references/terraform-iac.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_BODY from './devops-infra/kubernetes-specialist/SKILL.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_CONFIGURATION from './devops-infra/kubernetes-specialist/references/configuration.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_COST_OPTIMIZATION from './devops-infra/kubernetes-specialist/references/cost-optimization.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_CUSTOM_OPERATORS from './devops-infra/kubernetes-specialist/references/custom-operators.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_GITOPS from './devops-infra/kubernetes-specialist/references/gitops.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_HELM_CHARTS from './devops-infra/kubernetes-specialist/references/helm-charts.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_MULTI_CLUSTER from './devops-infra/kubernetes-specialist/references/multi-cluster.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_NETWORKING from './devops-infra/kubernetes-specialist/references/networking.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_SERVICE_MESH from './devops-infra/kubernetes-specialist/references/service-mesh.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_STORAGE from './devops-infra/kubernetes-specialist/references/storage.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_TROUBLESHOOTING from './devops-infra/kubernetes-specialist/references/troubleshooting.md?raw';
import DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_WORKLOADS from './devops-infra/kubernetes-specialist/references/workloads.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_BODY from './devops-infra/monitoring-expert/SKILL.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_ALERTING_RULES from './devops-infra/monitoring-expert/references/alerting-rules.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_APPLICATION_PROFILING from './devops-infra/monitoring-expert/references/application-profiling.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_CAPACITY_PLANNING from './devops-infra/monitoring-expert/references/capacity-planning.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_DASHBOARDS from './devops-infra/monitoring-expert/references/dashboards.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_OPENTELEMETRY from './devops-infra/monitoring-expert/references/opentelemetry.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_PERFORMANCE_TESTING from './devops-infra/monitoring-expert/references/performance-testing.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_PROMETHEUS_METRICS from './devops-infra/monitoring-expert/references/prometheus-metrics.md?raw';
import DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_STRUCTURED_LOGGING from './devops-infra/monitoring-expert/references/structured-logging.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_BODY from './devops-infra/sre-engineer/SKILL.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_AUTOMATION_TOIL from './devops-infra/sre-engineer/references/automation-toil.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_ERROR_BUDGET_POLICY from './devops-infra/sre-engineer/references/error-budget-policy.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_INCIDENT_CHAOS from './devops-infra/sre-engineer/references/incident-chaos.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_MONITORING_ALERTING from './devops-infra/sre-engineer/references/monitoring-alerting.md?raw';
import DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_SLO_SLI_MANAGEMENT from './devops-infra/sre-engineer/references/slo-sli-management.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_BODY from './devops-infra/terraform-engineer/SKILL.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_BEST_PRACTICES from './devops-infra/terraform-engineer/references/best-practices.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_MODULE_PATTERNS from './devops-infra/terraform-engineer/references/module-patterns.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_PROVIDERS from './devops-infra/terraform-engineer/references/providers.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_STATE_MANAGEMENT from './devops-infra/terraform-engineer/references/state-management.md?raw';
import DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_TESTING from './devops-infra/terraform-engineer/references/testing.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
  resources?: Readonly<Record<string, string>>,
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
    resources,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
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
  {
    'references/chaos-tools.md': DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_CHAOS_TOOLS,
    'references/experiment-design.md': DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_EXPERIMENT_DESIGN,
    'references/game-days.md': DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_GAME_DAYS,
    'references/infrastructure-chaos.md': DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_INFRASTRUCTURE_CHAOS,
    'references/kubernetes-chaos.md': DEVOPS_INFRA_CHAOS_ENGINEER_REFERENCES_KUBERNETES_CHAOS,
  },
);

export const DEVOPS_INFRA_CLI_DEVELOPER_SKILL = makeBuiltin(
  DEVOPS_INFRA_CLI_DEVELOPER_BODY,
  'devops-infra.cli-developer',
  'builtin://devops-infra/cli-developer',
  { isSubSkill: true },
  {
    'references/design-patterns.md': DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_DESIGN_PATTERNS,
    'references/go-cli.md': DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_GO_CLI,
    'references/node-cli.md': DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_NODE_CLI,
    'references/python-cli.md': DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_PYTHON_CLI,
    'references/ux-patterns.md': DEVOPS_INFRA_CLI_DEVELOPER_REFERENCES_UX_PATTERNS,
  },
);

export const DEVOPS_INFRA_CLOUD_ARCHITECT_SKILL = makeBuiltin(
  DEVOPS_INFRA_CLOUD_ARCHITECT_BODY,
  'devops-infra.cloud-architect',
  'builtin://devops-infra/cloud-architect',
  { isSubSkill: true },
  {
    'references/aws.md': DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_AWS,
    'references/azure.md': DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_AZURE,
    'references/cost.md': DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_COST,
    'references/gcp.md': DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_GCP,
    'references/multi-cloud.md': DEVOPS_INFRA_CLOUD_ARCHITECT_REFERENCES_MULTI_CLOUD,
  },
);

export const DEVOPS_INFRA_DEVOPS_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_DEVOPS_ENGINEER_BODY,
  'devops-infra.devops-engineer',
  'builtin://devops-infra/devops-engineer',
  { isSubSkill: true },
  {
    'references/deployment-strategies.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_DEPLOYMENT_STRATEGIES,
    'references/docker-patterns.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_DOCKER_PATTERNS,
    'references/github-actions.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_GITHUB_ACTIONS,
    'references/incident-response.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_INCIDENT_RESPONSE,
    'references/kubernetes.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_KUBERNETES,
    'references/platform-engineering.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_PLATFORM_ENGINEERING,
    'references/release-automation.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_RELEASE_AUTOMATION,
    'references/terraform-iac.md': DEVOPS_INFRA_DEVOPS_ENGINEER_REFERENCES_TERRAFORM_IAC,
  },
);

export const DEVOPS_INFRA_KUBERNETES_SPECIALIST_SKILL = makeBuiltin(
  DEVOPS_INFRA_KUBERNETES_SPECIALIST_BODY,
  'devops-infra.kubernetes-specialist',
  'builtin://devops-infra/kubernetes-specialist',
  { isSubSkill: true },
  {
    'references/configuration.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_CONFIGURATION,
    'references/cost-optimization.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_COST_OPTIMIZATION,
    'references/custom-operators.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_CUSTOM_OPERATORS,
    'references/gitops.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_GITOPS,
    'references/helm-charts.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_HELM_CHARTS,
    'references/multi-cluster.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_MULTI_CLUSTER,
    'references/networking.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_NETWORKING,
    'references/service-mesh.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_SERVICE_MESH,
    'references/storage.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_STORAGE,
    'references/troubleshooting.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_TROUBLESHOOTING,
    'references/workloads.md': DEVOPS_INFRA_KUBERNETES_SPECIALIST_REFERENCES_WORKLOADS,
  },
);

export const DEVOPS_INFRA_MONITORING_EXPERT_SKILL = makeBuiltin(
  DEVOPS_INFRA_MONITORING_EXPERT_BODY,
  'devops-infra.monitoring-expert',
  'builtin://devops-infra/monitoring-expert',
  { isSubSkill: true },
  {
    'references/alerting-rules.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_ALERTING_RULES,
    'references/application-profiling.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_APPLICATION_PROFILING,
    'references/capacity-planning.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_CAPACITY_PLANNING,
    'references/dashboards.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_DASHBOARDS,
    'references/opentelemetry.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_OPENTELEMETRY,
    'references/performance-testing.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_PERFORMANCE_TESTING,
    'references/prometheus-metrics.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_PROMETHEUS_METRICS,
    'references/structured-logging.md': DEVOPS_INFRA_MONITORING_EXPERT_REFERENCES_STRUCTURED_LOGGING,
  },
);

export const DEVOPS_INFRA_SRE_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_SRE_ENGINEER_BODY,
  'devops-infra.sre-engineer',
  'builtin://devops-infra/sre-engineer',
  { isSubSkill: true },
  {
    'references/automation-toil.md': DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_AUTOMATION_TOIL,
    'references/error-budget-policy.md': DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_ERROR_BUDGET_POLICY,
    'references/incident-chaos.md': DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_INCIDENT_CHAOS,
    'references/monitoring-alerting.md': DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_MONITORING_ALERTING,
    'references/slo-sli-management.md': DEVOPS_INFRA_SRE_ENGINEER_REFERENCES_SLO_SLI_MANAGEMENT,
  },
);

export const DEVOPS_INFRA_TERRAFORM_ENGINEER_SKILL = makeBuiltin(
  DEVOPS_INFRA_TERRAFORM_ENGINEER_BODY,
  'devops-infra.terraform-engineer',
  'builtin://devops-infra/terraform-engineer',
  { isSubSkill: true },
  {
    'references/best-practices.md': DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_BEST_PRACTICES,
    'references/module-patterns.md': DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_MODULE_PATTERNS,
    'references/providers.md': DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_PROVIDERS,
    'references/state-management.md': DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_STATE_MANAGEMENT,
    'references/testing.md': DEVOPS_INFRA_TERRAFORM_ENGINEER_REFERENCES_TESTING,
  },
);
