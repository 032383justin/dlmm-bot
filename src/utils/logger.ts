import { logMessage } from '../storage/queries';

export async function logInfo(msg: string): Promise<void> {
  console.log('[INFO]', msg);
  await logMessage('info', msg);
}

export async function logWarn(msg: string): Promise<void> {
  console.warn('[WARN]', msg);
  await logMessage('warn', msg);
}

export async function logError(msg: string): Promise<void> {
  console.error('[ERROR]', msg);
  await logMessage('error', msg);
}
