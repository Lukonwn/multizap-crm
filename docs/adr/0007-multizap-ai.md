# ADR 0007: MultiZap AI (agentes de IA no atendimento)

**Status:** aceito (Entrega 1 implementada; Entregas 2 a 5 planejadas)

## Contexto

O administrador quer agentes de IA que atendam pelo WhatsApp com personas próprias, modelos da OpenRouter, memória por contato, base de conhecimento, entregáveis e métricas, **sem alterar o CRM existente**. As instâncias usam sessões do WhatsApp Web (não oficiais), em que respostas automáticas em volume aumentam o risco de restrição do número.

## Decisões

1. **Um módulo dentro do painel.** Só um item novo no menu ("MultiZap AI"); nenhuma tela, rota ou comportamento existente muda. Pacote próprio `@multizap/ai` (cliente OpenRouter e montagem do prompt) e rotas `/ai/*` na API. Sem serviço novo: o atendimento real (Entrega 2) roda no worker atual.
2. **Revisão humana por padrão.** Todo agente nasce no modo "Revisão humana" (a resposta vira rascunho para aprovar). O modo automático é escolhido por agente, com aviso de risco.
3. **Regras fixas** em todo prompt, que nenhuma persona desliga: não afirmar ser humano quando perguntado diretamente; não inventar informações; não dizer que fez algo sem confirmação real; nunca pedir senhas, códigos ou dados de cartão; oferecer atendimento humano.
4. **Um agente ativo por instância.** Um agente pode atender várias instâncias; a API recusa vincular uma instância que já tenha outro agente ativo.
5. **Chave da OpenRouter no painel**, criptografada com AES-256-GCM (mesma `CREDENTIALS_MASTER_KEY` das credenciais do WhatsApp, AAD própria). Nunca volta ao navegador (só os 4 últimos caracteres), não vai para logs e não fica no repositório.
6. **Versões.** Agente e persona são editados como rascunho; publicar grava uma versão imutável (agente + persona). Restaurar traz uma versão para o rascunho, sem mudar a publicada. Personas guardam histórico de alterações.
7. **Laboratório sem envio.** As conversas de teste nunca passam pelo gateway; o consumo de tokens é registrado como TEST, com custo confirmado pela OpenRouter ou estimado pelo preço do modelo (marcado como estimado).
8. **Campanhas não ativam agentes.** Contato que recebeu campanha fica 7 dias fora do atendimento automático, salvo liberação manual da conversa (Entrega 2). Descadastro e pausa geral valem também para a IA.
9. **Base de conhecimento** começa com busca textual do PostgreSQL (português), sem serviço de vetores (Entrega 3).
10. **Entregas condicionadas a pagamento** só com confirmação real da fonte responsável, nunca pela palavra do contato ou do modelo (Entrega 4).
11. **Falhas da IA não derrubam o CRM.** Erros da OpenRouter viram mensagens/eventos do módulo; nada do restante depende dele.

## Migração

`20261125120000_ai_foundation` só cria tabelas novas. A chave `ai_agents.published_version_id` é `DEFERRABLE INITIALLY DEFERRED` porque agente e versão se referenciam; a restauração de backup adia essas chaves para o fim da transação. Reversão: [`docs/migrations/20261125120000_ai_foundation.down.sql`](../migrations/20261125120000_ai_foundation.down.sql) (remove só as tabelas da IA).

## Consequências

- Fazer backup ("Fazer backup agora") antes de publicar a versão com a migração.
- A Entrega 2 exige `CREDENTIALS_MASTER_KEY` (a mesma da API) também no worker, para ler a chave da OpenRouter.
- Custo de tokens é do administrador, na conta da OpenRouter; o painel mostra o consumo registrado.
