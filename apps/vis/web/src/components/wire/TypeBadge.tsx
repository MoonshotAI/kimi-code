import type { AgentRecord } from '../../types';
import { Pill } from '../shared/Pill';
import { TYPE_LABEL, TYPE_TONE } from './typeMeta';

type RecordType = AgentRecord['type'];

interface TypeBadgeProps {
  type: RecordType;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const label = TYPE_LABEL[type] ?? type;
  const tone = TYPE_TONE[type] ?? 'neutral';
  return (
    <Pill tone={tone} variant="soft" title={type}>
      {label}
    </Pill>
  );
}
