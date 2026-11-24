# Deploy na Railway

## Serviços

Crie um projeto na Railway conectado a este repositório GitHub, com:

| Serviço            | Origem                    | Config file path            |
| ------------------ | ------------------------- | --------------------------- |
| `multizap-web`     | Repositório (raiz)        | `apps/web/railway.json`     |
| `multizap-api`     | Repositório (raiz)        | `apps/api/railway.json`     |
| `multizap-worker`  | Repositório (raiz)        | `apps/worker/railway.json`  |
| `multizap-gateway` | Repositório (raiz)        | `apps/gateway/railway.json` |
| `Postgres`         | Template PostgreSQL       | —                           |
| `Redis`            | Template Redis            | —                           |
| Bucket de arquivos | Railway Bucket            | — (Fase 3)                  |
| Bucket de backups  | Railway Bucket (separado) | — (Fase 9)                  |

> O **Root Directory** de todos os serviços de app deve ser a **raiz do repositório**, porque o build precisa dos pacotes compartilhados. Em _Settings → Config-as-code_, aponte o caminho do `railway.json` de cada app.

> Se o painel da Railway não oferecer o campo **Config file path**, copie à mão os valores de cada `railway.json` (Dockerfile, health check, _watch paths_, política de reinício, `overlapSeconds`/`drainingSeconds` do gateway e o **pre-deploy command** da API) nas configurações do serviço. Confira principalmente o pre-deploy da API: é ele que aplica as migrations.

Cada `railway.json` define o Dockerfile, os _watch paths_ (um deploy só refaz o serviço afetado), o health check e a política de reinício. A API executa `prisma migrate deploy` como **pre-deploy command**.

> ⚠️ A documentação da Railway não estava acessível no ambiente de desenvolvimento. As chaves de `railway.json` (`preDeployCommand`, `overlapSeconds`, `drainingSeconds`) seguem o formato conhecido de config-as-code. Confira no painel, no primeiro deploy, se foram reconhecidas. Se não forem, configure os mesmos valores em _Settings_.

## Variáveis de ambiente

Use referências de variável da Railway (`${{Serviço.VAR}}`) sempre que possível.

### multizap-api

| Variável                  | Valor                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                | `production`                                                                                                               |
| `DATABASE_URL`            | `${{Postgres.DATABASE_URL}}`                                                                                               |
| `REDIS_URL`               | `${{Redis.REDIS_URL}}`                                                                                                     |
| `WEB_ORIGIN`              | URL pública do painel, ex. `https://multizap-web-production.up.railway.app`                                                |
| `PORT`                    | `4000` (fixa a porta: o painel acessa a API em `:4000` pela rede privada)                                                  |
| `CREDENTIALS_MASTER_KEY`  | 32 bytes em base64 (ver abaixo). **Guarde uma cópia fora da Railway**: sem ela, as credenciais salvas não podem ser lidas. |
| `CREDENTIALS_KEY_VERSION` | `1`                                                                                                                        |
| `INTERNAL_API_TOKEN`      | String aleatória com 32 caracteres ou mais                                                                                 |
| `ADMIN_EMAIL`             | E-mail do administrador                                                                                                    |
| `REPORTS_TZ`              | Opcional. Fuso dos relatórios, padrão `America/Sao_Paulo` (o mesmo no worker)                                              |
| `ADMIN_INITIAL_PASSWORD`  | Senha inicial (troca obrigatória no 1º login; pode ser removida depois)                                                    |

### multizap-web

| Variável           | Valor                                                  |
| ------------------ | ------------------------------------------------------ |
| `API_INTERNAL_URL` | `http://${{multizap-api.RAILWAY_PRIVATE_DOMAIN}}:4000` |

### multizap-worker e multizap-gateway

| Variável                  | Valor                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `NODE_ENV`                | `production`                                                          |
| `DATABASE_URL`            | `${{Postgres.DATABASE_URL}}`                                          |
| `REDIS_URL`               | `${{Redis.REDIS_URL}}`                                                |
| `CREDENTIALS_MASTER_KEY`  | a mesma da API (somente gateway, a partir da Fase 2)                  |
| `CREDENTIALS_KEY_VERSION` | `1`                                                                   |
| `REPORTS_TZ`              | opcional, padrão `America/Sao_Paulo` (somente worker; o mesmo da API) |

