# ADR 0007: MultiZap AI (agentes de IA no atendimento)

**Status:** aceito (Entregas 1 e 2 implementadas; 3 a 5 planejadas)

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

## Entrega 2: atendimento real

- **Fluxo:** o gateway grava a mensagem do contato (como sempre) e, só se a instância tiver agente ativo e a mensagem for ao vivo, enfileira um job na fila `ai-inbound` com espera de 6 s (para juntar mensagens em sequência). O **worker** decide e responde. Falha em qualquer ponto do módulo é registrada e não afeta a gravação nem a exibição de mensagens.
- **Quem responde:** o worker usa a **versão publicada** (modelo, persona, instruções e modo vêm da fotografia). Trocar para o modo automático exige publicar de novo.
- **Revisão humana (padrão):** a resposta vira rascunho (`ai_drafts`) em MultiZap AI → Atendimentos; o administrador aprova (pode editar) ou descarta. **Automático:** o worker grava a mensagem como pendente e o gateway envia pelo mesmo caminho das respostas manuais.
- **Quando a IA NÃO responde** (e o motivo aparece na tela): grupos, canais e listas; agente pausado/em erro; operações pausadas globalmente; contato descadastrado (até escrever de novo); contato que recebeu **campanha nos últimos 7 dias** (salvo liberação manual da conversa); conversa pausada; mensagem sem texto (áudio, imagem...); limite de respostas por hora na conversa (padrão 10) ou na instância (60); outra mensagem mais nova do contato (só a última responde).
- **Pessoa assume:** quando alguém responde pela Central, ou pelo celular, nas últimas 12 h, a IA pausa naquela conversa até o administrador retomar. A marca "enviada pela IA" (`ai_message_links`) acompanha a mensagem mesmo quando o eco da sessão a substitui.
- **Idempotência:** `ai_drafts.inbound_message_id` é único: uma mensagem do contato gera no máximo uma resposta, mesmo com jobs repetidos ou dois cliques em "aprovar" (reserva atômica).
- **"Digitando…":** no modo automático, o worker pede ao gateway para mostrar "digitando" **somente enquanto a resposta está de fato sendo gerada** e o apaga ao terminar (mesmo em erro); pode ser desligado por agente. O **intervalo mínimo** antes do envio é **fixo e configurável** (padrão 8 s): é proteção contra excesso de envio, não simulação de comportamento humano. Não existe "gravando áudio" (o agente não envia áudio) nem atraso aleatório.
- **Memória:** resumo por conversa (instância + contato + agente), atualizado a cada 12 mensagens novas por uma chamada curta ao modelo e usado no prompt seguinte. Trocar o agente da instância não reaproveita a memória do anterior.
- **Erros da OpenRouter:** chave inválida ou sem créditos **param o agente** (status Erro) para não repetir a falha a cada mensagem; erros temporários só viram evento. Tudo em MultiZap AI → eventos do agente.
- **Consumo real** (`context = LIVE`) por agente, instância e conversa, separado do uso de testes.
- **Migração** `20261126120000_ai_service`: só tabelas `ai_*` (novas) e colunas novas em tabelas `ai_*`; reversão em [`docs/migrations/20261126120000_ai_service.down.sql`](../migrations/20261126120000_ai_service.down.sql).
- **Requisito de implantação:** o worker precisa da mesma `CREDENTIALS_MASTER_KEY` da API para ler a chave da OpenRouter. Sem ela, o agente não responde e registra um evento claro.

## Migração

`20261125120000_ai_foundation` só cria tabelas novas. A chave `ai_agents.published_version_id` é `DEFERRABLE INITIALLY DEFERRED` porque agente e versão se referenciam; a restauração de backup adia essas chaves para o fim da transação. Reversão: [`docs/migrations/20261125120000_ai_foundation.down.sql`](../migrations/20261125120000_ai_foundation.down.sql) (remove só as tabelas da IA).

## Consequências

- Fazer backup ("Fazer backup agora") antes de publicar a versão com a migração.
- A Entrega 2 exige `CREDENTIALS_MASTER_KEY` (a mesma da API) também no worker, para ler a chave da OpenRouter.
- Custo de tokens é do administrador, na conta da OpenRouter; o painel mostra o consumo registrado.
