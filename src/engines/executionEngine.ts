/**
 * ExecutionEngine.ts
 * 
 * Self-contained execution engine for DLMM bot.
 * Handles pool selection, LP placement, risk controls, and position management.
 * 
 * All execution is simulated - no RPC calls, no transactions.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scored pool from discovery/scoring pipeline
 */
export interface ScoredPool {
    address: string;
    score: number;
    symbol: string;
    liquidity: number;
    activeBin: number;
    binCount: number;
    volume24h: number;
}

/**
 * Active LP position state
 */
export interface ActivePosition {
    address: string;
    bins: number[];
    capital: number;
    entryScore: number;
    entryTime: number;
    entryLiquidity: number;
    peakScore: number;
    symbol: string;
}

/**
 * Constructor parameters
 */
export interface ExecutionEngineParams {
    startingCapital: number;
    onPlace?: (pos: ActivePosition) => void;
    onExit?: (pos: ActivePosition, reason: string) => void;
}

/**
 * Equity snapshot for tracking
 */
interface EquitySnapshot {
    timestamp: number;
    equity: number;
    realizedPnL: number;
    unrealizedPnL: number;
}

/**
 * Pool state from previous cycle (for TVL tracking)
 */
interface PreviousPoolState {
    liquidity: number;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_POSITIONS = 3;
const ALLOCATIONS: readonly [number, number, number] = [0.40, 0.30, 0.30];
const GAUSSIAN_WIDTH_FACTOR = 0.08;
const MIN_GAUSSIAN_WIDTH = 2;

// Risk thresholds
const GLOBAL_DRAWDOWN_THRESHOLD = 0.05;  // 5%
const SCORE_DROP_THRESHOLD = 0.15;        // 15%
const TVL_SHRINK_THRESHOLD = 0.12;        // 12%

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
    private readonly startingCapital: number;
    private readonly onPlace: ((pos: ActivePosition) => void) | undefined;
    private readonly onExit: ((pos: ActivePosition, reason: string) => void) | undefined;

    // Position state
    private positions: Map<string, ActivePosition> = new Map();
    
    // Equity tracking
    private realizedPnL: number = 0;
    private peakEquity: number;
    private equityHistory: EquitySnapshot[] = [];
    
    // Previous cycle state for TVL tracking
    private previousPoolStates: Map<string, PreviousPoolState> = new Map();

