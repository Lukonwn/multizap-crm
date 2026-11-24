import type { GatewayCommand } from '@multizap/shared';
import type { SessionManager } from './session/manager';
import type { CampaignSender } from './campaigns/sender';
import type { ReplySender } from './inbox/reply-sender';

/** Executa um comando recebido da API pela fila. */
export async function handleCommand(
  manager: SessionManager,
  sender: CampaignSender,
  cmd: GatewayCommand,
  replies?: ReplySender,
): Promise<void> {
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
    case 'send-campaign-message':
      return sender.send(cmd.recipientId);
    case 'send-reply':
      return replies?.send(cmd.messageId);
  }
}
