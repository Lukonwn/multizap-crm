# Testes

- **Unitários:** junto ao código (`packages/*/src/*.test.ts`).
- **Integração da API:** `apps/api/test`, com PostgreSQL e Redis reais. Configure `TEST_DATABASE_URL` apontando para um banco dedicado cujo nome contenha `test`. As migrations são aplicadas com `migrate deploy` e as tabelas são truncadas entre os testes.
- **Ponta a ponta (Playwright):** esta pasta, a partir da Fase 10.
