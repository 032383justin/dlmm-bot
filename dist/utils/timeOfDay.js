"use strict";
/**
 * Time-of-Day Position Sizing
 * Currently disabled - always returns 100% for maximum capital deployment
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTimeOfDayMultiplier = getTimeOfDayMultiplier;
exports.isVolatileHour = isVolatileHour;
function getTimeOfDayMultiplier() {
    // Always use full allocation - other risk controls provide sufficient protection
    return 1.0;
}
function isVolatileHour() {
    // Not currently used, but kept for potential future analysis
    return true;
}
//# sourceMappingURL=timeOfDay.js.map