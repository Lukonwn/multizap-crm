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

## Contatos e importações (Fase 3)

**Isolamento.** Todas as rotas seguem o padrão `/accounts/:accountId/(contacts|tags|imports)/...`. Toda consulta usa o `accountId` do caminho, e um recurso de outra instância responde 404. O mesmo telefone pode existir em várias instâncias (`UNIQUE (account_id, phone_e164)`), sempre como registros independentes. Etiquetas também pertencem à instância.

**Consentimento e descadastramento.**

- `consent_events` registra cada autorização ou revogação, com origem e evidência.
- `opt_outs` bloqueia o telefone **por instância** e continua valendo depois que o contato é excluído ou reimportado.
- Reverter um descadastro exige um novo consentimento documentado.
- Uma importação nunca reativa um consentimento revogado.

**Importação (10 etapas):**

| Etapa                                      | Onde                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1–2. Arquivo e instância de destino        | `POST /accounts/:id/imports` (multipart, streaming até o bucket, SHA-256)                                         |
| 3. Detecção de colunas                     | `sniff`: codificação (UTF-8/Windows-1252), delimitador, cabeçalho, amostra                                        |
| 4. Mapeamento                              | painel → `POST …/analyze` (telefone, nome, etiquetas, observações, país, consentimento, política para existentes) |
| 5–8. Prévia, duplicados, inválidos, resumo | worker `analyze`: classifica **todas** as linhas em `import_rows` e gera o CSV de rejeitados. Nada é importado    |
| 9. Confirmação                             | `POST …/confirm`: transição atômica `ANALYZED → CONFIRMED`                                                        |
| 10. Importação                             | worker `run`: lotes transacionais de 500 linhas                                                                   |

- **Recuperação de falhas:** cada lote marca suas linhas como `IMPORTED` na mesma transação que cria os contatos. Uma queda ou nova tentativa (BullMQ, 3 tentativas com backoff) continua das linhas ainda `VALID`, sem duplicar.
- **Prevenção de importação duplicada:** um arquivo com o mesmo hash não pode ser reenviado para a mesma instância enquanto houver importação ativa ou concluída.
- **Validação estrutural apenas:** formato, DDD e tamanho, via libphonenumber. O sistema não consulta se o número tem conta WhatsApp.

## Ferramentas de processamento (Fase 4)

As ferramentas são independentes das instâncias: processam arquivos e não alteram a base de contatos.

```
Painel ──POST /tools/uploads──▶ API ──▶ bucket (tools/uploads/…) + metadados no Redis (24 h)
       ──POST /tools/jobs─────▶ API ──▶ file_jobs + fila "file-tools"
                                         │
                              worker ◀───┘ runTool() → saídas em disco temporário → bucket (tools/<job>/out/…)
       ──GET  /tools/jobs/:id (progresso, resumo) · GET …/outputs/:n (download)
```

| Ferramenta                 | Saídas                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| Conversor                  | arquivo no formato escolhido (CSV com BOM + `;`, ou XLSX)         |
| Divisor                    | partes com o cabeçalho repetido + ZIP                             |
| Comparador                 | só na A, só na B, em ambas (comparação pelo telefone normalizado) |
| Removedor de duplicados    | lista sem duplicados + relatório (linha, duplicada da linha)      |
| Extrator de telefones      | telefones encontrados em qualquer célula ou texto livre           |
| Organizador por DDD / país | um arquivo por grupo + arquivo com colunas DDD/UF ou país + ZIP   |
| Removedor de linhas vazias | lista sem linhas vazias                                           |
| Higienizador               | arquivo completo classificado, válidos (únicos) e rejeitados      |

- O pacote `@multizap/tools` contém funções puras (entrada → saídas) e é testado sem banco.
- Telefones são analisados com os metadados completos do libphonenumber (`/max`), que trazem tipo (celular ou fixo), país, DDD e UF.
- A validação é sempre **estrutural**: nenhuma ferramenta consulta o WhatsApp.
- O worker grava as saídas em disco temporário, o que permite dezenas de saídas simultâneas (por exemplo, uma por DDD) sem consumir memória. Depois envia os arquivos ao bucket e remove o diretório.

## Biblioteca de criativos (Fase 5)

