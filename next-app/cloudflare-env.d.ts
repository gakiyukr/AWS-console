interface CloudflareEnv {
  ASSETS: Fetcher;
  CAP_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  DB: D1Database;
  SESSION_SECRET: string;
  SETUP_TOKEN: string;
  WORKER_SELF_REFERENCE: Fetcher;
}
