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

## Fase 9: System Health e segurança ✅

**Entregue**

- **System Health** com dados reais:
  - API, PostgreSQL, Redis, armazenamento, worker e gateway;
  - filas BullMQ (aguardando, em execução, agendados, falhas);
  - conexões por situação e instâncias com problema;
  - erros das últimas 24 horas;
  - notificações abertas, com opção de resolver;
  - backups e limpeza automática;
  - eventos do sistema com filtro.
- **Pausa global:** suspende envios de campanha, respostas pela Central e o início de agendamentos. Pede confirmação e aceita um motivo. Uma faixa avisa em todas as telas. Pausa e retomada ficam na auditoria.
- **Notificações automáticas, sem duplicar e resolvidas sozinhas quando o problema some:**
  - armazenamento indisponível;
  - gateway parado (vigiado pelo worker) e worker parado (vigiado pelo gateway);
  - bucket de backup inacessível, falha de backup e backup atrasado;
  - credenciais ilegíveis;
  - configuração de backup inválida ou ausente em produção.
- **Backups:**
  - diários (horário configurável) e manuais, em um bucket separado;
  - criptografados com AES-256-GCM;
  - banco inteiro em snapshot consistente;
  - arquivos de criativos e mídias em espelho incremental;
  - retenção configurável, mantendo sempre os 3 mais recentes.
- **Restauração** pela linha de comando (`node apps/worker/dist/restore.js`). Confere a chave e as migrations, recusa um banco com dados (a não ser com `--force`) e roda em uma única transação.
- **Limpeza automática** de resultados de ferramentas, uploads sem uso, arquivos de importações encerradas, sessões expiradas, eventos e notificações antigas.
- **Segurança:**
  - registro de auditoria consultável em Configurações;
  - credenciais ilegíveis (chave trocada) suspendem a reconexão sem apagar nada;
  - recriptografia em lote para a rotação da chave (`node apps/gateway/dist/reencrypt-cli.js`).

**Verificação**

- 235 testes, com 31 novos:
  - backup, perda total de banco e arquivos, e restauração idêntica, comparando todas as linhas de todas as tabelas (inclui bytea, jsonb, arrays, acentos, tabulações e barras);
  - recusa de chave diferente, de migrations divergentes e de banco com dados;
  - arquivo adulterado;
  - retenção e limpeza do espelho;
  - agenda no fuso;
  - limpeza;
  - monitoramento;
  - pausa;
  - rotação de chave;
  - credenciais ilegíveis.
- Navegador com os builds de produção:
  - backup automático e manual concluídos;
  - pausa com motivo, faixa em outra tela, retomada;
  - auditoria filtrada.
- Restauração real com o comando compilado em um banco novo: contagens iguais e 42 arquivos restaurados.

**Pendências conhecidas**

- Bucket S3 real não testado aqui; os testes usam o driver local. Validar no deploy com "Fazer backup agora" e `restore.js --list`.
- O backup do banco é lógico (`COPY`), restaurável apenas na mesma versão das migrations (ver ADR 0005).

## Fase 10: Testes, documentação e produção ✅

**Problema grave encontrado e corrigido**

- A regra `storage/` do `.gitignore`, pensada para a pasta local de arquivos, também ignorava o pacote `packages/storage`. Ele nunca tinha sido versionado. Um clone limpo do repositório (e, portanto, qualquer deploy na Railway) não compilava a API, o worker nem o gateway desde a Fase 3. Os testes locais passavam porque os arquivos existiam no disco.
- O CI estava vermelho desde a Fase 3: parava no primeiro passo (formatação), e os demais nunca rodavam no GitHub.
- Correção: `.gitignore` restrito às pastas de dados; pacote versionado; formatação aplicada; pipeline reproduzido em um clone limpo, com banco novo, antes do push. O CI está verde desde então.

**Entregue**

- **CI completo a cada push:** formatação, tipos, 235 testes com PostgreSQL e Redis reais, build e 11 testes de ponta a ponta no navegador.
- **Testes de ponta a ponta** (`tests/e2e`, Playwright) contra os builds reais da API, do worker e do painel:
  - proteção de rotas e da API;
  - primeiro acesso com troca de senha;
  - todas as telas, no computador e no celular, sem rolagem lateral;
  - cadastro de instância e de contato com consentimento;
  - higienizador com download;
  - pausa global;
  - backup manual;
  - relatórios com exportação;
  - auditoria;
  - logout;
  - ausência de erros de JavaScript.
