// 本機 UI 預覽用種子腳本：把假的 SSO 設定寫入本機 D1（--local），
// 僅用於 next dev 檢視主控台 UI，不影響遠端任何資料庫。
import { readFileSync } from "node:fs";
import { encryptOidcClientSecret } from "../src/server/utils/credential-crypto.js";

const devVars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.includes("="))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

const encrypted = await encryptOidcClientSecret("dev-preview-secret", devVars.CREDENTIAL_ENCRYPTION_KEY);
const sql = `INSERT INTO sso_config (id, issuer, authorization_endpoint, token_endpoint, jwks_uri, client_id, client_secret_ciphertext, client_secret_iv, allowed_email)
VALUES (1, 'https://preview.local/oidc', 'https://preview.local/authorize', 'https://preview.local/token', 'https://preview.local/jwks.json', 'dev-client', '${encrypted.clientSecretCiphertext}', '${encrypted.clientSecretIv}', 'dev@example.com');
DELETE FROM pending_sso_setup;`;
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("../.preview-seed.sql", import.meta.url), sql);
console.log("sql written to .preview-seed.sql");
