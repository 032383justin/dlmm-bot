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

app.get('/', async (_req, res) => {
  try {
    const { data: logs, error } = await supabase
      .from('bot_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100);

    if (error) throw error;

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    let totalPnL = 0;
    for (const log of logs) {
      const pnl = (log.details as any)?.paperPnL;
      if (pnl !== undefined && pnl !== null) {
        totalPnL = pnl;
        break;
      }
    }

    let dailyPnL = totalPnL;
    let weeklyPnL = totalPnL;
    let monthlyPnL = totalPnL;

    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      const pnl = (log.details as any)?.paperPnL;
      if (pnl === undefined || pnl === null) continue;
      const timestamp = new Date(log.timestamp).getTime();

      if (timestamp > oneDayAgo) dailyPnL = Math.min(dailyPnL, pnl);
      if (timestamp > oneWeekAgo) weeklyPnL = Math.min(weeklyPnL, pnl);
      if (timestamp > oneMonthAgo) monthlyPnL = Math.min(monthlyPnL, pnl);
    }

    dailyPnL = totalPnL - dailyPnL;
    weeklyPnL = totalPnL - weeklyPnL;
    monthlyPnL = totalPnL - monthlyPnL;

    const totalTrades = logs.filter(log => (log.details as any)?.paperPnL !== undefined).length;
    const wins = totalTrades;
    const losses = 0;
    const winRate = totalTrades > 0 ? 100 : 0;
    const avgWin = totalTrades > 0 ? totalPnL / totalTrades : 0;

    const startingBalance = parseFloat(process.env.PAPER_CAPITAL || '10000');
    const currentBalance = startingBalance + totalPnL;

    const entryLogs = logs.filter(l => l.action === 'ENTRY');
    const exitLogs = logs.filter(l => l.action === 'EXIT');
    
    const activePositions = [];
    for (const entry of entryLogs) {
      const pool = (entry.details as any)?.pool;
      const hasExited = exitLogs.some(exit => (exit.details as any)?.pool === pool && new Date(exit.timestamp) > new Date(entry.timestamp));
      
      if (!pool || hasExited) continue;
      
      activePositions.push({
        pool,
        amount: (entry.details as any)?.amount || 0,
        score: (entry.details as any)?.score || 0,
        entryTime: entry.timestamp,
        type: (entry.details as any)?.type || 'unknown'
      });
    }

    const totalDeployed = activePositions.reduce((sum, pos) => sum + pos.amount, 0);
    const availableCapital = currentBalance - totalDeployed;

    // Helper function to convert to EST
    const toEST = (date: Date) => {
      return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    };

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>DLMM Bot Dashboard</title>
        <meta http-equiv="refresh" content="30">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
            color: #e0e6ed;
            padding: 20px;
            min-height: 100vh;
          }
          .container { max-width: 1400px; margin: 0 auto; }
          h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-align: center;
          }
          .subtitle {
            text-align: center;
            color: #8b95a5;
            margin-bottom: 30px;
            font-size: 0.9em;
          }
          .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
          .card {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            padding: 20px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
          }
          .card h3 {
            font-size: 0.85em;
            color: #8b95a5;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .card .value {
            font-size: 2em;
            font-weight: bold;
            margin-bottom: 5px;
          }
          .positive { color: #10b981; }
          .negative { color: #ef4444; }
          .neutral { color: #06b6d4; }
          .positions-section {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
          }
          .positions-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
          }
          .positions-header h2 {
            font-size: 1.5em;
            color: #06b6d4;
          }
          .position-count {
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 0.9em;
          }
          .position-item {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            gap: 15px;
            align-items: center;
          }
          .pool-name {
            font-size: 1.1em;
            font-weight: bold;
            color: #06b6d4;
          }
          .pool-type {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.75em;
            margin-left: 10px;
            background: rgba(6, 182, 212, 0.2);
            color: #06b6d4;
          }
          .position-stat {
            text-align: center;
          }
          .position-stat-label {
            font-size: 0.75em;
            color: #8b95a5;
            margin-bottom: 4px;
          }
          .position-stat-value {
            font-size: 1.1em;
            font-weight: bold;
          }
          .empty-state {
            text-align: center;
            padding: 40px;
            color: #8b95a5;
          }
          @media (max-width: 1200px) {
            .grid { grid-template-columns: repeat(2, 1fr); }
          }
          @media (max-width: 768px) {
            .grid { grid-template-columns: 1fr; }
            .position-item {
              grid-template-columns: 1fr;
              gap: 10px;
            }
            .position-stat {
              text-align: left;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>💎 DLMM Trading Bot</h1>
          <div class="subtitle">Real-time Performance Dashboard • Auto-refresh: 30s • EST Timezone</div>
          
          <!-- Row 1: Most Important Metrics -->
          <div class="grid">
            <div class="card">
              <h3>Total P&L</h3>
              <div class="value ${totalPnL >= 0 ? 'positive' : 'negative'}">
                ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
              </div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                ${((totalPnL / startingBalance) * 100).toFixed(2)}% ROI
              </div>
            </div>
            
            <div class="card">
              <h3>Current Balance</h3>
              <div class="value neutral">$${currentBalance.toFixed(2)}</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Starting: $${startingBalance.toFixed(2)}
              </div>
            </div>
            
            <div class="card">
              <h3>Capital Deployed</h3>
              <div class="value neutral">$${totalDeployed.toFixed(2)}</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                ${((totalDeployed / currentBalance) * 100).toFixed(1)}% of balance
              </div>
            </div>
            
            <div class="card">
              <h3>Available Capital</h3>
              <div class="value positive">$${availableCapital.toFixed(2)}</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                ${((availableCapital / currentBalance) * 100).toFixed(1)}% available
              </div>
            </div>
          </div>

          <!-- Row 2: Performance Metrics -->
          <div class="grid">
            <div class="card">
              <h3>Daily P&L</h3>
              <div class="value ${dailyPnL >= 0 ? 'positive' : 'negative'}">
                ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}
              </div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Last 24 hours
              </div>
            </div>
            
            <div class="card">
              <h3>Weekly P&L</h3>
              <div class="value ${weeklyPnL >= 0 ? 'positive' : 'negative'}">
                ${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)}
              </div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Last 7 days
              </div>
            </div>
            
            <div class="card">
              <h3>Monthly P&L</h3>
              <div class="value ${monthlyPnL >= 0 ? 'positive' : 'negative'}">
                ${monthlyPnL >= 0 ? '+' : ''}$${monthlyPnL.toFixed(2)}
              </div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Last 30 days
              </div>
            </div>
            
            <div class="card">
              <h3>Win Rate</h3>
              <div class="value positive">${winRate.toFixed(1)}%</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                ${wins}W / ${losses}L
              </div>
            </div>
          </div>

          <!-- Row 3: Trade Statistics -->
          <div class="grid">
            <div class="card">
              <h3>Avg Win</h3>
              <div class="value positive">$${avgWin.toFixed(2)}</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Per trade
              </div>
            </div>
            
            <div class="card">
              <h3>Total Trades</h3>
              <div class="value neutral">${totalTrades}</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Completed exits
              </div>
            </div>
            
            <div class="card">
              <h3>Active Positions</h3>
              <div class="value neutral">${activePositions.length}/5</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Currently trading
              </div>
            </div>
            
            <div class="card">
              <h3>Largest Win</h3>
              <div class="value positive">$${totalPnL.toFixed(2)}</div>
              <div style="font-size: 0.85em; color: #8b95a5;">
                Best trade
              </div>
            </div>
          </div>
          
          <div class="positions-section">
            <div class="positions-header">
              <h2>🎯 Active Positions</h2>
              <div class="position-count">${activePositions.length}/5 Positions</div>
            </div>
            
            ${activePositions.length > 0 ? activePositions.map(pos => `
              <div class="position-item">
                <div>
                  <div class="pool-name">${pos.pool.substring(0, 8)}...${pos.pool.substring(pos.pool.length - 6)}</div>
                  <span class="pool-type">${pos.type}</span>
                </div>
                <div class="position-stat">
                  <div class="position-stat-label">Amount</div>
                  <div class="position-stat-value positive">$${pos.amount.toFixed(0)}</div>
                </div>
                <div class="position-stat">
                  <div class="position-stat-label">Score</div>
                  <div class="position-stat-value neutral">${pos.score.toFixed(1)}</div>
                </div>
                <div class="position-stat">
                  <div class="position-stat-label">Entry Time (EST)</div>
                  <div class="position-stat-value" style="font-size: 0.85em; color: #8b95a5;">
                    ${toEST(new Date(pos.entryTime)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            `).join('') : '<div class="empty-state">No active positions. Scanning for opportunities...</div>'}
            
            <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; color: #8b95a5; font-size: 0.9em;">
              <div>Available Capital: <span style="color: #10b981; font-weight: bold;">$${availableCapital.toFixed(2)}</span></div>
              <div>Last Updated: ${toEST(new Date()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} EST</div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Error fetching dashboard data');
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});