- **Celular:**
  - menu em gaveta;
  - Central em uma coluna, com "Voltar";
  - cabeçalhos que quebram linha;
  - nenhuma das 17 telas com rolagem lateral em 390 px.
- **Revisão de segurança:**
  - cabeçalhos, com HSTS adicionado;
  - rotas internas inalcançáveis pelo proxy;
  - CSRF e origem;
  - histórico do Git sem segredos;
  - dependências: `sharp` e `csv-parse` atualizados, os demais alertas avaliados e documentados.
- **Documentação:**
  - critérios de aceitação com evidências ([ACCEPTANCE.md](ACCEPTANCE.md));
  - roteiro de validação do primeiro deploy ([DEPLOY.md](DEPLOY.md#validações-do-primeiro-deploy));
  - revisão de segurança ([SECURITY.md](SECURITY.md)).
- Teste do gateway que dependia de dois comandos caírem no mesmo milissegundo, e falhava só no CI, reescrito com horários explícitos.

**Pendências (validação no primeiro deploy)**

- WhatsApp real (pareamento, envio, recebimento, restauração da sessão), Railway Bucket real e a configuração da Railway. Roteiro de 11 passos em DEPLOY.md.

## Correção após o primeiro teste real: identificação das conversas ✅

**Problema** (primeiro pareamento com um número real): a Central mostrava "Contato sem número identificado", sem nome nem foto, e mensagens como "não suportada". A simulação dos testes só usava conversas por telefone; o WhatsApp real usa LID.

**Corrigido**

- Diretório de identidades com nome da agenda, nome de perfil e LID ↔ telefone; conversas passam a mostrar nome e telefone, e conversas duplicadas são unidas.
- Fotos de perfil das conversas existentes, com limite de consultas.
- Mais tipos de mensagem reconhecidos; tipo desconhecido mostra o nome técnico e gera evento.
- 20 testes novos (identidades, união de conversas, isolamento por instância, fotos, tipos de mensagem, rota da foto).

**Pendências**

- Depende do que o WhatsApp entrega ao aparelho. Quem já estava vinculado pode precisar parear de novo para receber os nomes da agenda. Validar com o número real.

## Correção: mensagens de empresa, mensagens pendentes e áudios ✅

**Problema** (teste real): áudios apareciam só como "[Áudio]", modelos de empresa como "(templateMessage)" e algumas mensagens como "(placeholderMessage)".

**Corrigido**

- Modelos, mensagens interativas, botões e listas mostram o texto, o título, o rodapé e os botões.
- O marcador "placeholder" é substituído pelo conteúdo real quando o celular o reenvia (mesmo ID), sem duplicar mensagens.
- Áudios são guardados e tocados na Central (histórico em fila em segundo plano).
- 12 testes novos.

**Pendências**

- Mensagens já gravadas só são atualizadas quando o WhatsApp as entrega de novo.
- Vídeos, documentos e figurinhas continuam só identificados.

## Nova conversa na Central de mensagens ✅

- Botão **Nova conversa**, como no WhatsApp Web: escolhe a instância, vê os contatos do celular (ou do CRM), pesquisa e abre a conversa individual para escrever e enviar sem campanha.
- Um envio por vez, sem seleção múltipla. Regras mantidas: instância conectada, pausa geral e descadastrados (agora também pela lista de descadastros da instância).
- Auditoria da conversa iniciada; conversas vazias não poluem a lista.
- 6 testes de API e 1 de ponta a ponta.

## Diagnóstico da agenda do celular ✅

**Problema** (teste real): "Nova conversa" listava só as pessoas que já tinham conversa; a agenda do celular não chegou. Pista: no primeiro pareamento a sincronização do estado do aplicativo ficou "parada esperando a chave" do celular.

**Entregue**

- O gateway registra no System Health cada etapa da sincronização da agenda ("Agenda (instância): …"), sem depender do log da hospedagem, e o número de contatos entregues.
- Se a agenda ficar parada, o gateway pede nova sincronização (1,5, 6 e 20 minutos), usando só o recurso oficial da biblioteca.
- 7 testes novos.

**Pendências**

- A causa real só aparece com um novo pareamento com esta versão. Se o celular nunca enviar a chave, avaliar alternativas com os eventos em mãos.

## Nova conversa por número digitado ✅

- No campo de pesquisa da **Nova conversa**, um telefone digitado (com DDD ou +país) vira a opção "Conversar com +55…", como no WhatsApp Web, mesmo fora da agenda. Só abre a conversa: nada é enviado, nenhum contato é criado e o sistema não consulta se o número tem WhatsApp.
- Conclusão do teste real da agenda: o WhatsApp não entregou a agenda inteira ao aparelho conectado (ver ADR 0006, item 13).
- 1 teste de ponta a ponta novo (13 no total).

## MultiZap AI: Entrega 1 (fundação e laboratório) ✅

- Item **MultiZap AI** no menu, com Agentes, Personas, Laboratório e Configurações. Nenhuma tela existente mudou.
- Chave da OpenRouter salva criptografada no servidor, teste de conexão e pesquisa de modelos com preço por 1 milhão de tokens.
- Personas: criar, editar, duplicar, salvar como template, criar a partir de template, histórico de alterações e exclusão com confirmação (bloqueada se estiver em uso).
- Agentes: persona, modelo, temperatura, limite de tokens, instruções, memória, modo (revisão humana por padrão), instâncias (um agente ativo por instância), publicação de versões e restauração.
- Laboratório: conversa simulada com o rascunho ou a versão publicada, com tokens, custo, tempo e prompt; nada é enviado.
- Backup e restauração cobrem as tabelas novas (chave adiável entre agente e versão publicada).
- Testes: 10 do pacote `@multizap/ai`, 13 de API e 1 de ponta a ponta novos (14 no total).
- A ativação no WhatsApp fica desabilitada e identificada até a Entrega 2.

## MultiZap AI: Entrega 2 (atendimento real) ✅

- **Ativar e pausar** agentes por instância (um agente ativo por instância; exige versão publicada, instância e chave da OpenRouter).
- **Respostas às mensagens recebidas** pelo worker: revisão humana (padrão) ou automático, por um interruptor na tela do agente que vale na hora (sem publicar) e pede confirmação ao ligar o automático.
- **Atendimentos** (nova aba em MultiZap AI): conversas atendidas pela IA, rascunhos para aprovar/editar/descartar, pausar e retomar a IA por conversa, liberar contato de campanha e ver o motivo quando a IA não responde.
- **Pessoa assume:** responder pela Central (ou pelo celular) pausa a IA naquela conversa.
- **Segurança:** campanha recente (7 dias), descadastro, pausa global, grupos, limites por hora, uma resposta por mensagem, só a mensagem mais recente responde.
- **Envio:** intervalo mínimo fixo e "digitando…" somente durante a geração real; sem atraso aleatório e sem "gravando áudio".
- **Memória por contato** e **consumo real** (tokens e custo por agente e instância).
- Novas tabelas `ai_conversation_states`, `ai_drafts` e `ai_message_links`; migração reversível.
- Testes: 17 do respondedor (worker), 10 de rotas e 4 do gateway; 14 de ponta a ponta.
- Passo de implantação: `CREDENTIALS_MASTER_KEY` também no **multizap-worker**.

## MultiZap AI: Entrega 3 (base de conhecimento) ✅

- Nova aba **Conhecimento**: adicionar textos, perguntas e respostas, arquivos (PDF, DOCX, TXT, MD, CSV) e links; ver a situação (na fila, processando, pronta, com erro), ver os trechos, editar, desligar, reprocessar e excluir (com confirmação).
- **Por agente:** cartão "Conhecimento" na tela do agente escolhe as fontes que ele usa (vale na hora).
- **Busca** por texto em português (PostgreSQL), sem serviço novo. O agente usa os trechos relevantes e, quando a base não tem a resposta, é instruído a não inventar e oferecer um atendente.
- **Transparência:** o laboratório mostra os trechos usados; Atendimentos mostra "Baseada em…" em cada rascunho.
- **Segurança:** leitura de links protegida contra acesso à rede interna (SSRF), com limites de tamanho, tempo e redirecionamentos; arquivos só no bucket.
- Nova fila `ai-knowledge` no worker e migração reversível `20261127120000_ai_knowledge` (só tabelas novas).
- Testes: 8 do pacote de IA, 17 do processamento, SSRF e busca, 5 do atendimento com base, 11 de rotas; 14 de ponta a ponta.
- Passo de implantação: nenhuma variável nova. O worker precisa continuar com `CREDENTIALS_MASTER_KEY`.
