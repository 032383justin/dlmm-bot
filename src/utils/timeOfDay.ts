/**
 * Time-of-Day Position Sizing
 * Currently disabled - always returns 100% for maximum capital deployment
 */

export function getTimeOfDayMultiplier(): number {
  // Always use full allocation - other risk controls provide sufficient protection
  return 1.0;
}

export function isVolatileHour(): boolean {
  // Not currently used, but kept for potential future analysis
  return true;
}
