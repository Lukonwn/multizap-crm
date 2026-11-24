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
| `API_PORT`                | `4000`                                                                                                                     |
| `CREDENTIALS_MASTER_KEY`  | 32 bytes em base64 (ver abaixo). **Guarde uma cópia fora da Railway**: sem ela, as credenciais salvas não podem ser lidas. |
| `CREDENTIALS_KEY_VERSION` | `1`                                                                                                                        |
| `INTERNAL_API_TOKEN`      | String aleatória com 32 caracteres ou mais                                                                                 |
| `ADMIN_EMAIL`             | E-mail do administrador                                                                                                    |
| `ADMIN_INITIAL_PASSWORD`  | Senha inicial (troca obrigatória no 1º login; pode ser removida depois)                                                    |

### multizap-web

| Variável           | Valor                                                  |
| ------------------ | ------------------------------------------------------ |
| `API_INTERNAL_URL` | `http://${{multizap-api.RAILWAY_PRIVATE_DOMAIN}}:4000` |

### multizap-worker e multizap-gateway

| Variável                  | Valor                                                |
| ------------------------- | ---------------------------------------------------- |
| `NODE_ENV`                | `production`                                         |
| `DATABASE_URL`            | `${{Postgres.DATABASE_URL}}`                         |
| `REDIS_URL`               | `${{Redis.REDIS_URL}}`                               |
| `CREDENTIALS_MASTER_KEY`  | a mesma da API (somente gateway, a partir da Fase 2) |
| `CREDENTIALS_KEY_VERSION` | `1`                                                  |

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
