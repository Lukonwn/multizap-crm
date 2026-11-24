# Segurança

| Controle       | Implementação                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Senhas         | argon2id (m=19 MiB, t=2, p=1). Política: 12+ caracteres, com maiúsculas, minúsculas, número e símbolo                                                                   |
| Sessões        | Token de 256 bits; o banco guarda só o SHA-256. Cookie `httpOnly`, `SameSite=Strict`, `Secure` em produção. Expiração absoluta e por inatividade. Revogação individual  |
| CSRF           | Double-submit vinculado à sessão + verificação de `Origin`/`Sec-Fetch-Site`                                                                                             |
| Força bruta    | Bloqueio por conta (5 falhas → 15 min) + limite por IP; mensagem genérica; tempo equalizado para e-mails inexistentes                                                   |
| Credenciais    | AES-256-GCM com versão de chave (rotação), AAD por instância e chave mestra fora do repositório                                                                         |
| SQL Injection  | Prisma (consultas parametrizadas). SQL bruto apenas parametrizado                                                                                                       |
| XSS            | React escapa a saída; CSP restritiva no web; a API responde só JSON com `default-src 'none'`                                                                            |
| HTTPS          | `Strict-Transport-Security` (1 ano) no painel em produção                                                                                                               |
| Clickjacking   | `X-Frame-Options: DENY` e `frame-ancestors 'none'`                                                                                                                      |
| Validação      | zod em todas as entradas da API                                                                                                                                         |
| Logs           | pino com _redaction_ de cookies, tokens e cabeçalhos de autenticação. Erros internos não são expostos ao cliente                                                        |
| Auditoria      | `audit_logs`: acesso, senha e sessões; instâncias, contatos, importações, ferramentas, criativos, campanhas, Central, pausa global e backups. Consulta em Configurações |
| Segredos       | Somente em variáveis de ambiente. `.env` está no `.gitignore`                                                                                                           |
| Backups        | Bucket separado; AES-256-GCM com `BACKUP_ENCRYPTION_KEY` (diferente da chave das credenciais); restauração apenas por linha de comando                                  |
| Pausa global   | Suspende envios de campanha, respostas e agendamentos; verificada no momento de cada envio                                                                              |
| Rotas internas | `/internal/*` não são expostas pelo proxy do painel e exigem `INTERNAL_API_TOKEN` (a partir da Fase 2)                                                                  |

## Rotação da chave de credenciais

1. Gere uma nova chave.
2. Mova a chave atual para `CREDENTIALS_MASTER_KEY_V<n>` (onde `n` é a versão atual).
3. Defina a nova chave em `CREDENTIALS_MASTER_KEY` e incremente `CREDENTIALS_KEY_VERSION`.
4. Reinicie o gateway. Os dados antigos continuam legíveis, e o que for regravado já usa a chave nova.
5. Recriptografe o restante em lote, num terminal do multizap-gateway:

```bash
node apps/gateway/dist/reencrypt-cli.js
```

6. Quando o comando informar `Ilegíveis (mantidos): 0`, a variável `CREDENTIALS_MASTER_KEY_V<n>` antiga pode ser removida.

Se a chave for trocada **sem** manter a antiga, as instâncias ficam como "credenciais ilegíveis": a reconexão automática é suspensa e nada é apagado. Restaure a chave anterior e clique em Reconectar, ou remova a conexão e pareie de novo.

## Chave dos backups

`BACKUP_ENCRYPTION_KEY` é independente da chave das credenciais. Guarde uma cópia fora da Railway: sem ela, nenhum backup pode ser restaurado. O manifesto de cada backup guarda só uma impressão digital da chave, e a restauração recusa uma chave diferente.

## Revisão de segurança (Fase 10)

Conferido com os serviços rodando em modo de produção:

- Cabeçalhos do painel e da API pelo proxy: CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` e HSTS.
- `/api/internal/*` não é alcançável pelo proxy do painel, inclusive com `..` codificado e variações de maiúsculas (404).
- Login sem `Origin` é recusado (400); com origem diferente do painel, 403 `ORIGIN_REJECTED`.
- Sem sessão, a API responde 401; após o logout, o painel volta para o login (teste de ponta a ponta).
- Histórico do Git: nenhum `.env` nem padrão de segredo (chaves AWS, tokens, chaves privadas, `*_KEY=` com valor) versionado; só `.env.example`, sem valores.
- Erros internos não expõem detalhes ao cliente; logs com _redaction_ de cookies e cabeçalhos de autenticação.

## Dependências

`pnpm audit --prod` avaliado em 24/11/2026. Corrigido:

- `sharp` 0.34 → 0.35.5: alertas altos do libvips, libheif e librsvg (processa as imagens enviadas para a biblioteca).
- `csv-parse` 6 → 7.0.3: alerta moderado (o caminho afetado, a opção `columns`, não era usado).

Mantidos, por não serem alcançáveis com dados de terceiros:

| Pacote                                | Onde                       | Motivo                                                                                                   |
| ------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `postcss` (via Next.js)               | Build do painel            | Só processa o CSS do próprio projeto, no build. Corrigido quando o Next.js atualizar a versão embutida.  |
| `zod` 3                               | Validação da API           | A correção existe só no zod 4 (migração grande). As entradas são limitadas a 1 MB por requisição na API. |
| `uuid` (via exceljs)                  | Exportação XLSX            | O alerta afeta v3/v5/v6 com buffer informado; o exceljs usa v4.                                          |
| `glob`/`minimatch` (via archiver)     | ZIP das ferramentas        | Nenhum padrão vem do usuário; os arquivos são adicionados por stream.                                    |
| `deepmerge-ts`, `effect` (via Prisma) | CLI do Prisma (migrations) | Usados só pela ferramenta de linha de comando, com a configuração do próprio projeto.                    |

Reavalie a cada atualização de dependências (`pnpm audit --prod`).
