import BigNumber from 'bignumber.js';

export const toBigNumber = (value: string | number): BigNumber => {
    return new BigNumber(value);
};

export const calculateVelocity = (
    volume1h: number,
    volume4h: number,
    volume24h: number
): number => {
    return volume1h * 0.5 + volume4h * 0.3 + volume24h * 0.2;
};

export const calculateMovingAverage = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
};

export const calculatePercentageChange = (
    current: number,
    previous: number
): number => {
    if (previous === 0) return 0;
    return ((current - previous) / previous) * 100;
};
