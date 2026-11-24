import type { GatewayCommand } from '@multizap/shared';
import type { SessionManager } from './session/manager';

/** Executa um comando recebido da API pela fila. */
export async function handleCommand(manager: SessionManager, cmd: GatewayCommand): Promise<void> {
  switch (cmd.type) {
    case 'start-pairing':
      return manager.startPairing(
        cmd.accountId,
        cmd.method,
        cmd.method === 'pairing-code' ? cmd.phoneE164 : undefined,
      );
    case 'cancel-pairing':
      return manager.cancelPairing(cmd.accountId);
    case 'reconnect':
      return manager.reconnect(cmd.accountId);
    case 'stop':
      return manager.stop(cmd.accountId);
    case 'remove':
      return manager.remove(cmd.accountId);
  }
}
