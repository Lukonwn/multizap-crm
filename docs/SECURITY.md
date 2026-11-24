# Segurança

| Controle       | Implementação                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Senhas         | argon2id (m=19 MiB, t=2, p=1). Política: 12+ caracteres, com maiúsculas, minúsculas, número e símbolo                                                                  |
| Sessões        | Token de 256 bits; o banco guarda só o SHA-256. Cookie `httpOnly`, `SameSite=Strict`, `Secure` em produção. Expiração absoluta e por inatividade. Revogação individual |
| CSRF           | Double-submit vinculado à sessão + verificação de `Origin`/`Sec-Fetch-Site`                                                                                            |
| Força bruta    | Bloqueio por conta (5 falhas → 15 min) + limite por IP; mensagem genérica; tempo equalizado para e-mails inexistentes                                                  |
| Credenciais    | AES-256-GCM com versão de chave (rotação), AAD por instância e chave mestra fora do repositório                                                                        |
| SQL Injection  | Prisma (consultas parametrizadas). SQL bruto apenas parametrizado                                                                                                      |
| XSS            | React escapa a saída; CSP restritiva no web; a API responde só JSON com `default-src 'none'`                                                                           |
| Clickjacking   | `X-Frame-Options: DENY` e `frame-ancestors 'none'`                                                                                                                     |
| Validação      | zod em todas as entradas da API                                                                                                                                        |
| Logs           | pino com _redaction_ de cookies, tokens e cabeçalhos de autenticação. Erros internos não são expostos ao cliente                                                       |
| Auditoria      | `audit_logs`: login, falhas de login, logout, troca de senha e revogação de sessões (mais eventos nas próximas fases)                                                  |
| Segredos       | Somente em variáveis de ambiente. `.env` está no `.gitignore`                                                                                                          |
| Rotas internas | `/internal/*` não são expostas pelo proxy do painel e exigem `INTERNAL_API_TOKEN` (a partir da Fase 2)                                                                 |

## Rotação da chave de credenciais

1. Gere uma nova chave.
2. Mova a chave atual para `CREDENTIALS_MASTER_KEY_V<n>` (onde `n` é a versão atual).
3. Defina a nova chave em `CREDENTIALS_MASTER_KEY` e incremente `CREDENTIALS_KEY_VERSION`.
4. Os dados antigos continuam legíveis. A recriptografia em lote fica disponível na Fase 9.