    constructor(params: ExecutionEngineParams) {
        this.startingCapital = params.startingCapital;
        this.peakEquity = params.startingCapital;
        this.onPlace = params.onPlace;
        this.onExit = params.onExit;

        this.log('Engine initialized', {
            startingCapital: this.startingCapital,
            maxPositions: MAX_POSITIONS,
            allocations: ALLOCATIONS.map(a => `${a * 100}%`).join('/'),
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Place positions in top scored pools
     */
    public async placePositions(pools: ScoredPool[]): Promise<void> {
        this.log('═══════════════════════════════════════════════════════════════');
        this.log('placePositions called', { poolCount: pools.length });

        // Check global drawdown first
        if (this.isGlobalDrawdownBreached()) {
            this.log('⚠️ Global drawdown breached - exiting all positions');
            await this.exitAll('GLOBAL_DRAWDOWN');
            return;
        }

        // Store previous pool states for TVL tracking
        this.updatePreviousPoolStates(pools);

        // Sort by score descending
        const sorted = this.sortByScore(pools);

        // Select top pools we don't already have positions in
        const availablePools = sorted.filter(p => !this.positions.has(p.address));
        const slotsAvailable = MAX_POSITIONS - this.positions.size;
        const poolsToPlace = availablePools.slice(0, slotsAvailable);

        if (poolsToPlace.length === 0) {
            this.log('No new positions to place');
            return;
        }

        // Calculate available capital
        const deployedCapital = this.getTotalDeployedCapital();
        const availableCapital = this.startingCapital - deployedCapital + this.realizedPnL;

        this.log('Capital status', {
            starting: this.startingCapital,
            deployed: deployedCapital,
            realized: this.realizedPnL,
            available: availableCapital,
        });

        // Place positions
        for (let i = 0; i < poolsToPlace.length; i++) {
            const pool = poolsToPlace[i];
            const allocationIndex = this.positions.size;  // Current position count
            const allocation = ALLOCATIONS[allocationIndex] ?? 0.30;
            const capital = availableCapital * allocation;

            await this.placePosition(pool, capital);
        }

        // Update equity tracking
        this.updateEquitySnapshot();

        this.log('placePositions complete', {
            totalPositions: this.positions.size,
            totalDeployed: this.getTotalDeployedCapital(),
        });
    }

    /**
     * Rebalance existing positions based on current pool data
     */
    public async rebalance(pools: ScoredPool[]): Promise<void> {
        this.log('═══════════════════════════════════════════════════════════════');
        this.log('rebalance called', { poolCount: pools.length });

        // Check global drawdown
        if (this.isGlobalDrawdownBreached()) {
            this.log('⚠️ Global drawdown breached - exiting all positions');
            await this.exitAll('GLOBAL_DRAWDOWN');
            return;
        }

        // Build pool lookup
        const poolMap = new Map<string, ScoredPool>();
        for (const pool of pools) {
            poolMap.set(pool.address, pool);
        }

        // Check each position for exit conditions
        const positionsToExit: Array<{ address: string; reason: string }> = [];

        for (const [address, position] of this.positions) {
            const currentPool = poolMap.get(address);
            
            if (!currentPool) {
                positionsToExit.push({ address, reason: 'POOL_NOT_FOUND' });
                continue;
            }

            // Check score drop
            const scoreDrop = this.calculateScoreDrop(position, currentPool.score);
            if (scoreDrop >= SCORE_DROP_THRESHOLD) {
                positionsToExit.push({ 
                    address, 
                    reason: `SCORE_DROP_${(scoreDrop * 100).toFixed(1)}%` 
                });
                continue;
            }

            // Check TVL shrink
            const tvlShrink = this.calculateTVLShrink(address, currentPool.liquidity);
            if (tvlShrink >= TVL_SHRINK_THRESHOLD) {
                positionsToExit.push({ 
                    address, 
                    reason: `TVL_SHRINK_${(tvlShrink * 100).toFixed(1)}%` 
                });
                continue;
            }

            // Update peak score if current is higher
            if (currentPool.score > position.peakScore) {
                position.peakScore = currentPool.score;
            }
        }

        // Execute exits
        for (const { address, reason } of positionsToExit) {
            await this.exitPosition(address, reason);
        }

        // Update previous pool states
        this.updatePreviousPoolStates(pools);

        // Update equity
        this.updateEquitySnapshot();

        // Try to fill vacant slots
        if (this.positions.size < MAX_POSITIONS) {
            await this.placePositions(pools);
        }

        this.log('rebalance complete', {
            exited: positionsToExit.length,
            remaining: this.positions.size,
        });
    }

    /**
     * Exit all positions
     */
    public async exitAll(reason: string = 'MANUAL'): Promise<void> {
        this.log('exitAll called', { reason, positionCount: this.positions.size });

        const addresses = Array.from(this.positions.keys());
        
        for (const address of addresses) {
            await this.exitPosition(address, reason);
        }

        this.log('exitAll complete');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    private async placePosition(pool: ScoredPool, capital: number): Promise<void> {
        const bins = this.calculateGaussianBins(pool.activeBin, pool.binCount);
        const liquidityPerBin = capital / bins.length;

        const position: ActivePosition = {
            address: pool.address,
            bins,
            capital,
            entryScore: pool.score,
            entryTime: Date.now(),
            entryLiquidity: pool.liquidity,
            peakScore: pool.score,
            symbol: pool.symbol,
        };

        this.positions.set(pool.address, position);

        this.log('✅ Position placed', {
            symbol: pool.symbol,
            address: this.truncateAddress(pool.address),
            capital: capital.toFixed(2),
            bins: bins.length,
            liquidityPerBin: liquidityPerBin.toFixed(2),
            range: `${bins[0]} → ${bins[bins.length - 1]}`,
            activeBin: pool.activeBin,
        });

        if (this.onPlace) {
            this.onPlace(position);
        }
    }

    private async exitPosition(address: string, reason: string): Promise<void> {
        const position = this.positions.get(address);
        if (!position) {
            this.log('⚠️ Position not found for exit', { address: this.truncateAddress(address) });
            return;
        }

        // Simulate PnL realization
        const pnl = this.calculateUnrealizedPnL(position, position.peakScore);
        this.realizedPnL += pnl;

        this.positions.delete(address);

        this.log('🚨 Position exited', {
            symbol: position.symbol,
            address: this.truncateAddress(address),
            reason,
            capital: position.capital.toFixed(2),
            pnl: pnl.toFixed(2),
            holdTime: this.formatDuration(Date.now() - position.entryTime),
        });

        if (this.onExit) {
            this.onExit(position, reason);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GAUSSIAN BIN CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════

    private calculateGaussianBins(activeBin: number, binCount: number): number[] {
        // Calculate width: max(2, floor(binCount * 0.08))
        const width = Math.max(MIN_GAUSSIAN_WIDTH, Math.floor(binCount * GAUSSIAN_WIDTH_FACTOR));
        
        const bins: number[] = [];
        const center = activeBin;

        // Place bins from center - width to center + width
        for (let offset = -width; offset <= width; offset++) {
            bins.push(center + offset);
        }

        this.log('Gaussian bins calculated', {
            center,
            width,
            binCount: bins.length,
            range: `${bins[0]} → ${bins[bins.length - 1]}`,
        });

        return bins;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RISK CALCULATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    private isGlobalDrawdownBreached(): boolean {
        const currentEquity = this.calculateCurrentEquity();
        const drawdown = (this.peakEquity - currentEquity) / this.peakEquity;

        if (drawdown >= GLOBAL_DRAWDOWN_THRESHOLD) {
            this.log('⚠️ Global drawdown check', {
                currentEquity: currentEquity.toFixed(2),
                peakEquity: this.peakEquity.toFixed(2),
                drawdown: `${(drawdown * 100).toFixed(2)}%`,
                threshold: `${GLOBAL_DRAWDOWN_THRESHOLD * 100}%`,
                breached: true,
            });
            return true;
        }

        return false;
    }

    private calculateScoreDrop(position: ActivePosition, currentScore: number): number {
        const drop = (position.peakScore - currentScore) / position.peakScore;
        return Math.max(0, drop);
    }

    private calculateTVLShrink(address: string, currentLiquidity: number): number {
        const previous = this.previousPoolStates.get(address);
        if (!previous) {
            return 0;
        }

        const shrink = (previous.liquidity - currentLiquidity) / previous.liquidity;
        return Math.max(0, shrink);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EQUITY & PNL CALCULATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    private calculateCurrentEquity(): number {
        const deployedCapital = this.getTotalDeployedCapital();
        const unrealizedPnL = this.getTotalUnrealizedPnL();
        return this.startingCapital - deployedCapital + deployedCapital + unrealizedPnL + this.realizedPnL;
    }

    private calculateUnrealizedPnL(position: ActivePosition, currentScore: number): number {
        // unrealizedPnL = (currentScore / entryScore - 1) * capital
        const scoreRatio = currentScore / position.entryScore;
        return (scoreRatio - 1) * position.capital;
    }

    private getTotalDeployedCapital(): number {
        let total = 0;
        for (const position of this.positions.values()) {
            total += position.capital;
        }
        return total;
    }

    private getTotalUnrealizedPnL(): number {
        let total = 0;
        for (const position of this.positions.values()) {
            total += this.calculateUnrealizedPnL(position, position.peakScore);
        }
        return total;
    }

    private updateEquitySnapshot(): void {
        const currentEquity = this.calculateCurrentEquity();

        // Update peak if new high
        if (currentEquity > this.peakEquity) {
            this.peakEquity = currentEquity;
        }

        const snapshot: EquitySnapshot = {
            timestamp: Date.now(),
            equity: currentEquity,
            realizedPnL: this.realizedPnL,
            unrealizedPnL: this.getTotalUnrealizedPnL(),
        };

        this.equityHistory.push(snapshot);

        // Keep last 1000 snapshots
        if (this.equityHistory.length > 1000) {
            this.equityHistory.shift();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    private updatePreviousPoolStates(pools: ScoredPool[]): void {
        for (const pool of pools) {
            this.previousPoolStates.set(pool.address, {
                liquidity: pool.liquidity,
                timestamp: Date.now(),
            });
        }
    }

    private sortByScore(pools: ScoredPool[]): ScoredPool[] {
        return [...pools].sort((a, b) => b.score - a.score);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC ACCESSORS
    // ═══════════════════════════════════════════════════════════════════════════

    public getPositions(): ActivePosition[] {
        return Array.from(this.positions.values());
    }

    public getPosition(address: string): ActivePosition | undefined {
        return this.positions.get(address);
    }

    public getEquity(): number {
        return this.calculateCurrentEquity();
    }

    public getPeakEquity(): number {
        return this.peakEquity;
    }

    public getDrawdown(): number {
        const currentEquity = this.calculateCurrentEquity();
        return (this.peakEquity - currentEquity) / this.peakEquity;
    }

    public getRealizedPnL(): number {
        return this.realizedPnL;
    }

    public getUnrealizedPnL(): number {
        return this.getTotalUnrealizedPnL();
    }

    public getEquityHistory(): EquitySnapshot[] {
        return [...this.equityHistory];
    }

    public getStatus(): {
        positionCount: number;
        deployedCapital: number;
        equity: number;
        peakEquity: number;
        drawdown: number;
        realizedPnL: number;
        unrealizedPnL: number;
    } {
        return {
            positionCount: this.positions.size,
            deployedCapital: this.getTotalDeployedCapital(),
            equity: this.calculateCurrentEquity(),
            peakEquity: this.peakEquity,
            drawdown: this.getDrawdown(),
            realizedPnL: this.realizedPnL,
            unrealizedPnL: this.getTotalUnrealizedPnL(),
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY METHODS
    // ═══════════════════════════════════════════════════════════════════════════

    private truncateAddress(address: string): string {
        if (address.length <= 12) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        }
        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    }

    private log(message: string, data?: Record<string, unknown>): void {
        const timestamp = new Date().toISOString();
        if (data) {
            console.log(`[${timestamp}] [EXECUTION] ${message}`, JSON.stringify(data));
        } else {
            console.log(`[${timestamp}] [EXECUTION] ${message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default ExecutionEngine;
