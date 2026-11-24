'use client';
import { useState } from 'react';
import { Alert, Button, Field, Input, Modal } from '@multizap/ui';

/** Confirmação de exclusão: o administrador digita o nome do item. */
export function ConfirmNameModal({
  open,
  onOpenChange,
  title,
  name,
  description,
  loading,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  name: string;
  description: string;
  loading?: boolean;
  error?: string | null;
  onConfirm: (typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) setTyped('');
        onOpenChange(v);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            loading={loading}
            disabled={typed.trim() !== name}
            onClick={() => onConfirm(typed.trim())}
          >
            Excluir
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={`Digite "${name}" para confirmar`} htmlFor="confirm-name">
          <Input id="confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
