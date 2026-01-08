/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RPC INSTRUMENTATION WRAPPER — AUTOMATIC TELEMETRY FOR ALL RPC CALLS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides instrumentation for RPC calls to capture telemetry.
 * It does NOT modify the Connection class directly to avoid TypeScript issues.
 * 
 * USAGE:
 * 1. Use instrumentExternalCall() to wrap any async RPC operation
 * 2. Use recordExternalRpcCall() for manual recording
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Connection } from '@solana/web3.js';
import { recordRpcCall, recordConfirmation } from './executionTelemetry';
import { getConnection as getBaseConnection, RPC_URL } from '../config/rpc';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify an RPC error for telemetry
 */
function classifyError(error: any): 'timeout' | '429' | 'malformed' | 'network' | 'unknown' {
    const message = error?.message?.toLowerCase() || '';
    const code = error?.code;
    
    // Timeout errors
    if (message.includes('timeout') || message.includes('timed out') || code === 'ETIMEDOUT') {
        return 'timeout';
    }
    
    // Rate limit errors
    if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
        return '429';
    }
    
    // Malformed response errors
    if (message.includes('malformed') || message.includes('invalid json') || message.includes('parse error')) {
        return 'malformed';
    }
    
    // Network errors
    if (
        message.includes('network') ||
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('socket') ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND'
    ) {
        return 'network';
    }
    
    return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTRUMENTED CONNECTION (PROXY-BASED)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Methods to instrument for telemetry
 */
const INSTRUMENTED_METHODS = new Set([
    'getSlot',
    'getLatestBlockhash',
    'getBalance',
    'getAccountInfo',
    'getMultipleAccountsInfo',
    'sendTransaction',
    'confirmTransaction',
    'simulateTransaction',
    'getParsedTransaction',
    'getTransaction',
    'getSignaturesForAddress',
    'getTokenAccountBalance',
    'getProgramAccounts',
]);

let instrumentedConnectionInstance: Connection | null = null;
let slotAtLastSend = 0;
let instrumentedLogged = false;

/**
 * Get the singleton instrumented connection.
 * This wraps the base connection with a Proxy for telemetry.
 */
export function getInstrumentedConnection(): Connection {
    if (!instrumentedConnectionInstance) {
        const baseConnection = getBaseConnection();
        
        instrumentedConnectionInstance = new Proxy(baseConnection, {
            get(target, prop, receiver) {
                const original = Reflect.get(target, prop, receiver);
                
                // Only wrap async methods we care about
                if (typeof original === 'function' && INSTRUMENTED_METHODS.has(prop as string)) {
                    return async (...args: any[]) => {
                        const methodName = prop as string;
                        const startTime = Date.now();
                        let success = true;
                        let errorType: 'timeout' | '429' | 'malformed' | 'network' | 'unknown' | undefined;
                        
                        // Track slot for sendTransaction (for confirmation telemetry)
                        if (methodName === 'sendTransaction') {
                            try {
                                slotAtLastSend = await target.getSlot();
                            } catch {
                                slotAtLastSend = 0;
                            }
                        }
                        
                        try {
                            const result = await original.apply(target, args);
                            
                            // Record confirmation telemetry for confirmTransaction
                            if (methodName === 'confirmTransaction' && slotAtLastSend > 0) {
                                try {
                                    const currentSlot = await target.getSlot();
                                    const confirmationTimeMs = Date.now() - startTime;
                                    const signature = typeof args[0] === 'string' 
                                        ? args[0] 
                                        : (args[0] as any)?.signature || 'unknown';
                                    
                                    recordConfirmation(
                                        signature,
                                        slotAtLastSend,
                                        currentSlot,
                                        confirmationTimeMs
                                    );
                                } catch {
                                    // Ignore slot fetch errors for telemetry
                                }
                            }
                            
                            return result;
                        } catch (error: any) {
                            success = false;
                            errorType = classifyError(error);
                            throw error;
                        } finally {
                            const durationMs = Date.now() - startTime;
                            recordRpcCall(methodName, durationMs, success, errorType);
                        }
                    };
                }
                
                return original;
            },
        });
        
        if (!instrumentedLogged) {
            logger.info('[RPC-INSTRUMENT] Instrumented connection initialized');
            instrumentedLogged = true;
        }
    }
    return instrumentedConnectionInstance;
}

/**
 * Wrap an existing connection with instrumentation using a Proxy.
 * Returns the original connection wrapped with telemetry recording.
 */
export function wrapConnectionWithInstrumentation(connection: Connection): Connection {
    return new Proxy(connection, {
        get(target, prop, receiver) {
            const original = Reflect.get(target, prop, receiver);
            
            // Only wrap async methods we care about
            if (typeof original === 'function' && INSTRUMENTED_METHODS.has(prop as string)) {
                return async (...args: any[]) => {
                    const methodName = prop as string;
                    const startTime = Date.now();
                    let success = true;
                    let errorType: 'timeout' | '429' | 'malformed' | 'network' | 'unknown' | undefined;
                    
                    try {
                        const result = await original.apply(target, args);
                        return result;
                    } catch (error: any) {
                        success = false;
                        errorType = classifyError(error);
                        throw error;
                    } finally {
                        const durationMs = Date.now() - startTime;
                        recordRpcCall(methodName, durationMs, success, errorType);
                    }
                };
            }
            
            return original;
        },
    });
}

/**
 * Reset the instrumented connection (for testing or error recovery)
 */
export function resetInstrumentedConnection(): void {
    instrumentedConnectionInstance = null;
    instrumentedLogged = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL INSTRUMENTATION FOR EXTERNAL CALLS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record an RPC call made by external code (e.g., DLMM SDK).
 * Call this when you can't use the instrumented connection directly.
 * 
 * @param methodName - Name of the RPC method
 * @param durationMs - Duration in milliseconds
 * @param success - Whether the call succeeded
 * @param error - Optional error object for classification
 */
export function recordExternalRpcCall(
    methodName: string,
    durationMs: number,
    success: boolean,
    error?: any
): void {
    const errorType = success ? undefined : classifyError(error);
    recordRpcCall(methodName, durationMs, success, errorType);
}

/**
 * Wrap an async function to record its RPC call telemetry.
 * Use this for wrapping SDK calls or other external RPC operations.
 * 
 * @param methodName - Name to record for the call
 * @param fn - Async function to execute and record
 * @returns The result of the function
 */
export async function instrumentExternalCall<T>(
    methodName: string,
    fn: () => Promise<T>
): Promise<T> {
    const startTime = Date.now();
    let success = true;
    let error: any;
    
    try {
        const result = await fn();
        return result;
    } catch (err) {
        success = false;
        error = err;
        throw err;
    } finally {
        const durationMs = Date.now() - startTime;
        recordExternalRpcCall(methodName, durationMs, success, error);
    }
}
