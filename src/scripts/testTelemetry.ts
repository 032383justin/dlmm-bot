/**
 * Test script to verify DLMM telemetry fetching
 * 
 * Run with: npx ts-node src/scripts/testTelemetry.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

// Meteora lb_clmm program ID
const LB_CLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const MAX_BIN_PER_ARRAY = 70;

// Known active Meteora DLMM pools (from API with >$100k TVL and volume)
const TEST_POOLS = [
    'J7z6TZgWecZughSLJ41FsttUBTjH5oX3CQ5ZmD182BpD', // AVICI-SOL - $664k TVL, $2.6M volume
    '3Mt1bpU3fnSXyPEm66HKKXyQTpLWrwYziPLqwTqK4ZT7', // ORE-SOL - $295k TVL, $1.8M volume
];

function getConnection(): Connection {
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    console.log(`Using RPC: ${rpcUrl.slice(0, 50)}...`);
    return new Connection(rpcUrl, 'confirmed');
}

function deriveBinArrayPDA(lbPair: PublicKey, index: number): PublicKey {
    const indexBuffer = Buffer.alloc(8);
    indexBuffer.writeBigInt64LE(BigInt(index));
    
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('bin_array'),
            lbPair.toBuffer(),
            indexBuffer,
        ],
        LB_CLMM_PROGRAM_ID
    );
    return pda;
}

async function testPool(poolAddress: string): Promise<void> {
    const connection = getConnection();
    const poolPk = new PublicKey(poolAddress);
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`Testing pool: ${poolAddress}`);
    console.log(`═══════════════════════════════════════════════════════`);
    
    try {
        // 1. Fetch pool account
        console.log('Fetching pool account...');
        const accountInfo = await connection.getAccountInfo(poolPk);
        
        if (!accountInfo) {
            console.log('❌ Pool account not found');
            return;
        }
        
        console.log(`✅ Account found - size: ${accountInfo.data.length} bytes, owner: ${accountInfo.owner.toString()}`);
        
        // Check if it's a Meteora DLMM pool
        if (!accountInfo.owner.equals(LB_CLMM_PROGRAM_ID)) {
            console.log(`❌ Not a Meteora DLMM pool. Owner: ${accountInfo.owner.toString()}`);
            return;
        }
        console.log('✅ Confirmed Meteora DLMM pool');
        
        // 2. Try to decode activeBin from various offsets
        console.log('\nSearching for activeBin...');
        const data = accountInfo.data;
        
        // Meteora LbPair layout (simplified):
        // Discriminator: 8 bytes
        // StaticParameters: ~40 bytes  
        // VariableParameters: ~8 bytes
        // active_id: i32 at offset ~56 (but could vary)
        
        // Known offsets where active_id might be in Meteora DLMM
        const ACTIVE_ID_OFFSETS = [136, 140, 144, 56, 60, 64, 48, 52];
        
        let activeBin = 0;
        const candidates: { offset: number; value: number }[] = [];
        
        // Check specific known offsets first
        for (const offset of ACTIVE_ID_OFFSETS) {
            if (offset + 4 <= data.length) {
                const value = data.readInt32LE(offset);
                if (value >= -50000 && value <= 50000) {
                    candidates.push({ offset, value });
                    console.log(`  Candidate offset ${offset}: ${value}`);
                }
            }
        }
        
        // Also scan the rest
        console.log('\nAll i32 values in first 200 bytes:');
        for (let offset = 0; offset < Math.min(200, data.length - 4); offset += 4) {
            const value = data.readInt32LE(offset);
            if (value >= -10000 && value <= 50000 && value !== 0 && Math.abs(value) > 10) {
                console.log(`  offset ${offset}: ${value}`);
            }
        }
        
        // CORRECT OFFSET: active_id is at offset 48 in Meteora DLMM LbPair account
        if (48 + 4 <= data.length) {
            activeBin = data.readInt32LE(48);
            console.log(`\n✅ Using activeBin from offset 48: ${activeBin}`);
        }
        
        // Also check offset 76 (seems to be a copy)
        if (76 + 4 <= data.length) {
            const activeBin76 = data.readInt32LE(76);
            console.log(`   Verified at offset 76: ${activeBin76} (should match)`);
        }
        
        // 3. Fetch bin arrays
        const binArrayIndex = Math.floor(activeBin / MAX_BIN_PER_ARRAY);
        console.log(`\nBin array index: ${binArrayIndex} (activeBin ${activeBin} / ${MAX_BIN_PER_ARRAY})`);
        
        const indicesToFetch = [binArrayIndex - 1, binArrayIndex, binArrayIndex + 1];
        
        for (const index of indicesToFetch) {
            const binArrayPDA = deriveBinArrayPDA(poolPk, index);
            console.log(`\nFetching bin array ${index}: ${binArrayPDA.toString()}`);
            
            try {
                const binArrayInfo = await connection.getAccountInfo(binArrayPDA);
                
                if (!binArrayInfo) {
                    console.log(`  ❌ Bin array ${index} not found (PDA doesn't exist)`);
                    continue;
                }
                
                console.log(`  ✅ Found - size: ${binArrayInfo.data.length} bytes`);
                
                // Try to decode bins
                const BIN_SIZE = 96;
                const BINS_OFFSET = 56;
                
                let binsWithLiquidity = 0;
                let totalLiqX = BigInt(0);
                let totalLiqY = BigInt(0);
                
                for (let i = 0; i < MAX_BIN_PER_ARRAY; i++) {
                    const binOffset = BINS_OFFSET + (i * BIN_SIZE);
                    if (binOffset + 16 > binArrayInfo.data.length) break;
                    
                    const amountX = binArrayInfo.data.readBigUInt64LE(binOffset);
                    const amountY = binArrayInfo.data.readBigUInt64LE(binOffset + 8);
                    
                    if (amountX > 0 || amountY > 0) {
                        binsWithLiquidity++;
                        totalLiqX += amountX;
                        totalLiqY += amountY;
                    }
                }
                
                console.log(`  Bins with liquidity: ${binsWithLiquidity}`);
                console.log(`  Total liquidityX: ${totalLiqX.toString()}`);
                console.log(`  Total liquidityY: ${totalLiqY.toString()}`);
                
            } catch (err: any) {
                console.log(`  ❌ Error fetching bin array ${index}: ${err.message}`);
            }
        }
        
    } catch (err: any) {
        console.log(`❌ Error: ${err.message}`);
    }
}

async function main() {
    console.log('=== DLMM Telemetry Test ===\n');
    
    for (const pool of TEST_POOLS) {
        await testPool(pool);
    }
    
    console.log('\n=== Test Complete ===');
}

main().catch(console.error);

