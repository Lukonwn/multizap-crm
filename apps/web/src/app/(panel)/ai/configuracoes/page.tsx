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
import { useAiMutation, useAiSettings } from '@/lib/ai';

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
    </div>
  );
}
