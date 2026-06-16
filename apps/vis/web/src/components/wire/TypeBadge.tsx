import type { AgentRecord } from '../../types';
import { Pill } from '../shared/Pill';
import { rendererFor } from './renderers';

type RecordType = AgentRecord['type'];

interface TypeBadgeProps {
  type: RecordType;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const renderer = rendererFor(type);
  const label = renderer?.label ?? type;
  const tone = renderer?.tone ?? 'neutral';
  return (
    <Pill tone={tone} variant="soft" title={type}>
      {label}
    </Pill>
  );
}
