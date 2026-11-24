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

9. **Mensagens de empresa** (modelos, interativas, botões e listas) passam a mostrar título, texto, rodapé e os nomes dos botões, como texto comum.
10. **Mensagem reenviada pelo celular:** quando o WhatsApp não consegue abrir o conteúdo, a biblioteca grava um marcador ("placeholder") e pede ao celular que reenvie; o conteúdo real chega depois **com o mesmo ID**. Antes, a repetição era ignorada e o marcador ficava para sempre. Agora a mensagem já gravada é atualizada (tipo, texto e prévia da conversa), sem duplicar nem alterar o contador de não lidas. Um "SAIR" que chegue assim também descadastra o contato.
11. **Áudios** (e imagens) são guardados no bucket e tocados na própria Central. Ao vivo, na hora; do histórico, em uma fila em segundo plano (2 por vez, 25 s por arquivo, até 8 MB por áudio), para não atrasar a sincronização. Mídia antiga que o WhatsApp já removeu não pode ser baixada: a mensagem continua, sem o arquivo. Vídeos, documentos e figurinhas continuam só identificados.

12. **Agenda do celular e a chave de sincronização:** os nomes da agenda chegam pela sincronização do "estado do aplicativo", que depende de uma chave enviada pelo celular logo após o pareamento. Se a chave não chega, a sincronização fica "parada esperando a chave". O gateway observa as mensagens da biblioteca (sem depender do nível de log da hospedagem), registra cada etapa em System Health → Eventos ("Agenda (instância): …") e, se a agenda ficar parada, pede nova sincronização com o recurso oficial da biblioteca, após 1,5, 6 e 20 minutos. Não envia mensagens de protocolo escritas à mão.

13. **Resultado do teste real da agenda:** com a sincronização concluída sem erro (sem "falta de chave"), o WhatsApp entregou apenas as coleções "preferências" e "bloqueios", e nenhuma de "agenda e contatos". Os contatos recebidos (3 a 4) são só os das conversas existentes, sem nome salvo na agenda. Ou seja, **o WhatsApp não entregou a agenda inteira do celular a este aparelho conectado**; o sistema trata a agenda quando ela chega, mas não consegue forçá-la. Caminhos independentes: **digitar o número** na Nova conversa (como no WhatsApp Web) e **importar a agenda por arquivo** (Contatos → Importar lista).

## Limites conhecidos

- O que o WhatsApp entrega depende dele: ao vincular, o aparelho envia o histórico recente e a agenda **uma vez**. Quem vinculou antes desta correção pode precisar **desconectar e parear de novo** para receber os nomes da agenda.
- Quantas conversas aparecem na Central é decidido pelo WhatsApp no pareamento (`syncFullHistory` está desligado, ver ADR 0004).
- Conversas de pessoas que o WhatsApp não identifica continuam sem nome (nunca é inventado).
- Mensagens gravadas antes desta correção só são atualizadas quando o WhatsApp as entrega de novo (por exemplo, ao parear outra vez): o conteúdo bruto não é guardado.
- Áudio em formato Ogg/Opus não toca no Safari mais antigo; os demais navegadores tocam.
