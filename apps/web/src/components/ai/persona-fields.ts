// Campos de texto da persona, na ordem e com os rótulos das telas de Personas e do Gerador de Persona.

export type TextKey =
  | 'identity'
  | 'biography'
  | 'backstory'
  | 'personality'
  | 'traits'
  | 'toneOfVoice'
  | 'communicationStyle'
  | 'conversationStart'
  | 'instructions'
  | 'rules'
  | 'allowedTopics'
  | 'restrictedTopics';

export const SECTIONS: {
  title: string;
  description: string;
  fields: [TextKey, string, string?][];
}[] = [
  {
    title: 'Identidade',
    description: 'Quem é a persona e de onde ela vem.',
    fields: [
      ['identity', 'Identidade', 'Ex.: atendente da Loja Exemplo, especialista em calçados.'],
      ['biography', 'Biografia'],
      ['backstory', 'Histórico'],
    ],
  },
  {
    title: 'Personalidade e comunicação',
    description: 'Como ela pensa e fala.',
    fields: [
      ['personality', 'Personalidade'],
      ['traits', 'Características comportamentais'],
      ['toneOfVoice', 'Tom de voz', 'Ex.: acolhedor, direto, bem-humorado.'],
      ['communicationStyle', 'Estilo de comunicação'],
      ['conversationStart', 'Como iniciar as conversas'],
    ],
  },
  {
    title: 'Regras e assuntos',
    description: 'Somam-se às regras fixas de todos os agentes.',
    fields: [
      ['instructions', 'Instruções específicas'],
      ['rules', 'Regras de atendimento'],
      ['allowedTopics', 'Assuntos permitidos'],
      ['restrictedTopics', 'Assuntos proibidos'],
    ],
  },
];
