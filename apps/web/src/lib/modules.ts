import {
  Activity,
  BarChart3,
  Images,
  LayoutDashboard,
  Megaphone,
  MessagesSquare,
  Settings,
  Smartphone,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface ModuleDef {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
  /** Fase do plano em que o módulo fica operacional. */
  phase: number;
  description: string;
  upcoming: string[];
}

/** Última fase concluída. */
export const CURRENT_PHASE = 2;

export const MODULES: ModuleDef[] = [
  {
    key: 'dashboard',
    href: '/',
    label: 'Dashboard',
    icon: LayoutDashboard,
    phase: 2,
    description: 'Visão geral das instâncias, contatos, campanhas e alertas.',
    upcoming: [
      'Indicadores de instâncias e contatos',
      'Saúde das conexões',
      'Atividades recentes',
      'Alertas do sistema',
    ],
  },
  {
    key: 'connections',
    href: '/conexoes',
    label: 'Conexões',
    icon: Smartphone,
    phase: 2,
    description: 'Até 10 instâncias WhatsApp com sessões persistentes.',
    upcoming: [
      'Cadastro das instâncias',
      'Pareamento por QR Code',
      'Pareamento com número de telefone (código de 8 caracteres)',
      'Histórico de eventos e monitoramento',
    ],
  },
  {
    key: 'contacts',
    href: '/contatos',
    label: 'Contatos',
    icon: Users,
    phase: 3,
    description: 'Bases de contatos independentes por instância.',
    upcoming: [
      'Cadastro, edição e etiquetas',
      'Consentimento e descadastramento',
      'Importação CSV/TXT/XLSX com pré-visualização',
      'Exportação',
    ],
  },
  {
    key: 'tools',
    href: '/ferramentas',
    label: 'Ferramentas',
    icon: Wrench,
    phase: 4,
    description: 'Processamento e higienização de listas.',
    upcoming: [
      'Conversor CSV/XLSX',
      'Divisor e comparador de listas',
      'Removedor de duplicados',
      'Higienizador e organizador por DDD/país',
    ],
  },
  {
    key: 'campaigns',
    href: '/campanhas',
    label: 'Campanhas',
    icon: Megaphone,
    phase: 6,
    description: 'Campanhas assistidas: cada envio confirmado por você.',
    upcoming: [
      'Construtor com pré-visualização',
      'Campanhas multicontas',
      'Agendamento, pausa e retomada',
      'Fila de envio assistido',
    ],
  },
  {
    key: 'inbox',
    href: '/mensagens',
    label: 'Central de mensagens',
    icon: MessagesSquare,
    phase: 7,
    description: 'Conversas recebidas pelas sessões conectadas.',
    upcoming: [
      'Inbox em três colunas',
      'Filtros por status e instância',
      'Respostas individuais',
      'Dados do contato ao lado',
    ],
  },
  {
    key: 'assets',
    href: '/criativos',
    label: 'Biblioteca de criativos',
    icon: Images,
    phase: 5,
    description: 'Imagens, textos, links e modelos de mensagem.',
    upcoming: [
      'Pastas e busca',
      'Upload com metadados e dimensões',
      'Associação a campanhas',
      'Histórico de utilização',
    ],
  },
  {
    key: 'reports',
    href: '/relatorios',
    label: 'Relatórios',
    icon: BarChart3,
    phase: 8,
    description: 'Indicadores globais e por instância, com dados reais.',
    upcoming: [
      'Filtros por período e instância',
      'Gráficos e comparação entre períodos',
      'Exportação CSV/XLSX',
    ],
  },
  {
    key: 'health',
    href: '/system-health',
    label: 'System Health',
    icon: Activity,
    phase: 9,
    description: 'Monitoramento de serviços, filas, conexões e backups.',
    upcoming: [
      'Filas e erros',
      'Notificações de falha',
      'Backups e restauração',
      'Pausa global de operações',
    ],
  },
  {
    key: 'settings',
    href: '/configuracoes',
    label: 'Configurações',
    icon: Settings,
    phase: 1,
    description: 'Conta do administrador e segurança.',
    upcoming: [],
  },
];

export function moduleByKey(key: string): ModuleDef {
  const m = MODULES.find((x) => x.key === key);
  if (!m) throw new Error(`Módulo desconhecido: ${key}`);
  return m;
}
