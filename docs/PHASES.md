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

## Fase 4: Ferramentas de processamento ✅

**Entregue**

- **Pacote `@multizap/tools`, com 9 ferramentas:**
  - conversor CSV/TXT/XLSX;
  - divisor (por linhas ou em N partes);
  - comparador de listas;
  - removedor de duplicados (pelo telefone ou pela linha inteira);
  - extrator de telefones;
  - organizadores por DDD e por país;
  - removedor de linhas vazias;
  - higienizador: normalização, validação estrutural, DDD e UF, código internacional, tipo, duplicados, incompletos e classificação.
- **Worker:** fila `file-tools`, progresso por bytes lidos, ZIP automático para saídas múltiplas e notificação em caso de falha.
- **API:** envio com prévia (cabeçalho e coluna de telefone sugeridos), criação, consulta, download e exclusão de processamentos, com validação de parâmetros por ferramenta.
- **Painel:**
  - central de ferramentas, com atalhos para o importador e o exportador de contatos;
  - tela de execução com prévia do arquivo, seleção de coluna e cabeçalho, opções da ferramenta, progresso, resumo (indicadores e distribuições) e downloads;
  - processamentos recentes.

**Verificação**

- 150 testes, incluindo 14 das ferramentas, 4 do processador no worker e 4 da API.
- Navegador, com os builds de produção e uma planilha de 5.000 linhas:
  - higienizador: 4.850 válidos, 50 duplicados e 100 incompletos; o XLSX de válidos foi aberto e conferido;
  - organizador por DDD: ZIP válido;
  - comparador: 1 número em ambas, 2 só na B e 4.899 só na A;
  - conversor XLSX → CSV: 5.001 linhas, com BOM.

**Correções feitas durante a verificação**

- Os indicadores e as distribuições apareciam fora de ordem, porque o `jsonb` do PostgreSQL não preserva a ordem das chaves. Agora a tela ordena os indicadores e as barras.

**Pendências conhecidas**

- Arquivos enviados para as ferramentas e não usados, e resultados antigos, permanecem no bucket. A limpeza automática (retenção configurável) entra na Fase 9.

## Fase 5: Biblioteca de criativos ✅

**Entregue**

- **API:**
  - pastas aninhadas: criar, renomear, mover com proteção contra ciclos, excluir só quando vazia;
  - upload de imagens, banners e arquivos, com tipo identificado pelo conteúdo, dimensões, miniatura, SHA-256 e bloqueio de duplicados;
  - textos, links (somente http/https) e modelos com variáveis validadas;
  - pesquisa por nome, conteúdo e endereço; filtros por pasta e tipo;
  - edição revalidada conforme o tipo;
  - exclusão que remove os arquivos do bucket, bloqueada se o criativo estiver em campanha ativa;
  - histórico de utilização;
  - arquivos servidos com cabeçalhos de segurança.
- **Painel:**
  - biblioteca com árvore de pastas, filtros, pesquisa e grade com miniaturas;
  - envio de vários arquivos com progresso;
  - editor de texto, link e modelo com inserção de variáveis e pré-visualização;
  - detalhe com visualização (imagem, vídeo, áudio), metadados, mover entre pastas, download, histórico de uso e exclusão.

**Verificação**

- 161 testes, 11 deles da biblioteca. Incluem: executável disfarçado de PNG, SVG com script, imagem corrompida, PDF com extensão errada, duplicado, variável inexistente, link `javascript:`, ciclo de pastas e exclusão com remoção do arquivo.
- Navegador, com os builds de produção:
  - pastas e subpastas, envio de 3 imagens (JPEG, PNG, WebP) com miniaturas;
  - duplicado identificado;
  - modelo com variável e pré-visualização;
  - link inseguro recusado;
  - pesquisa por conteúdo e filtro por tipo;
  - dimensões 1200 × 628 registradas;
  - **miniatura carregada do armazenamento depois de reiniciar a API**.

**Ajuste feito durante a verificação**

- As miniaturas de banners largos apareciam cortadas no card. Agora a imagem é exibida inteira.

## Fase 6: Campanhas assistidas ✅

**Entregue**

- **Construtor:**
  - nome, texto com variáveis ou modelo da biblioteca, link, imagem da biblioteca;
  - campanha multicontas, com filtro de etiquetas por instância;
  - público elegível calculado por instância, mostrando os excluídos;
  - pré-visualização com um contato real;
  - rascunhos, edição e duplicação.
- **Agendamento e controle:**
  - agendamento que monta a fila no horário, com notificação;
  - "Preparar fila agora";
  - calendário mensal;
  - pausa, retomada e cancelamento;
  - histórico de ações.
- **Envio assistido:**
  - próximo destinatário com a mensagem personalizada;
  - "Enviar" (um clique por mensagem) ou "Pular";
  - últimos envios com o status real do WhatsApp;
  - tentar novamente envios com falha.
- **Gateway:**
  - envio pela sessão da instância (texto ou imagem com legenda);
  - registro em conversas, mensagens e eventos;
  - confirmações de entrega e leitura;
  - reserva atômica contra envio duplicado;
  - recuperação de envios interrompidos.
- **Worker:** preparação da fila (somente elegíveis) e verificação de agendamentos a cada minuto.
- Migration `recipient_sending`: status `SENDING`.

**Verificação**