- A biblioteca é **compartilhada entre as instâncias**: criativos não contêm dados de contatos. Organiza-se em pastas aninhadas, e uma pasta só pode ser excluída vazia.
- **Tipos:** imagem, banner, arquivo (MP4, MP3, OGG, PDF), texto, link e modelo de mensagem.
- **Segurança dos uploads:**
  - o tipo é identificado pela **assinatura do conteúdo** (`lib/mime.ts`); a extensão e o Content-Type do navegador são ignorados;
  - SVG não é aceito;
  - imagens são decodificadas pelo `sharp`, o que confirma a integridade, mede as dimensões e gera a miniatura WebP de 480 px;
  - os arquivos são servidos com `Content-Security-Policy: sandbox`, `nosniff` e `inline` apenas para mídia.
- **Duplicados:** um arquivo com o mesmo SHA-256 não é armazenado duas vezes.
- **Modelos:** variáveis `{{nome}}`, `{{primeiro_nome}}` e `{{telefone}}`, validadas na criação e na edição. `renderTemplate` (shared) será usado pelas campanhas. Textos são limitados a 4.096 caracteres.
- **Uso em campanhas:** `asset_usages` alimenta o histórico de utilização. Um criativo em campanha agendada ou ativa não pode ser excluído.
- **Armazenamento:** `assets/<id>/original.<ext>` e `assets/<id>/thumb.webp`, no bucket.

## Campanhas assistidas (Fase 6)

```
Construtor ──▶ rascunho (campaigns + campaign_accounts por instância, com filtro de etiquetas)
Agendar     ──▶ SCHEDULED: o worker verifica a cada minuto
Preparar    ──▶ worker monta campaign_recipients (somente elegíveis) → READY + notificação
Envio assistido: GET /campaigns/:id/next  →  administrador clica "Enviar"
                 POST …/recipients/:rid/send (confirmação atômica) → fila do gateway
                 gateway: reserva atômica (SENDING) → revalida → envia pela sessão → messages/message_events
WhatsApp ──ack──▶ gateway: enviada → entregue → lida (nunca retrocede) → recipient + message_events
```

**Regras invioláveis:**

- **Nenhum envio automático.** O agendamento só monta a fila. Cada mensagem exige um clique do administrador, registrado na auditoria (`campaign.message_confirmed`).
- **Elegibilidade:** consentimento `GRANTED`, sem `opted_out_at` e sem registro em `opt_outs`, conferida em três momentos: na preparação da fila, ao exibir o próximo destinatário (quem deixou de ser elegível é pulado automaticamente) e no gateway, imediatamente antes de enviar.
- **Isolamento:** cada campanha-filho usa só os contatos da própria instância. Aparelhos apenas cadastrados não podem participar.
- **Bloqueios de envio:** campanha pausada, cancelada ou agendada; instância desconectada; gateway fora do ar; pausa global (`system_settings.operations_paused`).
- **Sem envio duplicado:** a API só confirma um destinatário uma vez (`confirmedAt` atômico), e o gateway reserva o destinatário com `SENDING` antes de enviar. Um envio interrompido por reinício é marcado como falha "para conferir no celular", nunca repetido às cegas.
- **Sem simulação de comportamento humano**, randomização de intervalos ou rodízio de contas.

**Status:** `PENDING` → (confirmado) → `SENDING` → `SENT` → `DELIVERED` → `READ`, ou `FAILED`/`SKIPPED`. A conclusão é calculada por `refreshCampaignProgress` (pacote database).

## Central de mensagens (Fase 7)

```
WhatsApp ──▶ gateway (Baileys) ── normalizeMessage ──▶ InboxIngest ──▶ conversations / messages / contacts
                                                         └─ "SAIR" → opt_outs + consentimento revogado + notificação
Painel ──POST /conversations/:id/messages──▶ API (mensagem PENDING) ──fila──▶ gateway ReplySender ──▶ WhatsApp
```

