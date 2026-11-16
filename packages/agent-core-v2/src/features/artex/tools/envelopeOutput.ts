import { ArtexDataEnvelope } from '#/features/artex/prompts/dataEnvelope';

const OVERVIEW_DERIVED_FIELDS = [
  'recent_facts',
  'finding_list',
  'cold_digests',
  'related_tasks',
] as const;

const OPERATOR_HINT_ORIGIN = 'human';

export function renderOverviewSections(
  data: Record<string, unknown>,
  envelope: ArtexDataEnvelope,
): string {
  const operator: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  const derived: Record<string, unknown> = {};
  const agentHints: Record<string, unknown>[] = [];

  for (const [key, value] of Object.entries(data)) {
    switch (key) {
      case 'task':
      case 'goals':
        operator[key] = value;
        break;
      case 'hints': {
        const hints = Array.isArray(value) ? value : [];
        const own: Record<string, unknown>[] = [];
        for (const entry of hints) {
          if (typeof entry !== 'object' || entry === null) continue;
          const hint = entry as Record<string, unknown>;
          if (hint['origin'] === OPERATOR_HINT_ORIGIN) {
            own.push(hint);
          } else {
            agentHints.push(hint);
          }
        }
        operator['hints'] = own;
        break;
      }
      default:
        rest[key] = value;
        break;
    }
  }

  for (const field of OVERVIEW_DERIVED_FIELDS) {
    if (field in rest) {
      derived[field] = rest[field];
      delete rest[field];
    }
  }

  const sections: string[] = [];
  const pushJson = (header: string, block: Record<string, unknown>): void => {
    sections.push(header, JSON.stringify(block, null, 2));
  };

  pushJson(
    '\n\n[Operator (set by the operator: the task and its goal, the goal nodes, and the operator\'s own hints; these define the work)]:\n',
    operator,
  );
  pushJson('\n\n[Counters, intents and coverage]:\n', rest);

  const derivedFields: string[] = [...OVERVIEW_DERIVED_FIELDS];
  if (agentHints.length > 0) {
    derived['agent_hints'] = agentHints;
    derivedFields.push('agent_hints');
  }

  for (const field of derivedFields) {
    const value = derived[field];
    if (value === undefined) continue;
    sections.push('\n\n', envelope.wrap(field, JSON.stringify(value, null, 2)));
  }

  return sections.join('');
}

export function artexEnvelopedToolText(
  field: string,
  content: string,
  envelope: ArtexDataEnvelope = new ArtexDataEnvelope(),
): string {
  return `${envelope.intro()}${envelope.wrap(field, content)}`;
}

export function artexEnvelopedJson(field: string, value: unknown): string {
  const envelope = new ArtexDataEnvelope();
  return artexEnvelopedToolText(field, JSON.stringify(value, null, 2), envelope);
}