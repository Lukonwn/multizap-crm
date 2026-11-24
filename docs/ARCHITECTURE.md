# Arquitetura

## Visão geral

```
                 ┌───────────────────────┐
  Navegador ───▶ │ multizap-web (Next.js) │  /api/* → proxy para a API interna
                 └───────────┬───────────┘  (mesmo domínio: cookies httpOnly + SameSite=Strict)
                             │ rede privada Railway
                 ┌───────────▼───────────┐        ┌────────────┐
                 │ multizap-api (Fastify) │◀──────▶│ PostgreSQL │
                 └───────────┬───────────┘        └────────────┘
                             │                    ┌────────────┐
           ┌─────────────────┼───────────────────▶│   Redis    │
           │                 │                    └────────────┘
┌──────────▼─────────┐  ┌────▼────────────────┐
│ multizap-worker    │  │ multizap-gateway    │  conexões WhatsApp (dispositivo conectado)
│ BullMQ             │  │ 1 dono por instância│
└────────┬───────────┘  └─────────────────────┘
         │
         ▼
 Railway Bucket (arquivos)  +  Bucket separado (backups)
```

## Serviços

| Serviço     | Responsabilidade                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **web**     | Interface. Não contém regra de negócio. O route handler `app/api/[...path]` repassa as chamadas para a API pela rede privada, então o navegador só conversa com um domínio.      |
| **api**     | REST, autenticação, autorização, validação (zod), auditoria. Aplica as migrations no pre-deploy.                                                                                 |
| **worker**  | Tarefas assíncronas: importações, ferramentas de arquivo, métricas, manutenção e backups.                                                                                        |
| **gateway** | Mantém as conexões WhatsApp. Uma trava no Redis garante um único dono por instância. As credenciais ficam criptografadas no PostgreSQL e são restauradas após qualquer reinício. |

## Princípios

1. **Isolamento por instância.** Todo dado operacional tem `account_id`. A posse é verificada no backend, e as restrições `UNIQUE (account_id, …)` impedem misturar bases.
2. **Persistência das conexões.** As credenciais de sessão (`integrations.credentials_enc` e `integration_keys`) ficam no banco com AES-256-GCM. Uma falha temporária leva a instância a `ATTENTION` e dispara reconexão; nada é apagado. O logout pelo WhatsApp leva a `NEEDS_REPAIR` com notificação. A remoção só acontece por ação manual.
3. **Nada simulado.** Os provedores declaram capacidades (`packages/integrations`). Uma ação sem suporte aparece como indisponível, e módulos de fases futuras indicam a fase.
4. **Campanhas assistidas.** O sistema prepara a fila (consentimento, sem opt-out, mesma instância), e cada envio é confirmado pelo administrador. Não há disparo automático em massa, randomização de intervalos nem rodízio de contas.
5. **Dados reais nos relatórios.** As métricas derivam de `message_events` e dos registros persistidos. O que não existe aparece como "—", nunca como zero inventado.

## Autenticação

- Senha com argon2id. Sessão com token aleatório de 256 bits em cookie `httpOnly`, `SameSite=Strict` e `Secure` em produção. O banco guarda só o SHA-256 do token.
- Expiração absoluta (`SESSION_TTL_HOURS`) e por inatividade (`SESSION_IDLE_HOURS`).
- CSRF double-submit vinculado à sessão: o cookie `mz_csrf` é enviado no cabeçalho `x-csrf-token`, e o hash fica salvo na sessão.
- Verificação de `Origin` e `Sec-Fetch-Site` em métodos que alteram estado.
- Bloqueio após 5 falhas (15 min) e limite de tentativas por IP.
- A troca de senha obrigatória no primeiro acesso bloqueia as demais rotas. Trocar a senha revoga todas as sessões.

## Modelo de dados

Definido em [`prisma/schema.prisma`](../prisma/schema.prisma), com 30 tabelas, todas com UUID. Grupos:

- **Administração:** `admin_users`, `admin_sessions`, `audit_logs`
- **Conexões:** `accounts`, `integrations`, `integration_keys`, `connection_events`
- **Contatos:** `contacts`, `tags`, `contact_tags`, `consent_events`, `opt_outs`
- **Arquivos:** `imports`, `import_rows`, `file_jobs`
- **Criativos:** `asset_folders`, `assets`, `asset_usages`
- **Campanhas:** `campaigns` (principal), `campaign_accounts` (filho por instância), `campaign_recipients`
- **Mensagens:** `conversations`, `messages`, `message_events`
- **Métricas:** `campaign_metrics`, `daily_metrics`
- **Sistema:** `system_notifications`, `system_events`, `system_settings`, `backups`

## Build

Os pacotes internos são consumidos como TypeScript. A API, o worker e o gateway são empacotados com tsup (o código `@multizap/*` é embutido e as dependências de terceiros ficam externas). O web usa `transpilePackages`. O pnpm usa `node-linker=hoisted` para que o Prisma Client gerado seja único no monorepo.

## Conexões WhatsApp (Fase 2)

```
Painel ──POST /accounts/:id/pairing──▶ API ──fila BullMQ "gateway-commands"──▶ Gateway ──WebSocket──▶ WhatsApp
   ▲                                    │                                         │
   └──GET /accounts/:id/pairing (1,5 s)─┴──── Redis: multizap:pairing:<id> ◀───────┤ QR / código / estado (efêmero, TTL 180 s)
                                                                                  └─▶ PostgreSQL: status, eventos, notificações,
                                                                                      credenciais criptografadas (durável)
```

- **Comandos** (`start-pairing`, `cancel-pairing`, `reconnect`, `stop`, `remove`) passam por uma fila persistente, então não se perdem se o gateway estiver reiniciando. A API devolve 503 se o gateway não estiver vivo (heartbeat), exceto ao remover conexão: nesse caso a própria API apaga as credenciais.
- **Estado efêmero do pareamento** (QR, código, expirado ou falha) fica no Redis. O painel consulta a cada 1,5 s enquanto o modal está aberto.
- **Estado durável** (status, motivo, histórico, notificações) fica no PostgreSQL e é gravado pelo gateway.
- **Credenciais da sessão:** `DbAuthStore` substitui o armazenamento em arquivo do Baileys. Grava `integrations.credentials_enc` e `integration_keys`, sempre com AES-256-GCM e AAD `account:<id>:…`.
- **Restauração:** `SessionManager.reconcile()` roda ao iniciar e a cada 30 s. Restaura toda instância pareada que não está desativada, não exige novo pareamento e não teve a sessão aberta em outro local.
- **Encerramento gracioso:** os sockets fecham **sem logout**, então as credenciais permanecem e a próxima versão restaura as sessões.

| Evento do WhatsApp                 | Resultado                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| QR lido / código confirmado        | `CONNECTED`, credenciais persistidas, `pairedAt` registrado                                                    |
| `restart required` (após parear)   | reabre imediatamente                                                                                           |
| Queda temporária (408/428/500/503) | `DISCONNECTED` → reconexão com backoff (2 s … 5 min). Após 3 falhas, `ATTENTION` + notificação. Nada é apagado |
| Logout (401) / mismatch (411)      | `NEEDS_REPAIR` + notificação. Sem reconexão automática. Credenciais mantidas até ação manual                   |
| Sessão substituída (440)           | `ATTENTION` + notificação. Reconexão só manual                                                                 |
| Acesso recusado (403)              | `ATTENTION` + notificação crítica. Reconexão só manual                                                         |
| QR expirado                        | `NOT_CONFIGURED` (`pairing_expired`)                                                                           |