- **O que entra:** só conversas individuais. Grupos, status, canais, reações e mensagens de protocolo são ignorados. Mensagens efêmeras e de visualização única são desembrulhadas. O endereçamento por LID usa o telefone alternativo (`remoteJidAlt`) quando o WhatsApp o informa.
- **Ao vivo** (`messages.upsert` notify): cria o contato (origem "mensagem recebida", consentimento pendente) quando o número ainda não existe na instância, marca a conversa como pendente e não lida, e baixa imagens até 10 MB para o bucket.
- **Histórico** entregue pelo WhatsApp ao parear (`messaging-history.set` e `append`): somente os últimos 30 dias. Não conta como não lido, não cria contatos e não dispara descadastramento.
- **Mensagens enviadas pelo celular** aparecem no histórico e marcam a conversa como respondida.
- **Sem duplicação:** a chave única `(account_id, provider_message_id)` e o tratamento do eco da própria sessão (`ReplySender` e `CampaignSender` fazem upsert e removem o rascunho) garantem um registro por mensagem.
- **Respostas** só quando a instância está conectada, as operações não estão pausadas e o contato não pediu descadastramento, a não ser que ele tenha escrito de novo depois do pedido.
- **Status das conversas:** `PENDING` (o contato escreveu), `ANSWERED` (houve resposta), `CLOSED` (finalizada pelo administrador; uma nova mensagem reabre), `OPEN` (vinda do histórico). "Não lidas" é um contador local, e o MultiZap não envia confirmação de leitura ao contato.

## Relatórios (Fase 8)

```
fontes (contacts, consent_events, opt_outs, campaigns, campaign_recipients, messages)
   └─ computeDailyMetrics (SQL, fuso REPORTS_TZ) ──▶ worker MetricsRollup (de hora em hora) ──▶ daily_metrics
API GET /reports/summary ── loadDailyMetrics: dias fechados de daily_metrics + hoje ao vivo ──▶ painel /relatorios
API GET /reports/export?format=csv|xlsx ──▶ uma linha por dia e instância + linha TOTAL
```

- **Somente dados registrados pelo MultiZap.** Nada é estimado; dias sem atividade aparecem com zero.
- **Dias** são contados no fuso `REPORTS_TZ` (padrão `America/Sao_Paulo`); os timestamps ficam em UTC no banco.
- **Definições:**
  - enviadas: saídas aceitas pelo WhatsApp (SENT, DELIVERED, READ), no dia do envio;
  - entregues e lidas: das enviadas naquele dia (coorte), então o número de um dia passado pode subir quando chegam confirmações;
  - falhas: destinatários de campanha com falha + respostas manuais com falha;
  - respostas: mensagens recebidas dos contatos; na tabela de campanhas, "respondeu" significa que o contato escreveu até 7 dias depois do envio.
- **Consolidação:** o worker grava em `daily_metrics` os últimos 7 dias fechados a cada hora (para capturar confirmações tardias) e, na inicialização, preenche lacunas dos últimos 400 dias. Se faltar qualquer dia consolidado num intervalo, a API calcula o intervalo inteiro ao vivo, então o resultado é sempre correto.
- **Comparação:** o período anterior tem a mesma duração e termina no dia anterior ao início.
- **Indicadores de base** (contatos, autorizados, descadastrados) são a situação atual, não do período.

## System Health, backups e segurança (Fase 9)

```
worker ── a cada minuto: Monitor (armazenamento, bucket de backup, gateway, backup atrasado) ──▶ system_notifications
       ── agenda diária (BACKUP_HOUR) ou fila "maintenance" (botão no painel) ──▶ BackupService ──▶ bucket de backup
       ── a cada 6 h: CleanupService (temporários vencidos)
gateway ── a cada minuto: verifica o heartbeat do worker
API GET /system/status ── banco, Redis, bucket, heartbeats, filas BullMQ, conexões, erros 24 h, notificações, backups, limpeza
```

