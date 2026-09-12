export const HUMAN_RECORD_PREFIX = 'human.';
export const HUMAN_AGENT_DOMAIN = 'agent';

export function isHumanRecordType(type: string): boolean {
  return type.startsWith(HUMAN_RECORD_PREFIX);
}

export function humanRecordType(domain: string, type: string): string {
  return `${HUMAN_RECORD_PREFIX}${domain}.${type}`;
}

export function humanEventType(recordType: string, domain: string): string | undefined {
  const prefix = `${HUMAN_RECORD_PREFIX}${domain}.`;
  if (!recordType.startsWith(prefix)) return undefined;
  const type = recordType.slice(prefix.length);
  return type.length === 0 ? undefined : type;
}
