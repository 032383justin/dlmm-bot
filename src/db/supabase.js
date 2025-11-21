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
exports.saveSnapshot = exports.logAction = exports.supabase = void 0;
var supabase_js_1 = require("@supabase/supabase-js");
var dotenv_1 = require("dotenv");
var logger_1 = require("../utils/logger");
dotenv_1.default.config();
var supabaseUrl = process.env.SUPABASE_URL;
var supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    logger_1.default.error('Missing Supabase URL or Key in .env');
    // We don't throw here to allow other parts to run if DB is optional, 
    // but for this bot it is required.
    // process.exit(1); 
}
if (!supabaseUrl || !supabaseKey) {
    logger_1.default.error('Missing Supabase URL or Key in .env');
}
// Validate URL format to prevent crash
var isValidUrl = function (url) {
    try {
        new URL(url);
        return true;
    }
    catch (_a) {
        return false;
    }
};
exports.supabase = (supabaseUrl && isValidUrl(supabaseUrl) && supabaseKey)
    ? (0, supabase_js_1.createClient)(supabaseUrl, supabaseKey)
    : {
        from: function () { return ({
            select: function () { return ({ eq: function () { return ({ order: function () { return ({ limit: function () { return ({ data: [], error: 'Mock Client: No DB connection' }); } }); } }); } }); },
            insert: function () { return ({ error: 'Mock Client: No DB connection' }); }
        }); }
    }; // Mock client to prevent crash if config missing
var logAction = function (action, details) { return __awaiter(void 0, void 0, void 0, function () {
    var error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, exports.supabase.from('bot_logs').insert({
                    action: action,
                    details: details,
                    timestamp: new Date().toISOString(),
                })];
            case 1:
                error = (_a.sent()).error;
                if (error) {
                    logger_1.default.error('Failed to log action to Supabase', error);
                }
                return [2 /*return*/];
        }
    });
}); };
exports.logAction = logAction;
var saveSnapshot = function (poolData) { return __awaiter(void 0, void 0, void 0, function () {
    var error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, exports.supabase.from('pool_snapshots').insert({
                    pool_address: poolData.address,
                    data: poolData,
                    timestamp: new Date().toISOString()
                })];
            case 1:
                error = (_a.sent()).error;
                if (error) {
                    logger_1.default.error('Failed to save snapshot', error);
                }
                return [2 /*return*/];
        }
    });
}); };
exports.saveSnapshot = saveSnapshot;
