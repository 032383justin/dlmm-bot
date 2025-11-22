"use strict";
// Performance Utilities
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoCache = void 0;
exports.batchProcess = batchProcess;
exports.retryWithBackoff = retryWithBackoff;
exports.debounce = debounce;
exports.memoize = memoize;
exports.limitArraySize = limitArraySize;
exports.percentile = percentile;
exports.safeDivide = safeDivide;
/**
 * Memoization cache with TTL support
 */
class MemoCache {
    constructor(ttlMs = 60000) {
        this.ttlMs = ttlMs;
        this.cache = new Map();
    } // Default 1 minute TTL
    get(key) {
        const cached = this.cache.get(key);
        if (!cached)
            return undefined;
        if (Date.now() > cached.expires) {
            this.cache.delete(key);
            return undefined;
        }
        return cached.value;
    }
    set(key, value) {
        this.cache.set(key, {
            value,
            expires: Date.now() + this.ttlMs,
        });
    }
    clear() {
        this.cache.clear();
    }
    size() {
        return this.cache.size;
    }
}
exports.MemoCache = MemoCache;
/**
 * Batch process array items with concurrency limit
 */
async function batchProcess(items, processor, concurrency = 5) {
    const results = [];
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
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
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
function debounce(fn, delayMs) {
    let timeoutId;
    return (...args) => {
        if (timeoutId)
            clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delayMs);
    };
}
/**
 * Create a memoized version of a function
 */
function memoize(fn, ttlMs = 60000) {
    const cache = new MemoCache(ttlMs);
    return ((...args) => {
        const key = JSON.stringify(args);
        const cached = cache.get(key);
        if (cached !== undefined)
            return cached;
        const result = fn(...args);
        cache.set(key, result);
        return result;
    });
}
/**
 * Limit array size and remove oldest items
 */
function limitArraySize(arr, maxSize) {
    if (arr.length <= maxSize)
        return arr;
    return arr.slice(arr.length - maxSize);
}
/**
 * Calculate percentile of an array
 */
function percentile(arr, p) {
    if (arr.length === 0)
        return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}
/**
 * Safe division (returns 0 instead of Infinity/NaN)
 */
function safeDivide(numerator, denominator) {
    if (denominator === 0 || !isFinite(denominator))
        return 0;
    const result = numerator / denominator;
    return isFinite(result) ? result : 0;
}
//# sourceMappingURL=performance.js.map