- 184 testes: gateway 32, worker 16, API 83, entre outros. Cobrem:
  - nunca enviar sem confirmação;
  - revalidação de consentimento e descadastro no envio;
  - pausa da campanha e pausa global;
  - instância desconectada;
  - envio concorrente do mesmo destinatário (que revelou e corrigiu um risco de envio duplicado);
  - confirmações que nunca retrocedem.
- Navegador, com os builds de produção (API, worker, web) e o código real do gateway com uma conexão WhatsApp **simulada** (o ambiente não alcança o WhatsApp):
  - público de 3 elegíveis entre 4 (o descadastrado ficou fora);
  - fila preparada pelo worker;
  - 2 envios confirmados, ambos com imagem, e 1 pulado;
  - confirmações de leitura refletidas;
  - campanha concluída;
  - cópia agendada sem nenhum envio;
  - calendário.

**Correções feitas durante a verificação**

- **Risco de envio duplicado com jobs concorrentes:** corrigido com reserva atômica (`SENDING`).
- **Ordem da fila e das instâncias não determinística:** agora é por nome.
- **Detalhe da campanha concluída deixava de atualizar as confirmações de leitura:** agora continua atualizando.

**Pendências conhecidas**

- **O envio real pelo WhatsApp não pôde ser testado aqui.** Validar no deploy com um número de teste próprio.
- O canal de dispositivo conectado não exige modelos aprovados; o suporte a modelos aprovados só se aplicaria a um canal oficial, que não está em uso.

## Fase 7: Central de mensagens ✅

**Entregue**

- **Gateway:**
  - normalização das mensagens do Baileys (texto, imagem, vídeo, áudio, documento, figurinha, localização, contato; LID → telefone);
  - registro das mensagens recebidas e do histórico recente (30 dias);
  - download de imagens;
  - descadastramento por palavra-chave (SAIR, PARAR, STOP, CANCELAR, DESCADASTRAR, REMOVER);
  - envio de respostas com tratamento do eco.
- **API:**
  - conversas de todas as instâncias, com filtros (todas, não lidas, pendentes, respondidas, finalizadas), pesquisa e instância;
  - histórico paginado;
  - dados do contato;
  - permissão de resposta;
  - responder, marcar como lida, finalizar e reabrir;
  - mídia;
  - contador de não lidas.
- **Painel:**
  - Central em três colunas: lista com identificação da instância, histórico com status do canal e composição de resposta, dados do contato (origem, consentimento, etiquetas e observações editáveis);
  - contador de não lidas no menu.

**Verificação**

- 203 testes: gateway 45 (normalização, histórico, "SAIR", eco sem duplicação, falhas de envio) e API 89 (filtros, paginação, bloqueios de resposta), entre outros.
- Navegador, com os builds de produção e o código real do gateway com conexão WhatsApp **simulada** (o ambiente não alcança o WhatsApp):
  - mensagens recebidas criam o contato e a conversa;
  - imagem recebida exibida;
  - campanha e resposta do contato no mesmo histórico;
  - resposta enviada evolui para "Lida", com um único registro mesmo com o eco;
  - "Sair" descadastra e bloqueia a resposta;
  - conversa finalizada aparece no filtro "Finalizadas".

**Correção feita durante a verificação**

- O cabeçalho da conversa não atualizava o status ("Respondida") logo após a resposta.

**Pendências conhecidas**

- **Recebimento real não testado aqui** (sem rede até o WhatsApp). Validar no deploy: enviar uma mensagem de outro celular para o número conectado e responder pelo painel.
- Vídeos, áudios e documentos recebidos aparecem identificados pelo tipo; apenas imagens são baixadas.

## Fase 8: Relatórios ✅

**Entregue**

- **Banco:** `computeDailyMetrics` calcula por dia e instância, no fuso `REPORTS_TZ`, a partir das tabelas de origem: contatos, consentimentos, descadastros, campanhas criadas e concluídas, mensagens enviadas, entregues, lidas, falhas e respostas recebidas.
- **Worker:** `MetricsRollup` consolida em `daily_metrics` os últimos 7 dias fechados a cada hora e preenche lacunas na inicialização. O dia de hoje é sempre calculado ao vivo.
- **API:**
  - `GET /reports/summary`: totais, período anterior de mesma duração, situação atual da base, série diária, totais por instância e campanhas com envios no período (taxas de entrega, leitura, resposta e falha);
  - `GET /reports/export`: CSV (`;`, UTF-8 com BOM) ou XLSX, uma linha por dia e instância, mais o total.
- **Painel `/relatorios`:**
  - período (7, 30 ou 90 dias, este mês, personalizado) e filtro por instância;
  - indicadores com variação em relação ao período anterior;
  - gráfico de linhas por dia (enviadas, entregues, lidas, respostas) com legenda, rótulos diretos, dica ao passar o mouse e alternativa em tabela;
  - tabelas por instância e por campanha;
  - exportação CSV e XLSX.

**Verificação**

- Testes de API (fuso: 02:30 UTC conta no dia anterior em São Paulo; período anterior; resposta de campanha; filtro por instância; consolidado igual ao cálculo ao vivo; validação; conteúdo exato do CSV e do XLSX) e do worker (consolidação, recálculo, preenchimento de lacunas).
- Navegador com os builds de produção.

**Decisões**

- Entregues e lidas são contadas sobre as mensagens enviadas em cada dia (coorte). Assim, as taxas nunca passam de 100%, e um dia passado pode subir quando chegam confirmações tardias.
- "Contatos", "autorizados" e "descadastrados" do topo mostram a situação atual. O período mostra os novos cadastros e os descadastros.
