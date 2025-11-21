# Paper Trading Mode

## Overview
Run the bot in simulation mode using real-time data but fake money. Perfect for testing strategies before risking capital.

## Quick Start

1. **Enable Paper Trading**
   ```bash
   # In your .env file
   PAPER_TRADING=true
   PAPER_CAPITAL=10000
   ```

2. **Run the Bot**
   ```bash
   npm run dev
   ```

3. **Monitor Performance**
   ```bash
   npm run monitor
   npm run report
   ```

## Features

- ✅ Real-time pool data from Meteora API
- ✅ Real scoring and filtering logic
- ✅ Simulated position tracking
- ✅ Simulated P&L calculation
- ✅ All exit/entry triggers work normally
- ✅ Logs to Supabase (marked as paper trades)
- ❌ No actual on-chain transactions

## How It Works

The bot operates identically to live mode, except:
- No wallet connection required
- No actual liquidity provision
- P&L is calculated based on pool fee rates
- Positions are tracked in memory only

## Viewing Results

### Real-Time Monitoring
```bash
npm run monitor
```
Look for `[PAPER]` prefix in logs.

### Performance Report
```bash
npm run report
```
Shows simulated positions and P&L.

### Supabase Dashboard
Check `bot_logs` table - paper trades are marked with `paper_trading: true`.

## Switching to Live Trading

Once you're confident:

1. **Update .env**
   ```bash
   PAPER_TRADING=false
   # Add wallet private key (when ready for fee harvesting)
   ```

2. **Restart Bot**
   ```bash
   npx pm2 restart dlmm-bot
   ```

## Limitations

- **No Slippage Simulation**: Assumes you can enter/exit at exact prices
- **No Gas Fees**: Doesn't account for transaction costs
- **Optimistic P&L**: Real trading will have ~2-5% worse performance

## Recommended Testing Period

- **Minimum**: 24 hours (5-10 cycles)
- **Ideal**: 3-7 days (100+ cycles)
- **Goal**: Verify 1-5% daily returns consistently

## What to Watch For

✅ **Good Signs:**
- Consistent 1-5% daily gains
- Trailing stops working (locking profits)
- Diversification across token types
- Market crash exits triggering correctly

🚩 **Red Flags:**
- Negative days frequently
- Same pools being entered/exited repeatedly
- All positions in one token type
- No exits during obvious crashes
