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
