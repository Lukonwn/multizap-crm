# ADR 0001: Monorepo com quatro serviços

**Status:** aceita (Fase 1)

**Contexto.** O sistema precisa de painel, API, processamento assíncrono e conexões WhatsApp de longa duração, com deploy independente na Railway.

**Decisão.** Monorepo pnpm + Turborepo com `web` (Next.js), `api` (Fastify), `worker` (BullMQ) e `gateway` (conexões WhatsApp), mais pacotes compartilhados. O gateway é um serviço próprio porque mantém sockets persistentes e exige um único dono por instância. Isolá-lo evita que deploys ou picos do worker derrubem as conexões.

**Consequências.** Há cinco serviços de runtime (mais Postgres e Redis). Os pacotes internos são consumidos como TypeScript e empacotados no build (tsup / `transpilePackages`), sem etapa de publicação.
