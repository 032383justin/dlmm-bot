"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkVolumeExitTrigger = exports.checkVolumeEntryTrigger = void 0;
var supabase_1 = require("../db/supabase");
var math_1 = require("../utils/math");
var logger_1 = require("../utils/logger");
var checkVolumeEntryTrigger = function (pool) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, data, error, history_1, ma1h, currentVelocity, lastVelocity, isVolumeHigh, isVelocityIncreasing, err_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _b.trys.push([0, 2, , 3]);
                return [4 /*yield*/, supabase_1.supabase
                        .from('pool_snapshots')
                        .select('data')
                        .eq('pool_address', pool.address)
                        .order('timestamp', { ascending: false })
                        .limit(12)];
            case 1:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error || !data || data.length === 0) {
                    // Not enough data, maybe new pool. Default to true if velocity is high? 
                    // Or strict: false. User said "Only enter... when...". Strict.
                    // But for a new bot, we have no history.
                    // We will allow if volume is very high as a bootstrap, but strictly following rules:
                    return [2 /*return*/, false];
                }
                history_1 = data.map(function (d) { return d.data.volume1h; });
                ma1h = (0, math_1.calculateMovingAverage)(history_1);
                currentVelocity = pool.velocity;
                lastVelocity = data[0].data.velocity || 0;
                isVolumeHigh = pool.volume1h > ma1h;
                isVelocityIncreasing = currentVelocity > lastVelocity;
                return [2 /*return*/, isVolumeHigh && isVelocityIncreasing];
            case 2:
                err_1 = _b.sent();
                logger_1.default.error("Error checking volume trigger for ".concat(pool.address), err_1);
                return [2 /*return*/, false];
            case 3: return [2 /*return*/];
        }
    });
}); };
exports.checkVolumeEntryTrigger = checkVolumeEntryTrigger;
var checkVolumeExitTrigger = function (pool) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, data, error, lastSnapshot, lastVelocity, lastTVL, velocityDrop, tvlDrop, volumeHistory, ma4h, velocityTrigger, volumeTrigger, tvlTrigger, err_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _b.trys.push([0, 2, , 3]);
                return [4 /*yield*/, supabase_1.supabase
                        .from('pool_snapshots')
                        .select('data')
                        .eq('pool_address', pool.address)
                        .order('timestamp', { ascending: false })
                        .limit(48)];
            case 1:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error || !data || data.length === 0)
                    return [2 /*return*/, false];
                lastSnapshot = data[0].data;
                lastVelocity = lastSnapshot.velocity || pool.velocity;
                lastTVL = lastSnapshot.liquidity || pool.liquidity;
                velocityDrop = (lastVelocity - pool.velocity) / lastVelocity;
                tvlDrop = (lastTVL - pool.liquidity) / lastTVL;
                volumeHistory = data.map(function (d) { return d.data.volume1h; });
                ma4h = (0, math_1.calculateMovingAverage)(volumeHistory);
                velocityTrigger = velocityDrop > 0.20;
                volumeTrigger = pool.volume1h < ma4h;
                tvlTrigger = tvlDrop > 0.10;
                if (tvlTrigger) {
                    logger_1.default.warn("GUARDRAIL TRIGGERED: TVL dropped by ".concat((tvlDrop * 100).toFixed(2), "% for ").concat(pool.name));
                }
                return [2 /*return*/, velocityTrigger || volumeTrigger || tvlTrigger];
            case 2:
                err_2 = _b.sent();
                logger_1.default.error("Error checking exit trigger for ".concat(pool.address), err_2);
                return [2 /*return*/, false];
            case 3: return [2 /*return*/];
        }
    });
}); };
exports.checkVolumeExitTrigger = checkVolumeExitTrigger;
