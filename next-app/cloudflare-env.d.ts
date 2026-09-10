interface CloudflareEnv {
  ASSETS: Fetcher;
  CREDENTIAL_ENCRYPTION_KEY: string;
  DB: D1Database;
  SESSION_SECRET: string;
  WORKER_SELF_REFERENCE: Fetcher;
}
