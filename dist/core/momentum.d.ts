export interface MomentumInput {
    volume1h: number;
    volume4h: number;
}
export interface MomentumResult {
    ratio: number;
    score: number;
    trendingUp: boolean;
}
export declare function computeMomentum(input: MomentumInput): MomentumResult;
//# sourceMappingURL=momentum.d.ts.map