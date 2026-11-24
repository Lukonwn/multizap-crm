/**
 * Filas BullMQ do MultiZap. Os processadores são adicionados por fase:
 *  - imports      (Fase 3): análise e importação de listas
 *  - file-tools   (Fase 4): conversor, divisor, comparador, higienizador
 *  - campaigns    (Fase 6): preparação de filas da campanha assistida
 *  - metrics      (Fase 8): agregação de métricas diárias
 *  - maintenance  (Fase 9): limpeza de sessões, backups, verificações
 */
export const QUEUES = {
  imports: 'imports',
  fileTools: 'file-tools',
  campaigns: 'campaigns',
  metrics: 'metrics',
  maintenance: 'maintenance',
} as const;
