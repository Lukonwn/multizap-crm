# Registro das fases

## Fase 1: Fundação, autenticação e design system ✅

**Entregue**

- Monorepo pnpm + Turborepo: `apps/{web,api,worker,gateway}` e `packages/{database,shared,ui,integrations}`.
- Schema Prisma completo (30 tabelas) com a migration inicial `prisma/migrations/*_init`.
- API Fastify com login, logout, sessão atual, troca de senha (obrigatória no primeiro acesso), listagem e revogação de sessões, rate limit, bloqueio por tentativas, CSRF, verificação de origem, cabeçalhos de segurança, auditoria, `/health` e `/health/ready`.
- Administrador inicial criado automaticamente a partir de `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`.
- Criptografia de credenciais AES-256-GCM com versionamento de chave (pronta para a Fase 2).
- Worker e gateway: inicialização, heartbeat no Redis, health check HTTP e encerramento gracioso.
- Design system "Dark Premium": tokens, botão, card, inputs, badge, stat card, modal, tabela, alertas, empty state e status.
- Painel: login, troca de senha obrigatória, shell com sidebar recolhível (preferência salva), topbar, Configurações (senha e sessões), System Health básico (estado real dos serviços) e telas dos demais módulos indicando a fase de entrega.
- Dockerfiles, `railway.json` por serviço e CI no GitHub Actions.

**Verificação**

- `pnpm typecheck`: 8/8 pacotes.
- `pnpm test`: 12 testes (shared) + 20 testes de integração da API com PostgreSQL e Redis reais.
- `pnpm build`: 4/4 apps.
- Fluxo de ponta a ponta no navegador (Playwright) sobre os builds de produção: redirecionamento sem sessão, login inválido, troca obrigatória de senha, política de senha, sessões, System Health com 5 serviços operacionais, sidebar persistente, logout e novo login.
- Passos do Dockerfile reproduzidos numa cópia limpa (install com lockfile congelado + build filtrado de cada app). O build da imagem em si não foi testado localmente: o Docker Hub recusou o download da imagem base (limite de requisições).

**Pendências conhecidas**

- Confirmar no primeiro deploy se a Railway reconheceu as chaves de `railway.json` (ver DEPLOY.md).

## Fase 2: Dashboard e conexões ✅

**Entregue**

- **Gateway** (`apps/gateway`) com Baileys 7.0.0-rc14:
  - `SessionManager`: pareamento por QR Code e por número de telefone (código de 8 caracteres emitido via protocolo do WhatsApp), restauração após reinícios, reconexão com backoff, tratamento de logout, sessão substituída e acesso recusado;
  - trava por instância no Redis;
  - credenciais e chaves de sinalização criptografadas no PostgreSQL (`DbAuthStore`);
  - fila de comandos BullMQ.
- **API:**
  - CRUD de instâncias, com limite de 10 garantido por trava transacional (testado com 13 requisições simultâneas);
  - pareamento (iniciar, consultar estado, cancelar), reconectar, desativar e reativar;
  - remover conexão e excluir instância, ambas com confirmação pelo nome;
  - histórico de eventos, notificações e resumo do dashboard;
  - auditoria de todas as ações.
- **Painel:**
  - lista de Conexões com cadastro (dispositivo conectado ou aparelho externo);
  - modal de pareamento: QR com contagem regressiva e instruções, alternativa "Conectar com número de telefone", estados de expirado, falha e sucesso;
  - detalhe da instância (conexão, recursos por fase, histórico, ações administrativas);
  - Dashboard com indicadores, distribuição de status, saúde das conexões, alertas e atividades recentes;
  - sino de notificações.
- O aparelho externo é exibido como "Apenas cadastrado": sem pareamento, sem envio, com atalho para o WhatsApp Web.

**Verificação**

- 85 testes: shared 19, gateway 24 (com conexão simulada + PostgreSQL e Redis reais), API 42.
- Gateway real em execução: o pareamento chegou ao Baileys, e a ausência de rede até o WhatsApp neste ambiente (`ENOTFOUND web.whatsapp.com`) foi registrada e exibida como falha, sem QR inventado.
- Verificação visual das telas de QR, código, sucesso, lista, detalhe, dashboard e notificações. O roteiro de teste escreveu os estados no Redis e no banco no lugar do gateway; esse roteiro não faz parte do produto.

**Decisões**

- ADR 0004: versão do Baileys e sincronização inicial de histórico mantida (exigência do Baileys 7 para os mapeamentos LID).

**Pendências conhecidas**

- **O pareamento real com um celular não pôde ser testado aqui** (sem rede até o WhatsApp). Validar no primeiro deploy: ler o QR, usar o código por número e reiniciar o gateway para confirmar a restauração.
- Credenciais ilegíveis (por exemplo, `CREDENTIALS_MASTER_KEY` trocada sem manter a versão anterior) levam a tentativas de reconexão sem notificação específica. O tratamento dedicado entra na Fase 9.

## Fase 3: Contatos e importações ✅

**Entregue**

- **Pacotes novos:**
  - `@multizap/storage`: Railway Bucket (S3, upload multipart em streaming) e driver local para desenvolvimento, com proteção contra path traversal;
  - `@multizap/files`: leitura de CSV, TXT e XLSX em streaming (detecção de UTF-8/Windows-1252, delimitador e cabeçalho) e escrita de CSV (BOM + `;` para Excel PT-BR) e XLSX.
- **API:**
  - contatos: cadastro, edição, exclusão, pesquisa, filtros e paginação;
  - etiquetas por instância;
  - consentimento (registrar e revogar), descadastrar e reverter descadastro;
  - histórico do contato;
  - exportação CSV/XLSX com filtros;
  - importações: upload, análise, prévia, confirmação, cancelamento e download dos rejeitados.
- **Worker:** análise e importação retomável, com notificação em caso de falha.
- **Painel:**
  - Contatos com seletor de instância;
  - detalhe do contato, etiquetas e modais de consentimento;
  - assistente de importação em 4 passos (as 10 etapas);
  - histórico de importações.
- Migration `contacts_imports`: estado `ANALYZING` e contadores de progresso.

**Verificação**

- 128 testes:
  - storage 3, files 10 (incluindo 200 mil linhas), shared 26, worker 8 (incluindo a retomada após queda simulada), gateway 24;
  - API 57: isolamento entre instâncias, fluxo de importação ponta a ponta e exportação.
- Navegador, com os builds de produção (API + worker reais):
  - importação de um XLSX com 5.000 linhas, resultando em 4.850 importados, 50 duplicados e 100 inválidos;
  - números conferidos no banco: consentimentos, etiquetas e descadastro;
  - reenvio do mesmo arquivo bloqueado.

**Correções feitas durante a verificação**

- A lista de contatos podia mostrar dados em cache depois de uma importação. Agora a conclusão invalida o cache e a lista recarrega ao abrir.

**Pendências conhecidas**

- O driver S3 não foi exercitado contra um bucket real neste ambiente (sem bucket disponível). Validar no deploy: enviar uma importação e baixar os rejeitados.
