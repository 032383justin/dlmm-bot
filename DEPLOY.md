# Hetzner Server Deployment Guide

## Quick Deploy (Copy & Paste)

SSH into your Hetzner server and run these commands:

```bash
# 1. Install Node.js 20+ (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install PM2 globally
sudo npm install -g pm2

# 3. Clone the repository
cd ~
git clone https://github.com/032383justin/dlmm-bot.git
cd dlmm-bot

# 4. Install dependencies
npm install

# 5. Create .env file
nano .env
```

## .env Configuration

Paste this into the `.env` file (update with your actual values):

```bash
RPC_URL=your_helius_rpc_url_here
SUPABASE_URL=your_supabase_url_here
SUPABASE_KEY=your_supabase_key_here
ENV=production
TOTAL_CAPITAL=10000
PAPER_TRADING=true
PAPER_CAPITAL=10000
```

**IMPORTANT**: Keep `PAPER_TRADING=true` for testing!

Save and exit (Ctrl+X, then Y, then Enter)

## Build and Start

```bash
# Build the TypeScript code
npm run build

# Start with PM2
pm2 start pm2.config.cjs

# Save PM2 configuration
pm2 save

# Enable PM2 to start on server reboot
pm2 startup
# Follow the instructions it prints (copy/paste the command it shows)
```

## Monitor the Bot

```bash
# View live logs
pm2 logs dlmm-bot

# Check status
pm2 status

# View report (after a few cycles)
npm run report
```

## Useful Commands

```bash
# Restart bot
pm2 restart dlmm-bot

# Stop bot
pm2 stop dlmm-bot

# View last 100 log lines
pm2 logs dlmm-bot --lines 100

# Update bot (pull latest changes)
cd ~/dlmm-bot
git pull
npm install
npm run build
pm2 restart dlmm-bot
```

## Switching to Live Trading

Once you're confident after 24-48 hours of paper trading:

```bash
cd ~/dlmm-bot
nano .env
# Change: PAPER_TRADING=false
# Save and exit

pm2 restart dlmm-bot
```

## Troubleshooting

**Bot not starting?**
```bash
pm2 logs dlmm-bot --err
```

**Check if Node.js is installed:**
```bash
node --version  # Should show v20.x.x or higher
```

**Check if PM2 is running:**
```bash
pm2 list
```

**Reset everything:**
```bash
pm2 delete dlmm-bot
pm2 save
cd ~/dlmm-bot
npm run build
pm2 start pm2.config.cjs
pm2 save
```
