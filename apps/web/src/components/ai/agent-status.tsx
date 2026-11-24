import { AGENT_STATUS_LABEL, type AgentDTO } from '@multizap/shared';
import { Badge, type Tone } from '@multizap/ui';

const TONE: Record<AgentDTO['status'], Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  PAUSED: 'warning',
  ERROR: 'danger',
};

export function AgentStatusBadge({ status }: { status: AgentDTO['status'] }) {
  return (
    <Badge tone={TONE[status]} dot>
      {AGENT_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
