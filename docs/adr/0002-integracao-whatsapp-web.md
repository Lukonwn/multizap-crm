# ADR 0002: Integração por dispositivo conectado (WhatsApp Web)

**Status:** aceita (decisão do administrador)

**Contexto.** O administrador optou por não usar a WhatsApp Business Cloud API da Meta e prefere vincular as contas como **dispositivo conectado**, com QR Code e, como alternativa, código de pareamento de 8 caracteres confirmado no celular.

**Decisão.**

- Usar uma biblioteca do protocolo multi-dispositivo (Baileys) no serviço `gateway`, a partir da Fase 2.
- As credenciais e chaves de sessão ficam criptografadas no PostgreSQL, nunca no filesystem do container.
- Os códigos de QR e de pareamento são exibidos somente quando gerados pelo WhatsApp. Nada é simulado.
- **Campanhas no modo assistido:** cada envio é confirmado individualmente pelo administrador. Não serão implementados disparo automático em massa, randomização de intervalos para imitar comportamento humano, rodízio de contas para driblar limites, nem consulta de listas arbitrárias de telefones para descobrir contas.

**Riscos aceitos pelo administrador.** O cliente não é oficial: o WhatsApp pode restringir ou banir números, mudanças de protocolo podem interromper conexões até a biblioteca ser atualizada, e a sessão pode ser encerrada pelo WhatsApp a qualquer momento. O sistema detecta, registra e notifica, mas não impede.
