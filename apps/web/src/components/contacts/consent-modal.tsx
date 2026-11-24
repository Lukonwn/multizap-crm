'use client';
import { useState } from 'react';
import { Alert, Button, Field, Input, Modal } from '@multizap/ui';
import { useContactsMutation } from '@/lib/contacts';

export type ConsentMode = 'grant' | 'revoke' | 'opt-out' | 'resubscribe';

const COPY: Record<
  ConsentMode,
  { title: string; description: string; button: string; sourceLabel?: string; danger?: boolean }
> = {
  grant: {
    title: 'Registrar consentimento',
    description: 'Documente como e quando o contato autorizou ser contatado.',
    button: 'Registrar',
    sourceLabel: 'Como o consentimento foi obtido?',
  },
  revoke: {
    title: 'Revogar consentimento',
    description: 'O contato deixa de estar autorizado.',
    button: 'Revogar',
    sourceLabel: 'Motivo / origem da revogação',
    danger: true,
  },
  'opt-out': {
    title: 'Descadastrar contato',
    description:
      'O telefone será bloqueado nesta instância: nunca entrará em campanhas, mesmo se reimportado.',
    button: 'Descadastrar',
    danger: true,
  },
  resubscribe: {
    title: 'Reverter descadastramento',
    description: 'Somente com um novo consentimento expresso do contato.',
    button: 'Reverter',
    sourceLabel: 'Como o novo consentimento foi obtido?',
  },
};

export function ConsentModal({
  accountId,
  contactId,
  mode,
  onClose,
}: {
  accountId: string;
  contactId: string;
  mode: ConsentMode | null;
  onClose: () => void;
}) {
  const m = useContactsMutation(accountId);
  const [source, setSource] = useState('');
  const [evidence, setEvidence] = useState('');
  if (!mode) return null;
  const c = COPY[mode];

  const submit = () => {
    const body =
      mode === 'opt-out'
        ? { path: `/contacts/${contactId}/opt-out`, json: { reason: source || null } }
        : mode === 'resubscribe'
          ? { path: `/contacts/${contactId}/resubscribe`, json: { source, evidence } }
          : {
              path: `/contacts/${contactId}/consent`,
              json: { action: mode === 'grant' ? 'GRANTED' : 'REVOKED', source, evidence },
            };
    m.mutate(body, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={c.title}
      description={c.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={c.danger ? 'danger' : 'primary'} loading={m.isPending} onClick={submit}>
            {c.button}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {m.isError && <Alert tone="danger">{m.error.message}</Alert>}
        <Field label={c.sourceLabel ?? 'Motivo (opcional)'} htmlFor="consent-source">
          <Input
            id="consent-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            autoFocus
          />
        </Field>
        {mode !== 'opt-out' && (
          <Field
            label="Evidência (opcional)"
            htmlFor="consent-evidence"
            hint="Ex.: protocolo, link do formulário, print salvo."
          >
            <Input
              id="consent-evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
