/**
 * Memoization cache with TTL support
 */
declare class MemoCache<T> {
    private ttlMs;
    private cache;
    constructor(ttlMs?: number);
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    clear(): void;
    size(): number;
}
/**
 * Batch process array items with concurrency limit
 */
export declare function batchProcess<T, R>(items: readonly T[], processor: (item: T) => Promise<R>, concurrency?: number): Promise<R[]>;
/**
 * Retry function with exponential backoff
 */
export declare function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries?: number, baseDelayMs?: number): Promise<T>;
/**
 * Debounce function calls
 */
export declare function debounce<T extends (...args: any[]) => any>(fn: T, delayMs: number): (...args: Parameters<T>) => void;
/**
 * Create a memoized version of a function
 */
export declare function memoize<T extends (...args: any[]) => any>(fn: T, ttlMs?: number): T;
/**
 * Limit array size and remove oldest items
 */
export declare function limitArraySize<T>(arr: T[], maxSize: number): T[];
/**
 * Calculate percentile of an array
 */
export declare function percentile(arr: readonly number[], p: number): number;
/**
 * Safe division (returns 0 instead of Infinity/NaN)
 */
export declare function safeDivide(numerator: number, denominator: number): number;
export { MemoCache };
//# sourceMappingURL=performance.d.ts.map