# ADR 0005: backups, monitoramento e pausa global

**Status:** aceito (Fase 9)

## Contexto

O MultiZap precisa de backups restauráveis do banco e dos arquivos, independentes do armazenamento principal, de notificações quando algo falha e de uma forma de parar os envios em emergências.

## Decisões

1. **Backup lógico pelo worker com `COPY`**, em vez de `pg_dump`. O `pg_dump` exige que a versão do cliente acompanhe a do servidor da Railway, o que quebra a imagem a cada atualização do Postgres. O `COPY` (driver `pg` + `pg-copy-streams`) roda em streaming, em uma única transação `REPEATABLE READ` (snapshot consistente), e o esquema vem das próprias migrations do Prisma.
2. **Restauração exige as mesmas migrations.** O manifesto guarda a lista de migrations; a restauração recusa um banco diferente. A carga respeita as chaves estrangeiras (ordem topológica) e é feita em uma única transação.
3. **Bucket separado e criptografia própria.** Os backups vão para outro bucket (`BACKUP_S3_*`) e são criptografados com AES-256-GCM usando `BACKUP_ENCRYPTION_KEY`, diferente da chave das credenciais. O manifesto guarda só a impressão digital da chave, para avisar quando a chave usada na restauração for outra.
4. **Arquivos em espelho incremental.** Criativos e mídias recebidas são imutáveis, então cada arquivo é copiado uma vez para `files/`. A retenção remove do espelho apenas o que nenhum backup restante referencia.
5. **Restauração só pela linha de comando.** Restaurar substitui dados de produção; não há botão no painel para isso.
6. **Monitoramento cruzado.** O worker verifica o armazenamento, o bucket de backup, o gateway e atraso de backup; o gateway verifica o worker. As notificações usam `dedupe_key`: não se repetem enquanto o problema persiste e se resolvem sozinhas quando ele some.
7. **Pausa global** guardada em `system_settings`, verificada no momento de cada envio (API, gateway) e no agendador do worker. Conexões, recebimento, importações e backups continuam funcionando.
8. **Credenciais ilegíveis** (chave trocada) não são tratadas como falha temporária: a reconexão automática é suspensa e nada é apagado.
