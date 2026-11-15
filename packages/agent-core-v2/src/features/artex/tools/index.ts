import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentToolCtor, AnyAgentTool } from '#/agent/toolRegistry/toolContribution';

import { ArtexAddIntentTool, IArtexAddIntentTool } from './add_intent/add_intent';
import { ArtexRecordFactTool, IArtexRecordFactTool } from './record_fact/record_fact';
import { ArtexReportFindingTool, IArtexReportFindingTool } from './report_finding/report_finding';
import { ArtexProveGoalTool, IArtexProveGoalTool } from './prove_goal/prove_goal';
import { ArtexGoalMetTool, IArtexGoalMetTool } from './goal_met/goal_met';
import { ArtexGraphOverviewTool, IArtexGraphOverviewTool } from './graph_overview/graph_overview';
import { ArtexNodeDetailTool, IArtexNodeDetailTool } from './node_detail/node_detail';
import { ArtexListFindingsTool, IArtexListFindingsTool } from './list_findings/list_findings';
import { ArtexListFactsTool, IArtexListFactsTool } from './list_facts/list_facts';
import { ArtexListGoalsTool, IArtexListGoalsTool } from './list_goals/list_goals';
import { ArtexAddHintTool, IArtexAddHintTool } from './add_hint/add_hint';
import { ArtexSetGoalsTool, IArtexSetGoalsTool } from './set_goals/set_goals';
import { ArtexSteerWorkTool, IArtexSteerWorkTool } from './steer_work/steer_work';
import { ArtexKillWorkTool, IArtexKillWorkTool } from './kill_work/kill_work';

export interface ArtexToolRegistration {
  readonly id: ServiceIdentifier<AnyAgentTool>;
  readonly ctor: AgentToolCtor<AnyAgentTool>;
  readonly name: string;
}

export const ARTEX_TOOL_DOMAIN = 'artex';

export const ARTEX_TOOLS: readonly ArtexToolRegistration[] = [
  { id: IArtexAddIntentTool, ctor: ArtexAddIntentTool, name: 'add_intent' },
  { id: IArtexRecordFactTool, ctor: ArtexRecordFactTool, name: 'record_fact' },
  { id: IArtexReportFindingTool, ctor: ArtexReportFindingTool, name: 'report_finding' },
  { id: IArtexProveGoalTool, ctor: ArtexProveGoalTool, name: 'prove_goal' },
  { id: IArtexGoalMetTool, ctor: ArtexGoalMetTool, name: 'goal_met' },
  { id: IArtexGraphOverviewTool, ctor: ArtexGraphOverviewTool, name: 'graph_overview' },
  { id: IArtexNodeDetailTool, ctor: ArtexNodeDetailTool, name: 'node_detail' },
  { id: IArtexListFindingsTool, ctor: ArtexListFindingsTool, name: 'list_findings' },
  { id: IArtexListFactsTool, ctor: ArtexListFactsTool, name: 'list_facts' },
  { id: IArtexListGoalsTool, ctor: ArtexListGoalsTool, name: 'list_goals' },
  { id: IArtexAddHintTool, ctor: ArtexAddHintTool, name: 'add_hint' },
  { id: IArtexSetGoalsTool, ctor: ArtexSetGoalsTool, name: 'set_goals' },
  { id: IArtexSteerWorkTool, ctor: ArtexSteerWorkTool, name: 'steer_work' },
  { id: IArtexKillWorkTool, ctor: ArtexKillWorkTool, name: 'kill_work' },
];
