type AsyncTask = () => Promise<void>;

let intervalHandle: NodeJS.Timeout | null = null;
let isRunning = false;

export function runEvery(intervalMs: number, task: AsyncTask): void {
  if (intervalHandle) {
    console.log('Scheduler already running.');
    return;
  }

  intervalHandle = setInterval(async () => {
    if (isRunning) {
      console.log('Task still running, skipping interval tick.');
      return;
    }

    isRunning = true;

    try {
      await task();
    } catch (error) {
      console.error('Scheduled task failed', error);
    } finally {
      isRunning = false;
    }
  }, intervalMs);

  console.log(`Scheduler started with interval ${intervalMs}ms.`);
}

export function stopScheduler(): void {
  if (!intervalHandle) {
    console.log('Scheduler is not running.');
    return;
  }

  clearInterval(intervalHandle);
  intervalHandle = null;
  isRunning = false;
  console.log('Scheduler stopped.');
}
