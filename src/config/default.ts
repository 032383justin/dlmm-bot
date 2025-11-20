export type DefaultConfig = {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  RPC_URL: string;
  ENV: 'dev' | 'prod';
};

export const DEFAULT_CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_KEY: process.env.SUPABASE_KEY || "",
  RPC_URL: process.env.RPC_URL || "",
  ENV: (process.env.ENV as "dev" | "prod") || "dev",
};


