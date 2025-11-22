"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEvery = runEvery;
exports.stopScheduler = stopScheduler;
let intervalHandle = null;
let isRunning = false;
function runEvery(intervalMs, task) {
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
        }
        catch (error) {
            console.error('Scheduled task failed', error);
        }
        finally {
            isRunning = false;
        }
    }, intervalMs);
    console.log(`Scheduler started with interval ${intervalMs}ms.`);
}
function stopScheduler() {
    if (!intervalHandle) {
        console.log('Scheduler is not running.');
        return;
    }
    clearInterval(intervalHandle);
    intervalHandle = null;
    isRunning = false;
    console.log('Scheduler stopped.');
}
//# sourceMappingURL=scheduler.js.map