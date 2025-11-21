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
var scanPools_1 = require("./core/scanPools");
var normalizePools_1 = require("./core/normalizePools");
var safetyFilters_1 = require("./core/safetyFilters");
var volume_1 = require("./core/volume");
var dilution_1 = require("./core/dilution");
var scorePool_1 = require("./scoring/scorePool");
var supabase_1 = require("./db/supabase");
var logger_1 = require("./utils/logger");
var dotenv_1 = require("dotenv");
dotenv_1.default.config();
var LOOP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
var MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
// Paper Trading Mode
var PAPER_TRADING = process.env.PAPER_TRADING === 'true';
var PAPER_CAPITAL = parseFloat(process.env.PAPER_CAPITAL || '10000');
var paperTradingBalance = PAPER_CAPITAL;
var paperTradingPnL = 0;
var activePositions = [];
// Token categorization for diversification
var categorizeToken = function (pool) {
    var name = pool.name.toUpperCase();
    // Stablecoin pairs
    if (name.includes('USDC') || name.includes('USDT') || name.includes('DAI')) {
        return 'stable';
    }
    // Blue-chip tokens
    var blueChips = ['SOL', 'BTC', 'ETH', 'JLP', 'JUP'];
    for (var _i = 0, blueChips_1 = blueChips; _i < blueChips_1.length; _i++) {
        var chip = blueChips_1[_i];
        if (name.includes(chip) && !name.includes('WOJAK') && !name.includes('FART')) {
            return 'blue-chip';
        }
    }
    // Everything else is a meme/alt
    return 'meme';
};
var runBot = function () { return __awaiter(void 0, void 0, void 0, function () {
    var startTime, rawPools, pools, candidates, topCandidates, _i, topCandidates_1, pool, _a, sortedPools, topPools, duration, error_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                if (PAPER_TRADING) {
                    logger_1.default.info('🎮 PAPER TRADING MODE ENABLED 🎮');
                    logger_1.default.info("Starting Capital: $".concat(PAPER_CAPITAL.toFixed(2)));
                    logger_1.default.info('No real money will be used. All trades are simulated.');
                }
                else {
                    logger_1.default.info('Starting DLMM Rotation Bot...');
                    logger_1.default.warn('⚠️  LIVE TRADING MODE - Real money at risk!');
                }
                _b.label = 1;
            case 1:
                if (!true) return [3 /*break*/, 13];
                _b.label = 2;
            case 2:
                _b.trys.push([2, 10, , 11]);
                logger_1.default.info('--- Starting Scan Cycle ---');
                startTime = Date.now();
                return [4 /*yield*/, (0, scanPools_1.scanPools)()];
            case 3:
                rawPools = _b.sent();
                pools = (0, normalizePools_1.normalizePools)(rawPools);
                candidates = pools.filter(function (p) {
                    var _a = (0, safetyFilters_1.applySafetyFilters)(p), passed = _a.passed, reason = _a.reason;
                    return passed;
                });
                logger_1.default.info("Found ".concat(candidates.length, " candidates after safety filters."));
                topCandidates = candidates.sort(function (a, b) { return b.volume24h - a.volume24h; }).slice(0, 50);
                _i = 0, topCandidates_1 = topCandidates;
                _b.label = 4;
            case 4:
                if (!(_i < topCandidates_1.length)) return [3 /*break*/, 8];
                pool = topCandidates_1[_i];
                _a = pool;
                return [4 /*yield*/, (0, dilution_1.calculateDilutionScore)(pool)];
            case 5:
                _a.dilutionScore = _b.sent();
                pool.riskScore = (0, safetyFilters_1.calculateRiskScore)(pool);
                pool.score = (0, scorePool_1.scorePool)(pool);
                return [4 /*yield*/, (0, supabase_1.saveSnapshot)(pool)];
            case 6:
                _b.sent();
                _b.label = 7;
            case 7:
                _i++;
                return [3 /*break*/, 4];
            case 8:
                sortedPools = topCandidates.sort(function (a, b) { return b.score - a.score; });
                topPools = sortedPools.slice(0, 5);
                logger_1.default.info('Top 5 Pools', { pools: topPools.map(function (p) { return "".concat(p.name, " (").concat(p.score.toFixed(2), ")"); }) });
                // 4. Rotation Engine
                return [4 /*yield*/, manageRotation(sortedPools)];
            case 9:
                // 4. Rotation Engine
                _b.sent();
                duration = Date.now() - startTime;
                logger_1.default.info("Cycle completed in ".concat(duration, "ms. Sleeping..."));
                return [3 /*break*/, 11];
            case 10:
                error_1 = _b.sent();
                logger_1.default.error('Error in main loop:', error_1);
                return [3 /*break*/, 11];
            case 11: return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, LOOP_INTERVAL_MS); })];
            case 12:
                _b.sent();
                return [3 /*break*/, 1];
            case 13: return [2 /*return*/];
        }
    });
}); };
var manageRotation = function (rankedPools) { return __awaiter(void 0, void 0, void 0, function () {
    var now, remainingPositions, exitSignalCount, _loop_1, _i, activePositions_1, pos, targetAllocations, typeCount, _loop_2, i, state_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                now = Date.now();
                remainingPositions = [];
                exitSignalCount = 0;
                _loop_1 = function (pos) {
                    var pool, holdTime, trailingStopPct, trailingStopTriggered, tvlDrop, tvlDropTriggered, velocityDrop, velocityDropTriggered, volumeExitTriggered, shouldExit, reason, holdTimeHours, dailyYield, estimatedReturn;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                pool = rankedPools.find(function (p) { return p.address === pos.poolAddress; });
                                if (!!pool) return [3 /*break*/, 2];
                                logger_1.default.warn("Active pool ".concat(pos.poolAddress, " not found in ranked list. Exiting."));
                                return [4 /*yield*/, (0, supabase_1.logAction)('EXIT', { reason: 'Pool dropped from ranking', pool: pos.poolAddress })];
                            case 1:
                                _b.sent();
                                exitSignalCount++;
                                return [2 /*return*/, "continue"];
                            case 2:
                                holdTime = now - pos.entryTime;
                                // Update peak score for trailing stop-loss
                                if (pool.score > pos.peakScore) {
                                    pos.peakScore = pool.score;
                                }
                                // Min hold time check
                                if (holdTime < MIN_HOLD_TIME_MS) {
                                    remainingPositions.push(pos);
                                    return [2 /*return*/, "continue"];
                                }
                                trailingStopPct = 0.10;
                                trailingStopTriggered = pool.score < (pos.peakScore * (1 - trailingStopPct));
                                tvlDrop = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
                                tvlDropTriggered = tvlDrop > 0.20;
                                velocityDrop = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
                                velocityDropTriggered = velocityDrop > 0.25;
                                return [4 /*yield*/, (0, volume_1.checkVolumeExitTrigger)(pool)];
                            case 3:
                                volumeExitTriggered = _b.sent();
                                shouldExit = trailingStopTriggered || tvlDropTriggered || velocityDropTriggered || volumeExitTriggered;
                                if (!shouldExit) return [3 /*break*/, 5];
                                reason = trailingStopTriggered ? 'Trailing Stop' :
                                    tvlDropTriggered ? 'TVL Drop' :
                                        velocityDropTriggered ? 'Velocity Drop' : 'Volume Exit';
                                // Calculate P&L for paper trading
                                if (PAPER_TRADING) {
                                    holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                                    dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
                                    estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);
                                    paperTradingPnL += estimatedReturn;
                                    paperTradingBalance += estimatedReturn;
                                    logger_1.default.info("[PAPER] Rotating OUT of ".concat(pool.name, ". Reason: ").concat(reason, ". Peak: ").concat(pos.peakScore.toFixed(2), ", Current: ").concat(pool.score.toFixed(2)));
                                    logger_1.default.info("[PAPER] P&L: +$".concat(estimatedReturn.toFixed(2), " | Total P&L: $").concat(paperTradingPnL.toFixed(2), " | Balance: $").concat(paperTradingBalance.toFixed(2)));
                                }
                                else {
                                    logger_1.default.info("Rotating OUT of ".concat(pool.name, ". Reason: ").concat(reason, ". Peak: ").concat(pos.peakScore.toFixed(2), ", Current: ").concat(pool.score.toFixed(2)));
                                }
                                return [4 /*yield*/, (0, supabase_1.logAction)('EXIT', {
                                        pool: pool.address,
                                        reason: reason,
                                        peakScore: pos.peakScore,
                                        currentScore: pool.score,
                                        paperTrading: PAPER_TRADING,
                                        paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
                                    })];
                            case 4:
                                _b.sent();
                                exitSignalCount++;
                                return [3 /*break*/, 6];
                            case 5:
                                remainingPositions.push(pos);
                                _b.label = 6;
                            case 6: return [2 /*return*/];
                        }
                    });
                };
                _i = 0, activePositions_1 = activePositions;
                _a.label = 1;
            case 1:
                if (!(_i < activePositions_1.length)) return [3 /*break*/, 4];
                pos = activePositions_1[_i];
                return [5 /*yield**/, _loop_1(pos)];
            case 2:
                _a.sent();
                _a.label = 3;
            case 3:
                _i++;
                return [3 /*break*/, 1];
            case 4:
                if (!(exitSignalCount >= 3 && activePositions.length >= 3)) return [3 /*break*/, 6];
                logger_1.default.warn("MARKET CRASH DETECTED: ".concat(exitSignalCount, " pools triggering exit. Exiting ALL positions."));
                activePositions = [];
                return [4 /*yield*/, (0, supabase_1.logAction)('MARKET_CRASH_EXIT', { exitSignalCount: exitSignalCount })];
            case 5:
                _a.sent();
                return [2 /*return*/]; // Skip entry logic this cycle
            case 6:
                activePositions = remainingPositions;
                targetAllocations = [0.40, 0.25, 0.20, 0.10, 0.05];
                typeCount = {
                    'stable': activePositions.filter(function (p) { return p.tokenType === 'stable'; }).length,
                    'blue-chip': activePositions.filter(function (p) { return p.tokenType === 'blue-chip'; }).length,
                    'meme': activePositions.filter(function (p) { return p.tokenType === 'meme'; }).length
                };
                _loop_2 = function (i) {
                    var candidate, candidateType, entrySignal, totalCapital, targetPct, amount, maxAllowed, prefix;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0:
                                if (activePositions.length >= 5)
                                    return [2 /*return*/, "break"];
                                candidate = rankedPools[i];
                                if (!candidate)
                                    return [2 /*return*/, "break"];
                                // Check if already active
                                if (activePositions.find(function (p) { return p.poolAddress === candidate.address; }))
                                    return [2 /*return*/, "continue"];
                                candidateType = categorizeToken(candidate);
                                if (typeCount[candidateType] >= 2) {
                                    logger_1.default.info("Skipping ".concat(candidate.name, " - already have 2 ").concat(candidateType, " positions"));
                                    return [2 /*return*/, "continue"];
                                }
                                return [4 /*yield*/, (0, volume_1.checkVolumeEntryTrigger)(candidate)];
                            case 1:
                                entrySignal = _c.sent();
                                if (!entrySignal) return [3 /*break*/, 3];
                                totalCapital = parseFloat(process.env.TOTAL_CAPITAL || '10000');
                                targetPct = targetAllocations[activePositions.length];
                                amount = totalCapital * targetPct;
                                // Dynamic Position Sizing based on volatility (simplified - using TVL as proxy)
                                // Smaller pools = more volatile = smaller position
                                if (candidate.liquidity < 100000) {
                                    amount *= 0.5; // Half size for small pools
                                    logger_1.default.info("Reducing position size for ".concat(candidate.name, " due to low TVL"));
                                }
                                maxAllowed = candidate.liquidity * 0.05;
                                if (amount > maxAllowed) {
                                    logger_1.default.warn("Capping allocation for ".concat(candidate.name, ". Target: $").concat(amount.toFixed(0), ", Max Allowed (5% TVL): $").concat(maxAllowed.toFixed(0)));
                                    amount = maxAllowed;
                                }
                                prefix = PAPER_TRADING ? '[PAPER] ' : '';
                                logger_1.default.info("".concat(prefix, "Rotating INTO ").concat(candidate.name, ". Score: ").concat(candidate.score.toFixed(2), ". Allocating: $").concat(amount.toFixed(0)));
                                activePositions.push({
                                    poolAddress: candidate.address,
                                    entryTime: now,
                                    entryScore: candidate.score,
                                    peakScore: candidate.score,
                                    amount: amount,
                                    entryTVL: candidate.liquidity,
                                    entryVelocity: candidate.velocity,
                                    consecutiveCycles: 1,
                                    tokenType: candidateType
                                });
                                return [4 /*yield*/, (0, supabase_1.logAction)('ENTRY', {
                                        pool: candidate.address,
                                        score: candidate.score,
                                        amount: amount,
                                        type: candidateType,
                                        paperTrading: PAPER_TRADING,
                                        paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
                                    })];
                            case 2:
                                _c.sent();
                                // Update type count
                                typeCount[candidateType]++;
                                _c.label = 3;
                            case 3: return [2 /*return*/];
                        }
                    });
                };
                i = 0;
                _a.label = 7;
            case 7:
                if (!(i < 5)) return [3 /*break*/, 10];
                return [5 /*yield**/, _loop_2(i)];
            case 8:
                state_1 = _a.sent();
                if (state_1 === "break")
                    return [3 /*break*/, 10];
                _a.label = 9;
            case 9:
                i++;
                return [3 /*break*/, 7];
            case 10: return [2 /*return*/];
        }
    });
}); };
// Start
runBot();
