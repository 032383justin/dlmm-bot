"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.savePaperTradingState = savePaperTradingState;
exports.loadPaperTradingState = loadPaperTradingState;
const supabase_1 = require("../db/supabase");
async function savePaperTradingState(balance, totalPnL) {
    try {
        await supabase_1.supabase
            .from('bot_state')
            .upsert({
            key: 'paper_trading_balance',
            value: { balance, totalPnL },
            updated_at: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('Failed to save paper trading state:', error);
    }
}
async function loadPaperTradingState() {
    try {
        const { data, error } = await supabase_1.supabase
            .from('bot_state')
            .select('value')
            .eq('key', 'paper_trading_balance')
            .single();
        if (error || !data)
            return null;
        return data.value;
    }
    catch (error) {
        console.error('Failed to load paper trading state:', error);
        return null;
    }
}
//# sourceMappingURL=state.js.map