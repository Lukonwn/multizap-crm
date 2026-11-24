# ADR 0006: identidades do WhatsApp (nomes, LID e fotos) na Central

**Status:** aceito

## Contexto

No primeiro teste com um número real, a Central mostrou conversas como "Contato sem número identificado", sem nome nem foto. O WhatsApp agora endereça muitas conversas por **LID** (`…@lid`), um identificador que não é o telefone. A Fase 7 só usava o telefone quando a própria mensagem o trazia (`remoteJidAlt`) e ignorava os eventos em que o WhatsApp entrega ao aparelho conectado os nomes da agenda e a correspondência LID ↔ telefone. A simulação usada nos testes só tinha conversas por telefone, então o problema não apareceu.

## Decisões

1. **Diretório de identidades** (`wa_identities`, por instância): guarda o nome salvo na agenda do celular, o nome de perfil, o nome verificado e a correspondência LID ↔ telefone, alimentado por `contacts.upsert`, `contacts.update`, `lid-mapping.update`, pelo histórico entregue ao vincular e pelo mapeamento da própria sessão.
2. **Só enriquece a Central.** O diretório **não cria contatos do CRM**, não aparece em Contatos e não entra em campanhas. A conversa só é vinculada a um contato do CRM que já exista com o mesmo telefone. Importar a agenda como contatos exigiria consentimento e continua sendo uma decisão explícita do administrador, fora deste escopo.
3. **Prioridade do nome:** contato do CRM → nome salvo na agenda → nome verificado → nome de perfil → telefone formatado → "Contato sem número identificado".
4. **Conversas duplicadas:** quando o telefone de um LID passa a ser conhecido, a conversa por LID é migrada para o endereço do telefone ou, se as duas existirem, unida (mensagens, não lidas e última mensagem preservados).
5. **Fotos de perfil:** só de conversas que já existem e tiveram movimento nos últimos 30 dias, 8 por rodada por instância, com pausa entre consultas, nova verificação a cada 7 dias e pausa de 30 minutos ao receber limite de taxa. Nunca consulta números avulsos. A foto é guardada no bucket (`avatars/…`) e servida pela API; como pode ser obtida de novo, não entra no backup.
6. **Tipos de mensagem:** mais tipos reconhecidos (enquete, álbum, evento, respostas de botão e lista, vídeo redondo, localização ao vivo). Um tipo ainda não tratado mostra o nome técnico e gera um evento no System Health (uma vez por tipo).

7. **Agenda do aparelho** (Contatos → Agenda do aparelho): lista, por instância, o que o WhatsApp entregou (nome da agenda, perfil, telefone), com pesquisa. O administrador escolhe quem importar para Contatos; a importação pede confirmação, grava origem "Agenda do aparelho conectado", **consentimento PENDENTE** (nunca concedido), mantém descadastrados como descadastrados e não altera telefones que já existem. Fica na auditoria.
8. **Diagnóstico:** cada sincronização inicial gera o evento "Sincronização do WhatsApp" (System Health → Eventos) com o número de conversas, mensagens, contatos e correspondências LID recebidos; uma falha ao registrar identidades nunca impede a gravação da mensagem.

## Limites conhecidos

- O que o WhatsApp entrega depende dele: ao vincular, o aparelho envia o histórico recente e a agenda **uma vez**. Quem vinculou antes desta correção pode precisar **desconectar e parear de novo** para receber os nomes da agenda.
- Quantas conversas aparecem na Central é decidido pelo WhatsApp no pareamento (`syncFullHistory` está desligado, ver ADR 0004).
- Conversas de pessoas que o WhatsApp não identifica continuam sem nome (nunca é inventado).
