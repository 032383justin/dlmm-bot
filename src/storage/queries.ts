import { db } from './db';

export async function savePool(pool: any): Promise<void> {
  try {
    await db.from('pools').insert(pool);
  } catch (error) {
    console.error('Failed to save pool', error);
  }
}

export async function savePoolSnapshot(snapshot: any): Promise<void> {
  try {
    await db.from('pool_snapshots').insert(snapshot);
  } catch (error) {
    console.error('Failed to save pool snapshot', error);
  }
}

export async function logMessage(level: string, message: string): Promise<void> {
  try {
    await db.from('logs').insert({ level, message });
  } catch (error) {
    console.error('Failed to write log message', error);
  }
}
