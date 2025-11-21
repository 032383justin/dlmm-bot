// P&L Dashboard Server

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_KEY || ''
);

interface PnLData {
    totalPnL: number;
    dailyPnL: number;
    weeklyPnL: number;
    monthlyPnL: number;
    currentBalance: number;
    startingBalance: number;
    totalTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
}

async function calculatePnL(): Promise<PnLData> {
    const { data: logs, error } = await supabase
        .from('bot_logs')
        .select('*')
        .eq('action', 'EXIT')
        .order('timestamp', { ascending: false });

    if (error || !logs) {
        return {
            totalPnL: 0,
            dailyPnL: 0,
            weeklyPnL: 0,
            monthlyPnL: 0,
            currentBalance: parseFloat(process.env.PAPER_CAPITAL || '10000'),
            startingBalance: parseFloat(process.env.PAPER_CAPITAL || '10000'),
            totalTrades: 0,
            winRate: 0,
            avgWin: 0,
            avgLoss: 0,
            largestWin: 0,
            largestLoss: 0,
        };
    }

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    let totalPnL = 0;
    let dailyPnL = 0;
    let weeklyPnL = 0;
    let monthlyPnL = 0;
    let wins = 0;
    let losses = 0;
    let totalWin = 0;
    let totalLoss = 0;
    let largestWin = 0;
    let largestLoss = 0;

    for (const log of logs) {
        const pnl = (log.metadata as any)?.paperPnL || 0;
        const timestamp = new Date(log.timestamp).getTime();

        totalPnL = pnl; // Latest total P&L

        if (timestamp > oneDayAgo) dailyPnL = pnl;
        if (timestamp > oneWeekAgo) weeklyPnL = pnl;
        if (timestamp > oneMonthAgo) monthlyPnL = pnl;

        // Track individual trade P&L (would need more data in logs)
        if (pnl > 0) {
            wins++;
            totalWin += pnl;
            largestWin = Math.max(largestWin, pnl);
        } else if (pnl < 0) {
            losses++;
            totalLoss += Math.abs(pnl);
            largestLoss = Math.min(largestLoss, pnl);
        }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgWin = wins > 0 ? totalWin / wins : 0;
    const avgLoss = losses > 0 ? totalLoss / losses : 0;

    const startingBalance = parseFloat(process.env.PAPER_CAPITAL || '10000');
    const currentBalance = startingBalance + totalPnL;

    return {
        totalPnL,
        dailyPnL,
        weeklyPnL,
        monthlyPnL,
        currentBalance,
        startingBalance,
        totalTrades,
        winRate,
        avgWin,
        avgLoss,
        largestWin,
        largestLoss,
    };
}

app.get('/', async (req, res) => {
    const pnl = await calculatePnL();
    const isPaperTrading = process.env.PAPER_TRADING === 'true';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>DLMM Bot Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 20px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    .header h1 {
      font-size: 32px;
      color: #2d3748;
      margin-bottom: 10px;
    }
    .mode-badge {
      display: inline-block;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      background: ${isPaperTrading ? '#48bb78' : '#f56565'};
      color: white;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    .card-title {
      font-size: 14px;
      color: #718096;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .card-value {
      font-size: 36px;
      font-weight: 700;
      color: #2d3748;
    }
    .positive { color: #48bb78; }
    .negative { color: #f56565; }
    .card-subtitle {
      font-size: 14px;
      color: #a0aec0;
      margin-top: 8px;
    }
    .refresh-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      margin-top: 20px;
    }
    .refresh-btn:hover {
      background: #5568d3;
    }
  </style>
  <script>
    setTimeout(() => location.reload(), 30000); // Auto-refresh every 30s
  </script>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 DLMM Bot Dashboard</h1>
      <span class="mode-badge">${isPaperTrading ? '🎮 PAPER TRADING' : '💰 LIVE TRADING'}</span>
    </div>

    <div class="grid">
      <div class="card">
        <div class="card-title">Current Balance</div>
        <div class="card-value">$${pnl.currentBalance.toFixed(2)}</div>
        <div class="card-subtitle">Started with $${pnl.startingBalance.toFixed(2)}</div>
      </div>

      <div class="card">
        <div class="card-title">Total P&L</div>
        <div class="card-value ${pnl.totalPnL >= 0 ? 'positive' : 'negative'}">
          ${pnl.totalPnL >= 0 ? '+' : ''}$${pnl.totalPnL.toFixed(2)}
        </div>
        <div class="card-subtitle">${((pnl.totalPnL / pnl.startingBalance) * 100).toFixed(2)}% return</div>
      </div>

      <div class="card">
        <div class="card-title">Daily P&L</div>
        <div class="card-value ${pnl.dailyPnL >= 0 ? 'positive' : 'negative'}">
          ${pnl.dailyPnL >= 0 ? '+' : ''}$${pnl.dailyPnL.toFixed(2)}
        </div>
        <div class="card-subtitle">Last 24 hours</div>
      </div>

      <div class="card">
        <div class="card-title">Weekly P&L</div>
        <div class="card-value ${pnl.weeklyPnL >= 0 ? 'positive' : 'negative'}">
          ${pnl.weeklyPnL >= 0 ? '+' : ''}$${pnl.weeklyPnL.toFixed(2)}
        </div>
        <div class="card-subtitle">Last 7 days</div>
      </div>

      <div class="card">
        <div class="card-title">Monthly P&L</div>
        <div class="card-value ${pnl.monthlyPnL >= 0 ? 'positive' : 'negative'}">
          ${pnl.monthlyPnL >= 0 ? '+' : ''}$${pnl.monthlyPnL.toFixed(2)}
        </div>
        <div class="card-subtitle">Last 30 days</div>
      </div>

      <div class="card">
        <div class="card-title">Win Rate</div>
        <div class="card-value">${pnl.winRate.toFixed(1)}%</div>
        <div class="card-subtitle">${pnl.totalTrades} total trades</div>
      </div>

      <div class="card">
        <div class="card-title">Avg Win</div>
        <div class="card-value positive">$${pnl.avgWin.toFixed(2)}</div>
        <div class="card-subtitle">Per winning trade</div>
      </div>

      <div class="card">
        <div class="card-title">Avg Loss</div>
        <div class="card-value negative">$${pnl.avgLoss.toFixed(2)}</div>
        <div class="card-subtitle">Per losing trade</div>
      </div>
    </div>

    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Now</button>
  </div>
</body>
</html>
  `;

    res.send(html);
});

app.listen(PORT, () => {
    console.log(`📊 Dashboard running at http://localhost:${PORT}`);
    console.log(`🌐 Access from anywhere: http://your-server-ip:${PORT}`);
});
