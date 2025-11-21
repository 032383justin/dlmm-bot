// Performance Utilities

/**
 * Memoization cache with TTL support
 */
class MemoCache<T> {
    private cache = new Map<string, { value: T; expires: number }>();

    constructor(private ttlMs: number = 60000) { } // Default 1 minute TTL

    get(key: string): T | undefined {
        const cached = this.cache.get(key);
        if (!cached) return undefined;

        if (Date.now() > cached.expires) {
            this.cache.delete(key);
            return undefined;
        }

        return cached.value;
    }

    set(key: string, value: T): void {
        this.cache.set(key, {
            value,
            expires: Date.now() + this.ttlMs,
        });
    }

    clear(): void {
        this.cache.clear();
    }

    size(): number {
        return this.cache.size;
    }
}

/**
 * Batch process array items with concurrency limit
 */
export async function batchProcess<T, R>(
    items: readonly T[],
    processor: (item: T) => Promise<R>,
    concurrency: number = 5
): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }

    return results;
}

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            if (attempt < maxRetries - 1) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: any[]) => any>(
    fn: T,
    delayMs: number
): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout | undefined;

    return (...args: Parameters<T>) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delayMs);
    };
}

/**
 * Create a memoized version of a function
 */
export function memoize<T extends (...args: any[]) => any>(
    fn: T,
    ttlMs: number = 60000
): T {
    const cache = new MemoCache<ReturnType<T>>(ttlMs);

    return ((...args: Parameters<T>) => {
        const key = JSON.stringify(args);
        const cached = cache.get(key);

        if (cached !== undefined) return cached;

        const result = fn(...args);
        cache.set(key, result);
        return result;
    }) as T;
}

/**
 * Limit array size and remove oldest items
 */
export function limitArraySize<T>(arr: T[], maxSize: number): T[] {
    if (arr.length <= maxSize) return arr;
    return arr.slice(arr.length - maxSize);
}

/**
 * Calculate percentile of an array
 */
export function percentile(arr: readonly number[], p: number): number {
    if (arr.length === 0) return 0;

    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

/**
 * Safe division (returns 0 instead of Infinity/NaN)
 */
export function safeDivide(numerator: number, denominator: number): number {
    if (denominator === 0 || !isFinite(denominator)) return 0;
    const result = numerator / denominator;
    return isFinite(result) ? result : 0;
}

export { MemoCache };
