interface CloudflareEnv {
  ASSETS: Fetcher;
  CREDENTIAL_ENCRYPTION_KEY: string;
  DB: D1Database;
  SESSION_SECRET: string;
  SETUP_TOKEN: string;
  WORKER_SELF_REFERENCE: Fetcher;
}
