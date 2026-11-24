'use client';
import { useState } from 'react';
import { Alert, Button, Field, Input, Modal } from '@multizap/ui';

/** Confirmação de ação destrutiva: o administrador digita o nome da instância. */
export function ConfirmNameModal({
  open,
  onOpenChange,
  title,
  description,
  name,
  confirmLabel,
  loading,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: React.ReactNode;
  name: string;
  confirmLabel: string;
  loading?: boolean;
  error?: string | null;
  onConfirm: (confirmName: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setValue('');
      }}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            disabled={value.trim() !== name}
            loading={loading}
            onClick={() => onConfirm(value.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-muted">
        <div>{description}</div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={`Digite "${name}" para confirmar`} htmlFor="confirm-name">
          <Input
            id="confirm-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
        </Field>
      </div>
    </Modal>
  );
}
