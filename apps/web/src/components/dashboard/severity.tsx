import { AlertTriangle, Info, OctagonAlert, XCircle } from 'lucide-react';
import type { NotificationDTO } from '@multizap/shared';
import { Badge, type Tone } from '@multizap/ui';

const MAP: Record<NotificationDTO['severity'], { tone: Tone; label: string; icon: typeof Info }> = {
  INFO: { tone: 'info', label: 'Info', icon: Info },
  WARNING: { tone: 'warning', label: 'Atenção', icon: AlertTriangle },
  ERROR: { tone: 'danger', label: 'Erro', icon: XCircle },
  CRITICAL: { tone: 'danger', label: 'Crítico', icon: OctagonAlert },
};

export function SeverityBadge({ severity }: { severity: NotificationDTO['severity'] }) {
  const m = MAP[severity];
  return (
    <Badge tone={m.tone}>
      <m.icon className="h-3 w-3" aria-hidden /> {m.label}
    </Badge>
  );
}
