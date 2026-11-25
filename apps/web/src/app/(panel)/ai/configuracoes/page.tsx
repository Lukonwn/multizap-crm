'use client';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
} from '@multizap/ui';
import { formatDateTime } from '@/lib/format';
import { useAiMutation, useAiSettings, usePaymentWebhook } from '@/lib/ai';

function PaymentWebhookCard() {
  const hook = usePaymentWebhook();
  const rotate = useAiMutation<{ secret: string }>();
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const h = hook.data;
  const url = typeof window === 'undefined' ? '' : `${window.location.origin}${h?.path ?? ''}`;
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Aviso de pagamento (itens pagos)</CardTitle>
        <CardDescription>
          Itens pagos só são entregues depois que o pagamento é confirmado por você (em
          Atendimentos) ou por um aviso assinado enviado pelo seu sistema de pagamento. O agente e o
          contato nunca confirmam pagamento.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hook.isLoading || !h ? (
          <Spinner />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {h.configured ? (
                <>
                  <Badge tone="success">Segredo gerado (final {h.keyLast4})</Badge>
                </>
              ) : (
                <Badge>Sem aviso configurado: só a confirmação manual funciona</Badge>
              )}
            </div>
            {!h.canStoreKey && (
              <Alert tone="warning" title="O servidor não pode guardar o segredo">
                Configure a variável CREDENTIALS_MASTER_KEY na API.
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={rotate.isPending}
                disabled={!h.canStoreKey}
                onClick={() => {
                  if (
                    h.configured &&
                    !window.confirm(
                      'Gerar um novo segredo? O atual deixa de valer e o seu sistema precisa do novo.',
                    )
                  )
                    return;
                  setCopied(false);
                  rotate.mutate(
                    { path: '/ai/payments/webhook/rotate' },
                    { onSuccess: (r) => setSecret(r.secret) },
                  );
                }}
              >
                {h.configured ? 'Gerar novo segredo' : 'Gerar segredo'}
              </Button>
            </div>
            {rotate.error && <Alert tone="danger">{(rotate.error as Error).message}</Alert>}
            {secret && (
              <Alert tone="warning" title="Copie agora: este segredo não será mostrado de novo">
                <code className="break-all text-fg">{secret}</code>
                <span className="mt-2 block">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
                    }}
                  >
                    {copied ? 'Copiado' : 'Copiar'}
                  </Button>
                </span>
              </Alert>
            )}
            <div className="space-y-2 text-sm text-muted">
              <p>
                O seu sistema envia um <strong className="text-fg">POST</strong> para{' '}
                <code className="break-all text-fg">{url}</code> quando um pagamento é confirmado:
              </p>
              <pre className="overflow-x-auto rounded-lg bg-bg-soft p-3 text-xs text-muted">{`Corpo (JSON):
{ "reference": "MZ-7K2QXA", "status": "paid", "amountCents": 4990, "externalId": "id-do-pagamento" }

Cabeçalhos:
x-multizap-timestamp: <segundos desde 1970>
x-multizap-signature: sha256=<HMAC-SHA256 em hexadecimal de "<timestamp>.<corpo>" com o segredo>`}</pre>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  A <strong className="text-fg">referência</strong> é o código do pedido que o
                  agente manda ao contato (e que aparece em Atendimentos).
                </li>
                <li>
                  O valor precisa ser igual ou maior que o do pedido. O <code>externalId</code> não
                  pode se repetir. Avisos com mais de 5 minutos são recusados.
                </li>
                <li>
                  Use <code>&quot;status&quot;: &quot;canceled&quot;</code> para cancelar o pedido.
                </li>
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AiSettingsPage() {
  const settings = useAiSettings();
  const save = useAiMutation();
  const remove = useAiMutation();
  const test = useAiMutation<{ ok: boolean; error?: string }>();
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (settings.isLoading) return <Spinner />;
  if (settings.error) return <Alert tone="danger">{(settings.error as Error).message}</Alert>;
  const s = settings.data!;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>OpenRouter</CardTitle>
          <CardDescription>
            Os agentes usam modelos de IA pela OpenRouter. A chave fica criptografada no servidor e
            nunca é exibida de volta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-muted" aria-hidden />
            {s.configured ? (
              <>
                <span className="text-fg">Chave configurada (final {s.keyLast4})</span>
                {s.lastTestOk === true && <Badge tone="success">Conexão OK</Badge>}
                {s.lastTestOk === false && <Badge tone="danger">Falha na conexão</Badge>}
              </>
            ) : (
              <span className="text-muted">Nenhuma chave configurada</span>
            )}
          </div>
          {s.lastTestAt && (
            <p className="text-xs text-subtle">
              Último teste: {formatDateTime(s.lastTestAt)}
              {s.lastError ? ` — ${s.lastError}` : ''}
            </p>
          )}
          {!s.canStoreKey && (
            <Alert tone="warning" title="O servidor não pode guardar a chave">
              Configure a variável CREDENTIALS_MASTER_KEY na API para salvar a chave com segurança.
            </Alert>
          )}
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setMsg(null);
              save.mutate(
                { path: '/ai/settings', method: 'PUT', json: { apiKey: key.trim() } },
                {
                  onSuccess: () => {
                    setKey('');
                    setMsg({ tone: 'success', text: 'Chave salva.' });
                  },
                  onError: (err) => setMsg({ tone: 'danger', text: (err as Error).message }),
                },
              );
            }}
          >
            <Field
              label={s.configured ? 'Substituir chave' : 'Chave da API'}
              htmlFor="ai-key"
              hint="Crie em openrouter.ai, em Keys. Comece com sk-or-."
            >
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-or-..."
                disabled={!s.canStoreKey}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                loading={save.isPending}
                disabled={!s.canStoreKey || key.trim().length < 10}
              >
                Salvar chave
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={test.isPending}
                disabled={!s.configured}
                onClick={() => {
                  setMsg(null);
                  test.mutate(
                    { path: '/ai/settings/test' },
                    {
                      onSuccess: (r) =>
                        setMsg(
                          r.ok
                            ? { tone: 'success', text: 'Conexão com a OpenRouter funcionando.' }
                            : { tone: 'danger', text: r.error ?? 'Falha na conexão.' },
                        ),
                      onError: (err) => setMsg({ tone: 'danger', text: (err as Error).message }),
                    },
                  );
                }}
              >
                Testar conexão
              </Button>
              {s.configured && (
                <Button
                  type="button"
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => {
                    if (!window.confirm('Remover a chave? Os agentes deixarão de responder.'))
                      return;
                    setMsg(null);
                    remove.mutate(
                      { path: '/ai/settings', method: 'DELETE' },
                      { onSuccess: () => void settings.refetch() },
                    );
                  }}
                >
                  Remover chave
                </Button>
              )}
            </div>
            {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Regras fixas de todos os agentes</CardTitle>
          <CardDescription>Valem para qualquer persona e não podem ser desligadas.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>Não afirma ser humano quando perguntado diretamente.</li>
            <li>Não inventa preços, prazos, políticas ou informações.</li>
            <li>Não diz que fez algo (pagamento, envio, agendamento) sem confirmação real.</li>
            <li>Nunca pede senhas, códigos de verificação ou dados de cartão.</li>
            <li>Oferece atendimento humano quando não souber responder ou quando pedirem.</li>
            <li>Respostas começam em revisão humana; o modo automático é escolhido por agente.</li>
          </ul>
        </CardContent>
      </Card>
      <PaymentWebhookCard />
    </div>
  );
}
