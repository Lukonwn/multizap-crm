# ADR 0004: Versão do Baileys e sincronização inicial

**Status:** aceita (Fase 2)

**Contexto.** O npm marca `baileys@7.0.0-rc14` (julho de 2026) como `latest`. A série 6.7.x é mantida como `legacy`. Mudanças de protocolo do WhatsApp afetam primeiro as versões antigas. Ao rodar o gateway, o Baileys 7 emitiu um alerta: desativar toda a sincronização de histórico (`shouldSyncHistoryMessage: () => false`) impede o carregamento inicial dos mapeamentos LID e causa instabilidade e erros de sessão.

**Decisão.**

- Fixar `baileys@7.0.0-rc14` (versão exata). Atualizar de forma deliberada, rodando a suíte do gateway.
- Manter a sincronização inicial padrão (`syncFullHistory: false`, sem bloquear as notificações de histórico).
- Até a Fase 7 (Central de Mensagens), nenhum conteúdo de histórico é armazenado. A interface não promete conversas sincronizadas.
- `markOnlineOnConnect: false`, para que o celular continue recebendo notificações.

**Consequências.** As sessões ficam mais estáveis. Quando a Fase 7 chegar, os eventos de histórico já estarão disponíveis para persistência.
