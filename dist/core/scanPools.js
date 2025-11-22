"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanPools = exports.connection = void 0;
const axios_1 = __importDefault(require("axios"));
const web3_js_1 = require("@solana/web3.js");
const logger_1 = __importDefault(require("../utils/logger"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const METEORA_API_URL = 'https://dlmm-api.meteora.ag/pair/all';
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    logger_1.default.error('RPC_URL is not defined in .env');
}
exports.connection = new web3_js_1.Connection(RPC_URL || 'https://api.mainnet-beta.solana.com');
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