Defina também `PORT=8080` no worker e no gateway: o servidor de health check só sobe quando `PORT` está definida.

O worker também precisa das variáveis `STORAGE_*` e, para os backups, das variáveis da seção [Backups](#backups-multizap-worker).

Gerar chaves:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Armazenamento (multizap-api e multizap-worker)

Crie um **Railway Bucket** para os arquivos e configure **nos dois serviços**:

| Variável                                                    | Valor                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `STORAGE_DRIVER`                                            | `s3`                                                                |
| `STORAGE_S3_ENDPOINT`                                       | endpoint do bucket (variável de referência do Bucket na Railway)    |
| `STORAGE_S3_REGION`                                         | região do bucket (ou `auto`)                                        |
| `STORAGE_S3_BUCKET`                                         | nome do bucket                                                      |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | credenciais do bucket                                               |
| `STORAGE_S3_FORCE_PATH_STYLE`                               | `true` se o endpoint exigir _path-style_ (confira na aba do Bucket) |
| `MAX_IMPORT_MB`                                             | `100` (apenas API; opcional)                                        |

O **multizap-gateway** também precisa das variáveis `STORAGE_*`, para enviar as imagens das campanhas.

Em produção, a API e o worker **recusam iniciar** com armazenamento local, porque o disco do container é apagado a cada deploy. O `/health/ready` da API inclui a verificação do bucket.

## Backups (multizap-worker)

Os backups vão para um **segundo Railway Bucket**, separado do bucket de arquivos. Assim, um problema ou uma exclusão no bucket principal não leva os backups junto.

1. Crie outro Bucket na Railway (ex.: `multizap-backups`).
2. Configure no **multizap-worker**:

| Variável                                                  | Valor                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BACKUP_S3_ENDPOINT`                                      | endpoint do bucket de backup                                                             |
| `BACKUP_S3_REGION`                                        | região (ou `auto`)                                                                       |
| `BACKUP_S3_BUCKET`                                        | nome do bucket de backup (precisa ser diferente de `STORAGE_S3_BUCKET`)                  |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | credenciais do bucket de backup                                                          |
| `BACKUP_S3_FORCE_PATH_STYLE`                              | `true` se o endpoint exigir _path-style_                                                 |
| `BACKUP_ENCRYPTION_KEY`                                   | 32 bytes em base64. **Guarde uma cópia fora da Railway**: sem ela, os backups não abrem. |
| `BACKUP_HOUR`                                             | hora local do backup diário (padrão `3`, no fuso `REPORTS_TZ`)                           |
| `BACKUP_RETENTION_DAYS`                                   | dias de retenção (padrão `14`; os 3 backups mais recentes são sempre mantidos)           |
| `TOOL_RETENTION_DAYS` / `IMPORT_FILE_RETENTION_DAYS`      | opcional: retenção dos arquivos temporários (padrão `7` e `30` dias)                     |

**O que entra no backup:** todas as tabelas do banco, num instante consistente (uma única transação), e os arquivos da biblioteca de criativos e das imagens recebidas. Tudo é criptografado (AES-256-GCM) antes de sair do worker. Os arquivos são copiados de forma incremental: cada arquivo vai para o bucket de backup uma única vez.

**Acompanhamento:** System Health mostra o último backup, o próximo horário, o histórico e o botão "Fazer backup agora". Falhas geram notificação.

### Restaurar um backup

A restauração é manual, pela linha de comando do worker:

1. **Pause as operações** no System Health. Se for substituir o banco em uso, pare também o **multizap-gateway**, para que nada escreva durante a restauração.
2. O banco de destino precisa ter as migrations **da mesma versão** do MultiZap que gerou o backup. Em um banco novo, rode antes: `pnpm --filter @multizap/database db:deploy`.
3. Abra um terminal no serviço multizap-worker (`railway ssh --service multizap-worker`) e liste os backups:

```bash
node apps/worker/dist/restore.js --list
```

4. Restaure o mais recente (ou informe o caminho do manifesto listado):

```bash
node apps/worker/dist/restore.js latest
```

- Em um banco que já tem dados, a restauração é recusada. Para substituir tudo pelo conteúdo do backup, use `--force`.
- `--no-files` restaura só o banco.
- A restauração do banco é feita numa única transação: ou entra por completo, ou nada muda.
- Para restaurar em outro banco, defina `DATABASE_URL` só para o comando: `DATABASE_URL=postgresql://... node apps/worker/dist/restore.js latest`.

5. Retome as operações e religue o gateway. As sessões do WhatsApp só voltam a funcionar se a `CREDENTIALS_MASTER_KEY` for a mesma da época do backup. Se não for, as instâncias aparecem como "credenciais ilegíveis" e precisam ser pareadas de novo.

## Rede

- Só o **multizap-web** precisa de domínio público.
- A API, o worker e o gateway comunicam-se pela rede privada. A API não precisa de domínio público: o painel a acessa pelo proxy `/api`.

## Health checks

| Serviço         | Caminho                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| web             | `/healthz`                                                               |
| api             | `/health` (liveness). `/health/ready` verifica banco, Redis e heartbeats |
| worker, gateway | `/health` na porta `PORT` (definida pela Railway)                        |

## Gateway e deploys

> ⚠️ **Rode apenas uma réplica do gateway.** A trava por instância no Redis impede que duas réplicas controlem a mesma sessão, mas não há ganho em escalar horizontalmente: as 10 sessões cabem com folga em um processo.

> O gateway precisa de saída de rede para `web.whatsapp.com` (WebSocket). A rede padrão da Railway permite.

O gateway usa `overlapSeconds: 0` e `drainingSeconds: 30`: a instância antiga encerra as conexões de forma graciosa antes que a nova assuma. Além disso, a trava por instância no Redis (Fase 2) impede dois donos simultâneos para a mesma sessão.

## Primeiro deploy (checklist)

1. Crie os serviços Postgres e Redis.
2. Crie os quatro serviços de app, apontando o _config file path_ de cada um.
3. Configure as variáveis acima.
4. Gere o domínio público do `multizap-web` e atualize `WEB_ORIGIN` na API.
5. Faça o deploy. A API aplica as migrations e cria o administrador.
6. Acesse o painel, entre e defina a nova senha.
7. Em **System Health**, confirme que todos os serviços estão operacionais.

### Validações do primeiro deploy

Estes pontos não puderam ser testados no ambiente de desenvolvimento (sem acesso ao WhatsApp, à Railway e a um bucket real). Confira-os uma vez, nesta ordem:

| #   | O que validar             | Como                                                                                                                    | Esperado                                                                    |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Config-as-code            | Em cada serviço, _Settings_: Dockerfile, health check, pre-deploy da API, `overlapSeconds`/`drainingSeconds` do gateway | Valores do `railway.json` reconhecidos (senão, configure-os manualmente)    |
| 2   | Bucket de arquivos        | Envie uma imagem em Criativos e uma lista em Contatos → Importar; baixe os rejeitados                                   | Miniatura aparece; download funciona; System Health mostra "Railway Bucket" |
| 3   | Pareamento por QR Code    | Conexões → Nova instância → Parear → ler o QR no celular (Aparelhos conectados)                                         | Instância "Conectada" com o número identificado                             |
| 4   | Pareamento por código     | Outra instância → Parear por número → digitar o código de 8 letras no celular                                           | Instância "Conectada"                                                       |
| 5   | Restauração após reinício | Faça _Restart_ do multizap-gateway                                                                                      | Instâncias voltam a "Conectada" sem novo pareamento                         |
| 6   | Recebimento               | De outro celular, mande uma mensagem para o número conectado                                                            | Conversa aparece na Central, contato criado com origem "mensagem recebida"  |
| 7   | Resposta                  | Responda pela Central                                                                                                   | Mensagem chega ao celular; status evolui até "Lida"                         |
| 8   | Campanha assistida        | Crie uma campanha para um contato de teste autorizado (seu próprio número) e confirme o envio                           | Mensagem entregue; relatório da campanha atualizado                         |
| 9   | Descadastramento          | Do celular de teste, responda "SAIR"                                                                                    | Contato descadastrado e fora das próximas campanhas                         |
| 10  | Backup                    | System Health → Fazer backup agora; depois `node apps/worker/dist/restore.js --list` no terminal do worker              | Backup "Concluído" e listado pelo comando                                   |
| 11  | Pausa global              | Pause em System Health e tente responder uma conversa                                                                   | Resposta bloqueada com aviso; retome em seguida                             |

Guarde em local seguro, fora da Railway, uma cópia de `CREDENTIALS_MASTER_KEY` e `BACKUP_ENCRYPTION_KEY`.
