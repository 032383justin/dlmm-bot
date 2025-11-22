"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculatePercentageChange = exports.calculateMovingAverage = exports.calculateVelocity = exports.toBigNumber = void 0;
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const toBigNumber = (value) => {
    return new bignumber_js_1.default(value);
};
exports.toBigNumber = toBigNumber;
const calculateVelocity = (volume1h, volume4h, volume24h) => {
    return volume1h * 0.5 + volume4h * 0.3 + volume24h * 0.2;
};
exports.calculateVelocity = calculateVelocity;
const calculateMovingAverage = (values) => {
    if (values.length === 0)
        return 0;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
};
exports.calculateMovingAverage = calculateMovingAverage;
const calculatePercentageChange = (current, previous) => {
    if (previous === 0)
        return 0;
    return ((current - previous) / previous) * 100;
};
exports.calculatePercentageChange = calculatePercentageChange;
//# sourceMappingURL=math.js.map