# MultiZap CRM

CRM privado para gerenciar até **10 contas WhatsApp** em um único painel administrativo: conexões persistentes, contatos isolados por instância, ferramentas de listas, biblioteca de criativos, campanhas assistidas, central de mensagens e relatórios.

> Uso exclusivo do administrador. Não é um SaaS: não há planos, pagamentos nem cadastro de clientes.

## Status

| Fase | Escopo                                                | Status       |
| ---- | ----------------------------------------------------- | ------------ |
| 1    | Fundação, autenticação e design system                | ✅ Concluída |
| 2    | Dashboard e conexões (QR Code / código de pareamento) | ✅ Concluída |
| 3    | Contatos e importações                                | ✅ Concluída |
| 4    | Ferramentas de processamento                          | ✅ Concluída |
| 5    | Biblioteca de criativos                               | ✅ Concluída |
| 6    | Campanhas assistidas                                  | ✅ Concluída |
| 7    | Central de mensagens                                  | ✅ Concluída |
| 8    | Relatórios e analytics                                | ✅ Concluída |
| 9    | System Health e segurança                             | ✅ Concluída |
| 10   | Testes, documentação e produção                       | ✅ Concluída |

Detalhes e registro de cada fase: [`docs/PHASES.md`](docs/PHASES.md). Critérios de aceitação e o que validar no primeiro deploy: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

## Estrutura

```
apps/
  web/        Next.js 15 — painel (proxy /api → API interna)
  api/        Fastify — REST, autenticação, regras de negócio
  worker/     BullMQ — importações, ferramentas, métricas, backups
  gateway/    Dono das conexões WhatsApp (sessões persistentes)
packages/
  database/   Prisma Client + bootstrap do administrador
  shared/     Schemas zod, criptografia, constantes, utilitários
  ui/         Design system "Dark Premium" (Tailwind v4 + Radix)
  integrations/ Contratos dos provedores de canal
  storage/    Armazenamento de arquivos (Railway Bucket / local)
  files/      Leitura e escrita de CSV, TXT e XLSX em streaming
  tools/      Ferramentas de listas (conversor, divisor, higienizador...)
prisma/       schema.prisma + migrations
tests/e2e/    Testes de ponta a ponta (Playwright) contra os builds reais
docs/         Arquitetura, deploy, segurança, aceitação, ADRs
```

## Desenvolvimento local

Pré-requisitos: Node 22, pnpm 10, PostgreSQL 16 e Redis 7.

```bash
pnpm install
```

```bash
cp .env.example .env   # preencha CREDENTIALS_MASTER_KEY, ADMIN_EMAIL e ADMIN_INITIAL_PASSWORD
```

```bash
pnpm db:deploy         # aplica as migrations
```

```bash
pnpm dev               # web :3000, api :4000, worker, gateway
```

No primeiro acesso, entre com `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`. A troca de senha é obrigatória.

### Comandos

| Comando           | Descrição                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm typecheck`  | Checagem de tipos em todo o monorepo                                                           |
| `pnpm test`       | Testes (a API usa um PostgreSQL real em `TEST_DATABASE_URL`)                                   |
| `pnpm build`      | Build de produção dos quatro apps                                                              |
| `pnpm test:e2e`   | Ponta a ponta no navegador (requer `pnpm build`; usa `E2E_DATABASE_URL`, um banco descartável) |
| `pnpm format`     | Prettier                                                                                       |
| `pnpm db:migrate` | Cria uma nova migration (desenvolvimento)                                                      |

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Deploy na Railway](docs/DEPLOY.md)
- [Segurança](docs/SECURITY.md)
- [Critérios de aceitação](docs/ACCEPTANCE.md)
- [Decisões arquiteturais (ADRs)](docs/adr/)
