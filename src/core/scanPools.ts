import axios from 'axios';
import { Connection } from '@solana/web3.js';
import logger from '../utils/logger';
import { getConnection, RPC_URL } from '../config/rpc';

const METEORA_API_URL = 'https://dlmm-api.meteora.ag/pair/all';

// Use centralized RPC connection (no fallback - exits if missing)
export const connection = getConnection();

export interface RawPoolData {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  reserve_x: string;
  reserve_y: string;
  reserve_x_amount: number;
  reserve_y_amount: number;
  bin_step: number;
  base_fee_percentage: string;
  max_fee_percentage: string;
  protocol_fee_percentage: string;
  liquidity: string;
  reward_mint_x: string;
  reward_mint_y: string;
  fees_24h: number;
  today_fees: number;
  trade_volume_24h: number;
  cumulative_trade_volume: string;
  cumulative_fee_volume: string;
  current_price: number;
  apr: number;
  apy: number;
  farm_apr: number;
  farm_apy: number;
  hide: boolean;
}

export const scanPools = async (): Promise<RawPoolData[]> => {
  try {
    logger.info('Scanning DLMM pools from Meteora API...');
    const response = await axios.get(METEORA_API_URL);

    if (response.status !== 200) {
      throw new Error(`Failed to fetch pools: ${response.statusText}`);
    }

    const pools: RawPoolData[] = response.data;
    logger.info(`Fetched ${pools.length} pools.`);
    return pools;
  } catch (error) {
    logger.error('Error scanning pools:', error);
    return [];
  }
};
