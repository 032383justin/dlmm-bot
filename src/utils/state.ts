import { supabase } from '../db/supabase';

export async function savePaperTradingState(balance: number, totalPnL: number): Promise<void> {
  try {
    await supabase
      .from('bot_state')
      .upsert({
        key: 'paper_trading_balance',
        value: { balance, totalPnL },
        updated_at: new Date().toISOString()
      });
  } catch (error) {
    console.error('Failed to save paper trading state:', error);
  }
}

export async function loadPaperTradingState(): Promise<{ balance: number; totalPnL: number } | null> {
  try {
    const { data, error } = await supabase
      .from('bot_state')
      .select('value')
      .eq('key', 'paper_trading_balance')
      .single();

    if (error || !data) return null;
    return data.value as { balance: number; totalPnL: number };
  } catch (error) {
    console.error('Failed to load paper trading state:', error);
    return null;
  }
}