- **Notificações** (`notify`/`resolveNotifications` em `@multizap/database`): falha de conexão, de processamento (importação, ferramenta, worker parado), de armazenamento, de integração (gateway parado, credenciais ilegíveis) e de backup. A `dedupe_key` evita repetição e permite a resolução automática.
- **Eventos do sistema** (`system_events`): falhas de jobs, comandos do gateway, backups, limpeza e pausa/retomada, mantidos por 30 dias.
- **Pausa global:** suspende envios de campanha (`/next` e o sender do gateway), respostas pela Central e o início de agendamentos. Uma faixa avisa em todas as telas.
- **Backups:** ver [ADR 0005](adr/0005-backups-e-monitoramento.md) e [DEPLOY](DEPLOY.md#backups-multizap-worker).
- **Limpeza:** resultados de ferramentas (7 dias), uploads sem uso (24 h), arquivos de importações encerradas (30 dias), sessões expiradas, eventos (30 dias) e notificações resolvidas (90 dias). Nunca remove contatos, conversas, campanhas, criativos, auditoria ou credenciais.
- **Auditoria:** consulta somente leitura em Configurações, com filtro por tipo de ação.

### Identidades, LID e fotos (correção pós-Fase 10)

O WhatsApp endereça muitas conversas por LID. O gateway guarda em `wa_identities` os nomes e a correspondência LID ↔ telefone que o aparelho recebe, aplica nome, telefone e contato (sem criar contatos do CRM) às conversas, une duplicadas e busca a foto de perfil das conversas existentes, devagar e em pequeno número. Detalhes e limites em [ADR 0006](adr/0006-identidades-whatsapp-e-lid.md).

### Nova conversa (Central de mensagens)

O botão **Nova conversa** abre a lista de contatos de uma instância (aba "Celular": a agenda que o WhatsApp entregou ao aparelho; aba "Contatos (CRM)") e, ao escolher um, abre ou cria a conversa individual (`POST /accounts/:id/conversations/start`). Não envia nada, não cria contato do CRM e não altera consentimento; cada mensagem é escrita e enviada pelo administrador, uma a uma, pelo mesmo caminho das respostas. Valem as mesmas regras: instância conectada, sem pausa geral e, para descadastrados (no CRM ou na lista de descadastros da instância), só com nova mensagem do contato. Conversas ainda sem mensagens não aparecem na lista.

## MultiZap AI

Agentes de IA para atendimento, num módulo próprio (menu "MultiZap AI"), sem alterar o restante do painel. Decisões e riscos em [ADR 0007](adr/0007-multizap-ai.md).

- **Pacote `@multizap/ai`:** cliente da OpenRouter (`/chat/completions` com uso e custo, `/models`, `/key`; erros traduzidos e chave mascarada) e montagem do prompt (regras fixas + persona + instruções do agente + memória/conhecimento quando houver).
- **API (`/ai/*`):** configuração da chave (criptografada), lista de modelos (cache de 1 h no Redis), personas (templates, duplicar, histórico), agentes (modelo, parâmetros, modo, instâncias, versões publicadas e restauração) e laboratório. Ações administrativas vão para a auditoria.
- **Laboratório:** conversa simulada com o rascunho ou com a versão publicada; mostra modelo, tokens, custo, tempo e as instruções enviadas. Não passa pelo gateway.
- **Tabelas:** `ai_credentials`, `ai_personas`, `ai_persona_revisions`, `ai_agents`, `ai_agent_versions`, `ai_agent_accounts`, `ai_test_sessions`, `ai_test_messages`, `ai_token_usage`, `ai_agent_events`.
- **Atendimento real (Entrega 2):** gateway enfileira a mensagem ao vivo (`ai-inbound`, com espera de 6 s) → worker (`AiResponder`) aplica as regras de segurança, gera a resposta com a versão publicada e entrega como rascunho (revisão humana) ou envia (automático) pelo gateway. Tabelas: `ai_conversation_states` (pausa, liberação, memória), `ai_drafts` (uma resposta por mensagem), `ai_message_links` (mensagens enviadas pela IA). Telas: Atendimentos (rascunhos, pausar/retomar por conversa) e controles de ativação, envio e consumo na tela do agente. Detalhes e regras em [ADR 0007](adr/0007-multizap-ai.md).
- **Base de conhecimento (Entrega 3):** fontes (texto, pergunta e resposta, arquivo, link) → fila `ai-knowledge` → worker (`KnowledgeProcessor`: leitura de PDF/DOCX/TXT, busca de página protegida contra SSRF, divisão em trechos) → `ai_knowledge_chunks`. Busca por índice de texto do PostgreSQL em português; cada agente liga as fontes que usa (`ai_agent_knowledge`). Os trechos entram no prompt do laboratório e do atendimento real e ficam registrados em `ai_drafts.sources`. Detalhes e limites em [ADR 0007](adr/0007-multizap-ai.md).
- **Próximas entregas:** entregáveis e métricas.
