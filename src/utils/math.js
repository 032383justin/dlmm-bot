"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculatePercentageChange = exports.calculateMovingAverage = exports.calculateVelocity = exports.toBigNumber = void 0;
var bignumber_js_1 = require("bignumber.js");
var toBigNumber = function (value) {
    return new bignumber_js_1.default(value);
};
exports.toBigNumber = toBigNumber;
var calculateVelocity = function (volume1h, volume4h, volume24h) {
    return volume1h * 0.5 + volume4h * 0.3 + volume24h * 0.2;
};
exports.calculateVelocity = calculateVelocity;
var calculateMovingAverage = function (values) {
    if (values.length === 0)
        return 0;
    var sum = values.reduce(function (a, b) { return a + b; }, 0);
    return sum / values.length;
};
exports.calculateMovingAverage = calculateMovingAverage;
var calculatePercentageChange = function (current, previous) {
    if (previous === 0)
        return 0;
    return ((current - previous) / previous) * 100;
};
exports.calculatePercentageChange = calculatePercentageChange;
