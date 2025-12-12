"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanPools = exports.connection = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = __importDefault(require("../utils/logger"));
const rpc_1 = require("../config/rpc");
const METEORA_API_URL = 'https://dlmm-api.meteora.ag/pair/all';
// Use centralized RPC connection (no fallback - exits if missing)
exports.connection = (0, rpc_1.getConnection)();
const scanPools = async () => {
    try {
        logger_1.default.info('Scanning DLMM pools from Meteora API...');
        const response = await axios_1.default.get(METEORA_API_URL);
        if (response.status !== 200) {
            throw new Error(`Failed to fetch pools: ${response.statusText}`);
        }
        const pools = response.data;
        logger_1.default.info(`Fetched ${pools.length} pools.`);
        return pools;
    }
    catch (error) {
        logger_1.default.error('Error scanning pools:', error);
        return [];
    }
};
exports.scanPools = scanPools;
//# sourceMappingURL=scanPools.js.map