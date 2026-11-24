'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { CheckCircle2, Clock, Hash, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  formatPairingCode,
  formatPhone,
  normalizePhone,
  type AccountDTO,
  type PairingState,
} from '@multizap/shared';
import { Alert, Button, Field, Input, Modal, Segmented, Spinner } from '@multizap/ui';
import { api } from '@/lib/api';
import {
  accountKeys,
  useInvalidateAccounts,
  usePairingState,
  useStartPairing,
} from '@/lib/accounts';

type Method = 'qr' | 'pairing-code';

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Countdown({ expiresAt, now }: { expiresAt: number; now: number }) {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-subtle tabular-nums">
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {s > 0
        ? `Expira em ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
        : 'Atualizando...'}
    </span>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2.5 text-sm text-muted">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-fg">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function QrImage({ value, stale }: { value: string; stale: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      margin: 1,
      width: 280,
      errorCorrectionLevel: 'L',
      color: { dark: '#0b1118', light: '#ffffff' },
    })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value]);
  return (
    <div className="relative grid h-[244px] w-[244px] place-items-center rounded-xl bg-white p-3 shadow-[0_0_0_1px_rgb(255_255_255/0.08)]">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="QR Code de pareamento do WhatsApp"
          width={220}
          height={220}
          className={stale ? 'opacity-25 blur-[2px]' : ''}
        />
      ) : (
        <Spinner />
      )}
      {stale && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
    </div>
  );
}

/**
 * Pareamento de dispositivo conectado.
 * O QR Code e o código exibidos são exatamente os fornecidos pelo WhatsApp
 * (via gateway); a interface apenas os apresenta e acompanha o estado.
 */
export function PairingModal({
  account,
  open,
  onOpenChange,
  initialMethod = 'qr',
}: {
  account: Pick<AccountDTO, 'id' | 'name'>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialMethod?: Method;
}) {
  const qc = useQueryClient();
  const invalidate = useInvalidateAccounts();
  const start = useStartPairing(account.id);
  const [method, setMethod] = useState<Method>(initialMethod);
  const [active, setActive] = useState(false);
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const pairing = usePairingState(account.id, open && active);
  const state: PairingState | null = active ? (pairing.data?.state ?? null) : null;
  const connected = active && (state?.kind === 'connected' || pairing.data?.status === 'CONNECTED');
  const now = useNow(open && active && !connected);
  const notifiedRef = useRef(false);

  const begin = (m: Method, phoneE164?: string) => {
    qc.setQueryData(accountKeys.pairing(account.id), {
      state: { kind: 'starting', method: m, at: Date.now() },
      status: 'AWAITING_CONNECTION',
      statusReason: null,
    });
    start.mutate(m === 'qr' ? { method: 'qr' } : { method: 'pairing-code', phone: phoneE164! }, {
      onSuccess: () => setActive(true),
    });
  };

  const cancelRemote = () => {
    void api(`/accounts/${account.id}/pairing`, { method: 'DELETE' }).catch(() => undefined);
  };

  // Abre já gerando o QR Code (método principal).
  useEffect(() => {
    if (open && method === 'qr' && !active && !start.isPending && !start.isError) begin('qr');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (connected && !notifiedRef.current) {
      notifiedRef.current = true;
      void invalidate();
    }
  }, [connected, invalidate]);

  const close = (o: boolean) => {
    if (!o) {
      if (active && !connected) cancelRemote();
      setActive(false);
      setPhone('');
      setPhoneError(null);
      setMethod(initialMethod);
      start.reset();
      notifiedRef.current = false;
    }
    onOpenChange(o);
  };

  const switchMethod = (m: Method) => {
    if (m === method) return;
    if (active && !connected) cancelRemote();
    setActive(false);
    start.reset();
    setMethod(m);
    if (m === 'qr') begin('qr');
  };

  const submitPhone = (e: React.FormEvent) => {
    e.preventDefault();
    const r = normalizePhone(phone);
    if (!r.ok) {
      setPhoneError(
        'Telefone inválido. Use o número com DDD (e código do país, se não for do Brasil).',
      );
      return;
    }
    setPhoneError(null);
    begin('pairing-code', r.e164);
  };

  const retry = () => {
    setActive(false);
    start.reset();
    if (method === 'qr') begin('qr');
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title={`Conectar "${account.name}"`}
      description="Vincule o WhatsApp como dispositivo conectado."
      className="w-[min(94vw,620px)]"
    >
      {connected ? (
        <div className="flex flex-col items-center py-6 text-center animate-slide-up">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-success-soft text-success">
            <CheckCircle2 className="h-7 w-7" aria-hidden />
          </span>
          <p className="mt-4 text-base font-semibold text-fg">Dispositivo conectado</p>
          <p className="mt-1 max-w-sm text-sm text-muted">
            A sessão foi salva com segurança e será mantida mesmo após reinícios do sistema.
          </p>
          <Button className="mt-6" onClick={() => close(false)}>
            Concluir
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <Segmented<Method>
            value={method}
            onChange={switchMethod}
            options={[
              { value: 'qr', label: 'QR Code' },
              { value: 'pairing-code', label: 'Conectar com número de telefone' },
            ]}
          />

          {start.isError && (
            <Alert tone="danger" title="Não foi possível iniciar o pareamento">
              {start.error.message}{' '}
              <button
                className="font-medium text-fg underline-offset-2 hover:underline"
                onClick={retry}
              >
                Tentar novamente
              </button>
            </Alert>
          )}

          {method === 'pairing-code' && !active && !start.isPending && (
            <form onSubmit={submitPhone} className="space-y-4" noValidate>
              <p className="text-sm text-muted">
                Use esta opção quando não for possível ler o QR Code. O WhatsApp vai gerar um código
                de 8 caracteres para você digitar no celular.
              </p>
              <Field
                label="Número do WhatsApp que será conectado"
                htmlFor="pair-phone"
                error={phoneError ?? undefined}
                hint="Com DDD. Para outros países, inclua o código (+351...)."
              >
                <Input
                  id="pair-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(11) 98765-4321"
                  inputMode="tel"
                  autoFocus
                  aria-invalid={!!phoneError}
                />
              </Field>
              <Button type="submit">
                <Hash className="h-4 w-4" aria-hidden /> Gerar código
              </Button>
            </form>
          )}

          {(start.isPending || (active && (!state || state.kind === 'starting'))) && (
            <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted">
              <Spinner className="h-6 w-6" />
              Solicitando ao WhatsApp...
            </div>
          )}

          {active && state?.kind === 'qr' && (
            <div className="grid items-center gap-6 sm:grid-cols-[244px_1fr]">
              <div className="flex flex-col items-center gap-2">
                <QrImage value={state.qr} stale={state.expiresAt <= now} />
                <Countdown expiresAt={state.expiresAt} now={now} />
              </div>
              <div className="space-y-4">
                <Steps
                  items={[
                    'Abra o WhatsApp no celular.',
                    <>
                      Toque em <strong className="text-fg">Mais opções</strong> (⋮) ou{' '}
                      <strong className="text-fg">Configurações</strong> e entre em{' '}
                      <strong className="text-fg">Aparelhos conectados</strong>.
                    </>,
                    <>
                      Toque em <strong className="text-fg">Conectar um aparelho</strong>.
                    </>,
                    'Aponte a câmera para este QR Code.',
                  ]}
                />
                <button
                  type="button"
                  onClick={() => switchMethod('pairing-code')}
                  className="text-xs text-accent underline-offset-2 hover:underline"
                >
                  Não consegue ler o QR Code? Conectar com número de telefone
                </button>
              </div>
            </div>
          )}

          {active && state?.kind === 'pairing-code' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-soft py-6">
                <p className="text-xs font-medium uppercase tracking-wider text-subtle">
                  Código de pareamento
                </p>
                <p
                  className="font-mono text-4xl font-semibold tracking-[0.2em] text-fg"
                  aria-live="polite"
                >
                  {formatPairingCode(state.code)}
                </p>
                <Countdown expiresAt={state.expiresAt} now={now} />
              </div>
              <Steps
                items={[
                  <>
                    Abra o WhatsApp no celular do número{' '}
                    <strong className="text-fg">{formatPhone(state.phoneE164)}</strong>.
                  </>,
                  <>
                    Entre em <strong className="text-fg">Aparelhos conectados</strong> e toque em{' '}
                    <strong className="text-fg">Conectar um aparelho</strong>.
                  </>,
                  <>
                    Toque em <strong className="text-fg">Conectar com número de telefone</strong>.
                  </>,
                  'Digite o código acima e confirme no celular.',
                ]}
              />
            </div>
          )}

          {active && state?.kind === 'expired' && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Clock className="h-8 w-8 text-warning" aria-hidden />
              <p className="text-sm font-medium text-fg">
                O tempo para concluir o pareamento expirou.
              </p>
              <Button variant="secondary" onClick={retry}>
                <RefreshCw className="h-4 w-4" aria-hidden />{' '}
                {method === 'qr' ? 'Gerar novo QR Code' : 'Tentar novamente'}
              </Button>
            </div>
          )}

          {active && state?.kind === 'failed' && (
            <div className="space-y-4">
              <Alert tone="danger" title="Pareamento não concluído">
                {state.message}
              </Alert>
              <Button variant="secondary" onClick={retry}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Tentar novamente
              </Button>
            </div>
          )}

          <div className="flex items-start gap-2 border-t border-border pt-4 text-xs text-subtle">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
            <span>
              As credenciais da sessão são armazenadas criptografadas. Para desconectar, use
              “Remover conexão” no MultiZap ou remova o aparelho no celular.
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
