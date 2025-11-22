"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = 3000;
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');
app.get('/', async (_req, res) => {
    try {
        const { data: logs, error } = await supabase
            .from('bot_logs')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(10000);
        if (error)
            throw error;
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
        let totalPnL = 0;
        for (const log of logs) {
            const pnl = log.details?.paperPnL;
            if (pnl !== undefined && pnl !== null) {
                totalPnL = pnl;
                break;
            }
        }
        let dailyPnL = 0;
        let weeklyPnL = 0;
        let monthlyPnL = 0;
        // Find the P&L at the START of each time period (oldest log within period)
        let startDailyPnL = null;
        let startWeeklyPnL = null;
        let startMonthlyPnL = null;
        // Loop from oldest to newest to find the first P&L value in each period
        for (let i = logs.length - 1; i >= 0; i--) {
            const log = logs[i];
            const pnl = log.details?.paperPnL;
            if (pnl === undefined || pnl === null)
                continue;
            const timestamp = new Date(log.timestamp).getTime();
            // Find the FIRST (oldest) P&L value within each period
            if (timestamp > oneMonthAgo && startMonthlyPnL === null)
                startMonthlyPnL = pnl;
            if (timestamp > oneWeekAgo && startWeeklyPnL === null)
                startWeeklyPnL = pnl;
            if (timestamp > oneDayAgo && startDailyPnL === null)
                startDailyPnL = pnl;
        }
        // Calculate P&L change from start of period to now
        dailyPnL = totalPnL - (startDailyPnL ?? totalPnL);
        weeklyPnL = totalPnL - (startWeeklyPnL ?? totalPnL);
        monthlyPnL = totalPnL - (startMonthlyPnL ?? totalPnL);
        // Calculate wins/losses from EXIT logs
        const exitLogsWithPnL = logs.filter(l => l.action === 'EXIT' && l.details?.paperPnL !== undefined);
        let wins = 0;
        let losses = 0;
        let prevPnL = 0;
        // Sort by timestamp ascending to calculate trade-by-trade P&L
        const sortedExits = [...exitLogsWithPnL].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        for (const exit of sortedExits) {
            const currentPnL = exit.details.paperPnL;
            const tradePnL = currentPnL - prevPnL;
            if (tradePnL > 0)
                wins++;
            else if (tradePnL < 0)
                losses++;
            prevPnL = currentPnL;
        }
        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const avgWin = wins > 0 ? totalPnL / wins : 0;
        const startingBalance = parseFloat(process.env.PAPER_CAPITAL || '10000');
        const currentBalance = startingBalance + totalPnL;
        const entryLogs = logs.filter(l => l.action === 'ENTRY');
        const exitLogs = logs.filter(l => l.action === 'EXIT');
        // Build active positions: group by pool, keep most recent entry, check if exited
        const positionMap = new Map();
        // First pass: collect all entries by pool, keeping only the most recent
        for (const entry of entryLogs) {
            const pool = entry.details?.pool;
            const amount = entry.details?.amount || 0;
            if (!pool || amount === 0)
                continue;
            const entryTime = new Date(entry.timestamp).getTime();
            const existing = positionMap.get(pool);
            // Keep only the most recent entry for this pool
            if (!existing || new Date(existing.entryTime).getTime() < entryTime) {
                positionMap.set(pool, {
                    pool,
                    amount,
                    score: entry.details?.score || 0,
                    entryTime: entry.timestamp,
                    type: entry.details?.type || 'unknown'
                });
            }
        }
        // Second pass: remove positions that have been exited AFTER their most recent entry
        for (const [pool, position] of positionMap.entries()) {
            const hasExitedAfter = exitLogs.some(exit => exit.details?.pool === pool &&
                new Date(exit.timestamp) > new Date(position.entryTime));
            if (hasExitedAfter) {
                positionMap.delete(pool);
            }
        }
        const activePositions = Array.from(positionMap.values());
        const totalDeployed = activePositions.reduce((sum, pos) => sum + pos.amount, 0);
        const availableCapital = currentBalance - totalDeployed;
        const toEST = (date) => {
            return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        };
        // Calculate system status
        const lastLogTime = logs.length > 0 ? new Date(logs[0].timestamp).getTime() : 0;
        const timeSinceLastLog = now - lastLogTime;
        let systemStatus = 'SYSTEM ONLINE';
        let statusColor = 'var(--success)';
        if (timeSinceLastLog > 10 * 60 * 1000) { // > 10 mins
            systemStatus = 'SYSTEM OFFLINE';
            statusColor = 'var(--danger)';
        }
        else if (timeSinceLastLog > 5 * 60 * 1000) { // > 5 mins
            systemStatus = 'SYSTEM IDLE';
            statusColor = '#facc15'; // Yellow
        }
        res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>DLMM Bot Terminal</title>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
        <meta http-equiv="refresh" content="30">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-dark: #050505;
            --bg-card: rgba(20, 20, 30, 0.6);
            --accent-primary: #00f2ff; /* Cyan Neon */
            --accent-secondary: #7000ff; /* Electric Purple */
            --text-primary: #ffffff;
            --text-secondary: #94a3b8;
            --success: #00ffa3;
            --danger: #ff0055;
            --glass-border: 1px solid rgba(255, 255, 255, 0.08);
          }

          * { margin: 0; padding: 0; box-sizing: border-box; }
          
          body {
            font-family: 'Inter', sans-serif;
            background-color: var(--bg-dark);
            background-image: 
              radial-gradient(circle at 10% 20%, rgba(112, 0, 255, 0.15) 0%, transparent 20%),
              radial-gradient(circle at 90% 80%, rgba(0, 242, 255, 0.1) 0%, transparent 20%);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 40px;
          }

          .container { max-width: 1600px; margin: 0 auto; }

          /* Typography */
          .font-mono { font-family: 'JetBrains Mono', monospace; }
          .text-gradient {
            background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          .text-accent { color: var(--accent-primary); }
          .text-success { color: var(--success); }
          .text-danger { color: var(--danger); }
          .text-muted { color: var(--text-secondary); }

          /* Header */
          header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: var(--glass-border);
          }
          
          .brand {
            display: flex;
            align-items: center;
            gap: 15px;
          }
          
          .brand-icon {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 1.2em;
            box-shadow: 0 0 20px rgba(0, 242, 255, 0.3);
          }

          .status-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(255, 255, 255, 0.05);
            padding: 8px 16px;
            border-radius: 20px;
            border: 1px solid ${statusColor};
            font-size: 0.85em;
            color: ${statusColor};
            transition: all 0.3s ease;
          }
          
          .status-dot {
            width: 8px;
            height: 8px;
            background: ${statusColor};
            border-radius: 50%;
            box-shadow: 0 0 10px ${statusColor};
            animation: pulse 2s infinite;
          }

          @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
          }

          /* Hero Section */
          .hero-grid {
            display: grid;
            grid-template-columns: 1.5fr 1fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
          }

          .glass-panel {
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border: var(--glass-border);
            border-radius: 24px;
            padding: 32px;
            position: relative;
            overflow: hidden;
          }
          
          .glass-panel::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
          }

          .metric-label {
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-secondary);
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .metric-value-lg {
            font-size: 3.5em;
            font-weight: 700;
            letter-spacing: -1px;
            line-height: 1;
          }

          .metric-sub {
            margin-top: 12px;
            font-size: 1.1em;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          /* Performance Strip */
          .perf-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 24px;
            margin-bottom: 24px;
          }

          .mini-card {
            background: rgba(255, 255, 255, 0.03);
            border: var(--glass-border);
            border-radius: 16px;
            padding: 20px;
            transition: transform 0.2s;
          }
          
          .mini-card:hover {
            transform: translateY(-2px);
            background: rgba(255, 255, 255, 0.05);
          }

          .mini-value {
            font-size: 1.8em;
            font-weight: 600;
            margin-top: 8px;
          }

          /* Stats Grid */
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 24px;
            margin-bottom: 40px;
          }

          /* Active Positions */
          .positions-container {
            background: var(--bg-card);
            border: var(--glass-border);
            border-radius: 24px;
            padding: 32px;
          }

          .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
          }

          .table-header {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            padding: 0 24px 16px;
            color: var(--text-secondary);
            font-size: 0.85em;
            text-transform: uppercase;
            letter-spacing: 1px;
            border-bottom: var(--glass-border);
          }

          .position-row {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            padding: 24px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            align-items: center;
            transition: background 0.2s;
          }

          .position-row:last-child { border-bottom: none; }
          .position-row:hover { background: rgba(255,255,255,0.02); }

          .token-pair {
            display: flex;
            align-items: center;
            gap: 12px;
          }

          .token-icon {
            width: 32px;
            height: 32px;
            background: rgba(255,255,255,0.1);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8em;
          }

          .progress-bar {
            height: 4px;
            background: rgba(255,255,255,0.1);
            border-radius: 2px;
            margin-top: 8px;
            overflow: hidden;
          }

          .progress-fill {
            height: 100%;
            background: var(--accent-primary);
            box-shadow: 0 0 10px var(--accent-primary);
          }

          /* Refresh Timer */
          #refresh-timer {
            position: fixed;
            top: 0;
            left: 0;
            height: 3px;
            background: var(--accent-primary);
            width: 100%;
            z-index: 1000;
            animation: shrink 30s linear infinite;
          }

          @keyframes shrink {
            from { width: 100%; }
            to { width: 0%; }
          }

          @media (max-width: 1200px) {
            .hero-grid { grid-template-columns: 1fr; }
            .perf-grid, .stats-grid { grid-template-columns: repeat(2, 1fr); }
          }
          
          @media (max-width: 768px) {
            .perf-grid, .stats-grid { grid-template-columns: 1fr; }
            .table-header { display: none; }
            .position-row { grid-template-columns: 1fr; gap: 16px; }
          }
        </style>
      </head>
      <body>
        <div id="refresh-timer"></div>
        <div class="container">
          <header>
            <div class="brand">
              <div class="brand-icon">⚡</div>
              <div>
                <h2 style="font-weight: 600; letter-spacing: -0.5px;">DLMM Terminal</h2>
                <div class="text-muted" style="font-size: 0.85em;">v1.0.0 • Paper Trading</div>
              </div>
            </div>
            <div class="status-badge">
              <div class="status-dot"></div>
              ${systemStatus}
            </div>
          </header>

          <!-- Hero Section -->
          <div class="hero-grid">
            <!-- Main P&L -->
            <div class="glass-panel" style="background: linear-gradient(160deg, rgba(20,20,30,0.8) 0%, rgba(0,242,255,0.05) 100%);">
              <div class="metric-label">Total Net Profit</div>
              <div class="metric-value-lg font-mono ${totalPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
              </div>
              <div class="metric-sub">
                <span class="${totalPnL >= 0 ? 'text-success' : 'text-danger'} font-mono">
                  ${((totalPnL / startingBalance) * 100).toFixed(2)}% ROI
                </span>
                <span class="text-muted">• Since Inception</span>
              </div>
            </div>

            <!-- Balance -->
            <div class="glass-panel">
              <div class="metric-label">Total Equity</div>
              <div class="metric-value-lg font-mono" style="font-size: 2.5em;">
                $${currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div class="metric-sub text-muted">
                Starting: $${startingBalance.toLocaleString()}
              </div>
            </div>

            <!-- Deployment -->
            <div class="glass-panel">
              <div class="metric-label">Capital Utilization</div>
              <div class="metric-value-lg font-mono" style="font-size: 2.5em;">
                ${((totalDeployed / currentBalance) * 100).toFixed(1)}%
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${((totalDeployed / currentBalance) * 100)}%"></div>
              </div>
              <div class="metric-sub text-muted" style="justify-content: space-between;">
                <span>Deployed: $${totalDeployed.toFixed(0)}</span>
                <span class="text-accent">Free: $${availableCapital.toFixed(0)}</span>
              </div>
            </div>
          </div>

          <!-- Performance Strip -->
          <div class="perf-grid">
            <div class="mini-card">
              <div class="metric-label">24h Profit</div>
              <div class="mini-value font-mono ${dailyPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">7d Profit</div>
              <div class="mini-value font-mono ${weeklyPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">30d Profit</div>
              <div class="mini-value font-mono ${monthlyPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${monthlyPnL >= 0 ? '+' : ''}$${monthlyPnL.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Win Rate</div>
              <div class="mini-value font-mono text-accent">
                ${winRate.toFixed(1)}%
              </div>
              <div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">
                ${wins} Wins / ${losses} Losses
              </div>
            </div>
          </div>

          <!-- Secondary Stats -->
          <div class="stats-grid">
            <div class="mini-card">
              <div class="metric-label">Avg Daily Return</div>
              <div class="mini-value font-mono text-success">
                ${(dailyPnL / startingBalance * 100).toFixed(2)}%
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Avg Trade Win</div>
              <div class="mini-value font-mono text-success">
                +$${avgWin.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Total Trades</div>
              <div class="mini-value font-mono">
                ${totalTrades}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Active Positions</div>
              <div class="mini-value font-mono text-accent">
                ${activePositions.length}<span style="font-size: 0.6em; color: var(--text-secondary);">/5</span>
              </div>
            </div>
          </div>

          <!-- Active Positions Table -->
          <div class="positions-container">
            <div class="section-header">
              <h3 style="font-weight: 600;">Active Market Positions</h3>
              <div class="text-muted font-mono" style="font-size: 0.85em;">
                Last Updated: ${toEST(new Date()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} EST
              </div>
            </div>

            ${activePositions.length > 0 ? `
              <div class="table-header">
                <div>Pool / Strategy</div>
                <div style="text-align: right;">Allocation</div>
                <div style="text-align: right;">Score</div>
                <div style="text-align: right;">Entry Time</div>
              </div>
              ${activePositions.map(pos => `
                <div class="position-row">
                  <div class="token-pair">
                    <div class="token-icon">⚡</div>
                    <div>
                      <div style="font-weight: 600; color: #fff;">${pos.pool}</div>
                      <div style="font-size: 0.85em; color: var(--accent-primary);">${pos.type}</div>
                    </div>
                  </div>
                  <div style="text-align: right;">
                    <div class="font-mono" style="font-weight: 600;">$${pos.amount.toFixed(0)}</div>
                    <div style="font-size: 0.8em; color: var(--text-secondary);">${((pos.amount / currentBalance) * 100).toFixed(1)}% alloc</div>
                  </div>
                  <div style="text-align: right;">
                    <div class="font-mono text-accent" style="font-weight: 600;">${pos.score.toFixed(1)}</div>
                    <div style="font-size: 0.8em; color: var(--text-secondary);">/ 100.0</div>
                  </div>
                  <div style="text-align: right;">
                    <div class="font-mono" style="color: var(--text-secondary);">
                      ${toEST(new Date(pos.entryTime)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              `).join('')}
            ` : `
              <div class="empty-state" style="padding: 60px; text-align: center; color: var(--text-secondary);">
                <div style="font-size: 2em; margin-bottom: 16px; opacity: 0.5;">🔭</div>
                <div>Scanning market for opportunities...</div>
              </div>
            `}
          </div>
        </div>
      </body>
      </html>
    `);
    }
    catch (error) {
        res.status(500).send('Error fetching dashboard data');
    }
});
app.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map