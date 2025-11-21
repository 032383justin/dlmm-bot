"use strict";
// Performance Utilities
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
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
var MemoCache = /** @class */ (function () {
    function MemoCache(ttlMs) {
        if (ttlMs === void 0) { ttlMs = 60000; }
        this.ttlMs = ttlMs;
        this.cache = new Map();
    } // Default 1 minute TTL
    MemoCache.prototype.get = function (key) {
        var cached = this.cache.get(key);
        if (!cached)
            return undefined;
        if (Date.now() > cached.expires) {
            this.cache.delete(key);
            return undefined;
        }
        return cached.value;
    };
    MemoCache.prototype.set = function (key, value) {
        this.cache.set(key, {
            value: value,
            expires: Date.now() + this.ttlMs,
        });
    };
    MemoCache.prototype.clear = function () {
        this.cache.clear();
    };
    MemoCache.prototype.size = function () {
        return this.cache.size;
    };
    return MemoCache;
}());
exports.MemoCache = MemoCache;
/**
 * Batch process array items with concurrency limit
 */
function batchProcess(items_1, processor_1) {
    return __awaiter(this, arguments, void 0, function (items, processor, concurrency) {
        var results, i, batch, batchResults;
        if (concurrency === void 0) { concurrency = 5; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    results = [];
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < items.length)) return [3 /*break*/, 4];
                    batch = items.slice(i, i + concurrency);
                    return [4 /*yield*/, Promise.all(batch.map(processor))];
                case 2:
                    batchResults = _a.sent();
                    results.push.apply(results, batchResults);
                    _a.label = 3;
                case 3:
                    i += concurrency;
                    return [3 /*break*/, 1];
                case 4: return [2 /*return*/, results];
            }
        });
    });
}
/**
 * Retry function with exponential backoff
 */
function retryWithBackoff(fn_1) {
    return __awaiter(this, arguments, void 0, function (fn, maxRetries, baseDelayMs) {
        var lastError, _loop_1, attempt, state_1;
        if (maxRetries === void 0) { maxRetries = 3; }
        if (baseDelayMs === void 0) { baseDelayMs = 1000; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _loop_1 = function (attempt) {
                        var _b, error_1, delay_1;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    _c.trys.push([0, 2, , 5]);
                                    _b = {};
                                    return [4 /*yield*/, fn()];
                                case 1: return [2 /*return*/, (_b.value = _c.sent(), _b)];
                                case 2:
                                    error_1 = _c.sent();
                                    lastError = error_1;
                                    if (!(attempt < maxRetries - 1)) return [3 /*break*/, 4];
                                    delay_1 = baseDelayMs * Math.pow(2, attempt);
                                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, delay_1); })];
                                case 3:
                                    _c.sent();
                                    _c.label = 4;
                                case 4: return [3 /*break*/, 5];
                                case 5: return [2 /*return*/];
                            }
                        });
                    };
                    attempt = 0;
                    _a.label = 1;
                case 1:
                    if (!(attempt < maxRetries)) return [3 /*break*/, 4];
                    return [5 /*yield**/, _loop_1(attempt)];
                case 2:
                    state_1 = _a.sent();
                    if (typeof state_1 === "object")
                        return [2 /*return*/, state_1.value];
                    _a.label = 3;
                case 3:
                    attempt++;
                    return [3 /*break*/, 1];
                case 4: throw lastError;
            }
        });
    });
}
/**
 * Debounce function calls
 */
function debounce(fn, delayMs) {
    var timeoutId;
    return function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        if (timeoutId)
            clearTimeout(timeoutId);
        timeoutId = setTimeout(function () { return fn.apply(void 0, args); }, delayMs);
    };
}
/**
 * Create a memoized version of a function
 */
function memoize(fn, ttlMs) {
    if (ttlMs === void 0) { ttlMs = 60000; }
    var cache = new MemoCache(ttlMs);
    return (function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        var key = JSON.stringify(args);
        var cached = cache.get(key);
        if (cached !== undefined)
            return cached;
        var result = fn.apply(void 0, args);
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
    var sorted = __spreadArray([], arr, true).sort(function (a, b) { return a - b; });
    var index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}
/**
 * Safe division (returns 0 instead of Infinity/NaN)
 */
function safeDivide(numerator, denominator) {
    if (denominator === 0 || !isFinite(denominator))
        return 0;
    var result = numerator / denominator;
    return isFinite(result) ? result : 0;
}
