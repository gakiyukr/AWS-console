// OIDC SSO 登入流程：協議細節（discovery、PKCE、授權碼交換、ID token
// 簽章與 claims 驗證）交由 oauth4webapi（純 Web Crypto，Workers 與
// node --test 相容），本模組只負責組合流程、email 允許清單比對、
// OOBE 初始設定的輸入正規化與測試用的 fetch 注入（env.__testHooks.fetch）。
import * as oauth from "oauth4webapi";
import { OidcConfigurationError } from "../lib/oidc-configuration-error.js";
import { OidcError } from "../lib/oidc-error.js";
import {
  deleteExpiredPendingSsoSetups,
  getPendingSsoSetup,
  getSsoConfig,
  savePendingSsoSetup,
} from "./db.js";
import { createSignedValue, parseSignedValue } from "./auth.js";

// state cookie 名稱；授權碼流程應在數分鐘內完成，逾時即作廢
export const STATE_COOKIE = "oidc_state";
const STATE_MAX_AGE_S = 600;
const SCOPE = "openid email profile";

// discovery 結果以 isolate 記憶體快取，避免每次登入都向 IdP 取 metadata
const DISCOVERY_TTL_MS = 600_000;
const discoveryCache = { key: "", as: null, fetchedAt: 0 };

// D1 內的 OOBE 設定狀態以 isolate 快取 60 秒，避免每個請求都查 D1；
// 快取保留「已設定／未初始化／系統故障」三態，禁止把故障誤判為 OOBE。
const SSO_DB_CACHE_TTL_MS = 60_000;
let ssoDbConfigCache = { db: null, encryptionKey: "", resolution: null, checkedAt: 0 };

function classifySsoStorageError(error) {
  const message = String(error?.message || error).toLowerCase();
  if (
    message.includes("no such table")
    || (message.includes("sso_config") && message.includes("not found"))
    || (message.includes("pending_sso_setup") && message.includes("not found"))
  ) {
    return "sso_schema_missing";
  }
  if (message.includes("解密") || message.includes("credential_encryption_key")) {
    return "sso_config_decryption_failed";
  }
  return "d1_unavailable";
}

function configuredResolution(config, source) {
  return { state: "configured", source, config };
}

function errorResolution(reason) {
  return { state: "error", reason, config: null };
}

function isCredentialEncryptionKeyValid(value) {
  try {
    return atob(String(value)).length === 32;
  } catch {
    return false;
  }
}

/** 組出 IdP callback 的 redirect URI。 */
export function buildCallbackRedirectUri(origin) {
  return new URL("/api/auth/callback", origin).href;
}

/** OOBE 表單輸入的正規化與驗證；回傳 { config, email } 或 { error }。 */
export function normalizeSetupInput(input) {
  const email = String(input?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(email)) {
    return { error: "綁定 email 格式無效" };
  }
  const clientId = String(input?.clientId || "").trim();
  const clientSecret = String(input?.clientSecret || "");
  if (!clientId) {
    return { error: "Client ID 為必填" };
  }
  if (!clientSecret) {
    return { error: "Client secret 為必填" };
  }

  const issuer = String(input?.issuer || "").trim().replace(/\/+$/, "");
  const authorizationEndpoint = String(input?.authorizationUrl || "").trim();
  const tokenEndpoint = String(input?.tokenUrl || "").trim();
  const jwksUri = String(input?.jwksUrl || "").trim();

  // Issuer 恆為必填：除 discovery 外，ID token 的 iss 驗證也以它為準
  if (!issuer) {
    return { error: "Issuer URL 為必填（IdP 頁面顯示的 Issuer / Discovery URL）" };
  }
  for (const url of [issuer, authorizationEndpoint, tokenEndpoint, jwksUri].filter(Boolean)) {
    if (!/^https:\/\//i.test(url)) {
      return { error: "URL 必須以 https:// 開頭" };
    }
  }
  if (authorizationEndpoint || tokenEndpoint || jwksUri) {
    if (!(authorizationEndpoint && tokenEndpoint && jwksUri)) {
      return { error: "明確端點模式需同時填齊授權、token 與 JWKS 三個端點" };
    }
  }

  return {
    config: {
      issuer,
      issuerUrl: issuer ? new URL(issuer) : null,
      clientId,
      clientSecret,
      allowedEmails: [email],
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
    },
    email,
  };
}

/** 解析 OIDC 設定三態；只有 D1 正常且沒有任何設定時才是 unconfigured。 */
async function resolveOidcConfiguration(env) {
  const now = Date.now();
  if (
    ssoDbConfigCache.db === env?.DB
    && ssoDbConfigCache.encryptionKey === env?.CREDENTIAL_ENCRYPTION_KEY
    && now - ssoDbConfigCache.checkedAt <= SSO_DB_CACHE_TTL_MS
    && ssoDbConfigCache.resolution
  ) {
    return ssoDbConfigCache.resolution;
  }

  let resolution;
  if (!env?.DB) {
    resolution = errorResolution("d1_binding_missing");
  }
  else if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    resolution = errorResolution("credential_encryption_key_missing");
  }
  else if (!isCredentialEncryptionKeyValid(env.CREDENTIAL_ENCRYPTION_KEY)) {
    resolution = errorResolution("credential_encryption_key_invalid");
  }
  else {
    let stored;
    try {
      stored = await getSsoConfig(env.DB, env.CREDENTIAL_ENCRYPTION_KEY);
    } catch (error) {
      resolution = errorResolution(classifySsoStorageError(error));
    }

    if (!resolution && stored) {
      try {
        resolution = configuredResolution({
          issuer: stored.issuer,
          issuerUrl: new URL(stored.issuer),
          clientId: stored.clientId,
          clientSecret: stored.clientSecret,
          allowedEmails: [stored.allowedEmail.toLowerCase()],
          authorizationEndpoint: stored.authorizationEndpoint,
          tokenEndpoint: stored.tokenEndpoint,
          jwksUri: stored.jwksUri,
        }, "d1");
      } catch {
        resolution = errorResolution("sso_config_invalid");
      }
    }

    if (!resolution) {
      try {
        const fromEnvironment = getOidcConfig(env);
        resolution = fromEnvironment
          ? configuredResolution(fromEnvironment, "environment")
          : { state: "unconfigured", config: null };
      } catch {
        resolution = errorResolution("oidc_environment_invalid");
      }
    }
  }

  ssoDbConfigCache = {
    db: env?.DB || null,
    encryptionKey: env?.CREDENTIAL_ENCRYPTION_KEY || "",
    resolution,
    checkedAt: now,
  };
  return resolution;
}

/** 回傳不含密鑰的 OIDC 設定狀態，供路由決定 OOBE 或 503。 */
export async function getOidcConfigurationStatus(env) {
  const resolution = await resolveOidcConfiguration(env);
  return {
    state: resolution.state,
    ...(resolution.source ? { source: resolution.source } : {}),
    ...(resolution.reason ? { reason: resolution.reason } : {}),
  };
}

/**
 * 解析生效的 OIDC 設定：D1 設定優先，其次退回環境變數。
 * 未初始化回 null；D1、schema 或解密故障會拋出 OidcConfigurationError。
 */
export async function resolveOidcConfig(env) {
  const resolution = await resolveOidcConfiguration(env);
  if (resolution.state === "error") {
    throw new OidcConfigurationError(resolution.reason);
  }
  return resolution.config;
}

/** 變更 D1 內 SSO 設定後呼叫，使設定快取立即失效。 */
export function clearSsoConfigCache() {
  ssoDbConfigCache = { db: null, encryptionKey: "", resolution: null, checkedAt: 0 };
}

/**
 * 讀取並驗證環境變數的 OIDC 設定；缺任一必填項回 null。
 * （OOBE 設定存於 D1，環境變數為替代/備援管道。）
 */
export function getOidcConfig(env) {
  const issuer = env?.OIDC_ISSUER;
  const clientId = env?.OIDC_CLIENT_ID;
  const clientSecret = env?.OIDC_CLIENT_SECRET;
  const allowedEmails = String(env?.OIDC_ALLOWED_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!issuer || !clientId || !clientSecret || allowedEmails.length === 0) {
    return null;
  }
  return {
    issuer,
    issuerUrl: new URL(issuer),
    clientId,
    clientSecret,
    allowedEmails,
    // IdP 未提供 discovery 時，可改以三個明確端點組出 metadata
    authorizationEndpoint: env?.OIDC_AUTHORIZATION_URL || "",
    tokenEndpoint: env?.OIDC_TOKEN_URL || "",
    jwksUri: env?.OIDC_JWKS_URL || "",
  };
}

/** 部署環境是否完成 OIDC 設定（middleware 與登入路由共用）。 */
export async function isOidcConfigured(env) {
  return (await resolveOidcConfig(env)) !== null;
}

/** session 內 email 是否在允許清單中。 */
export async function isAllowedEmail(env, email) {
  const config = await resolveOidcConfig(env);
  return Boolean(config && config.allowedEmails.includes(String(email).toLowerCase()));
}

// 解析 Authorization Server metadata：三端點齊備時直接組出，否則走 discovery。
async function resolveAuthorizationServer(config, fetchImpl) {
  const cacheKey = `${config.issuer}|${config.authorizationEndpoint}`;
  const now = Date.now();
  if (
    discoveryCache.key === cacheKey
    && discoveryCache.as
    && now - discoveryCache.fetchedAt < DISCOVERY_TTL_MS
  ) {
    return discoveryCache.as;
  }

  let as;
  if (config.authorizationEndpoint && config.tokenEndpoint && config.jwksUri) {
    as = {
      issuer: config.issuer,
      authorization_endpoint: config.authorizationEndpoint,
      token_endpoint: config.tokenEndpoint,
      jwks_uri: config.jwksUri,
    };
  } else {
    as = await oauth.processDiscoveryResponse(
      config.issuerUrl,
      await oauth.discoveryRequest(config.issuerUrl, { [oauth.customFetch]: fetchImpl }),
    );
  }
  discoveryCache.key = cacheKey;
  discoveryCache.as = as;
  discoveryCache.fetchedAt = now;
  return as;
}

/**
 * OOBE「測試連線」：正規化輸入並解析 IdP metadata（discovery 或
 * 組出明確端點），不發起登入。回傳 { ok, ... } 供表單顯示；
 * 常見失敗（404、issuer 不符）轉為可執行的修正建議。
 */
export async function probeOidcSetup(setupInput, fetchImpl = fetch) {
  const normalized = normalizeSetupInput(setupInput);
  if (normalized.error) {
    return { ok: false, error: normalized.error };
  }
  try {
    const as = await resolveAuthorizationServer(normalized.config, fetchImpl);
    return { ok: true, issuer: as.issuer, authorizationEndpoint: as.authorization_endpoint };
  } catch (error) {
    const raw = String(error?.message || "");
    if (raw.includes("issuer")) {
      return {
        ok: false,
        error: "discovery 文件存在，但其 issuer 與輸入的 Issuer URL 不符；請以 IdP 頁面顯示的 Issuer 為準。",
      };
    }
    if (raw.includes("status code")) {
      const status = error?.cause?.response?.status;
      return {
        ok: false,
        error: `無法取得 IdP discovery 文件${status ? `（HTTP ${status}）` : ""}。請確認 URL 最後一段是 IdP 頁面顯示的 AUD / 應用程式 ID（不是 Client ID），或展開設定改填 IdP 提供的三個明確端點。`,
      };
    }
    return { ok: false, error: error?.message || "無法取得 IdP metadata" };
  }
}

/**
 * 產生登入導向 URL 與 state cookie。
 * state/nonce/PKCE verifier 以 SESSION_SECRET 簽章存入短效 HttpOnly
 * cookie，callback 時比對 cookie 與 query，防偽造與 CSRF。
 * setupInput 存在時為 OOBE 流程：設定先加密暫存於 D1，state cookie 僅保存
 * pending 設定識別碼與 OAuth 檢查值。
 */
export async function startLogin(env, redirectUri, setupInput = null) {
  let config;
  let pendingEmail = null;
  if (setupInput) {
    const normalized = normalizeSetupInput(setupInput);
    if (normalized.error) {
      throw new OidcError("configuration", 400);
    }
    config = normalized.config;
    pendingEmail = normalized.email;
  } else {
    if (!env?.SESSION_SECRET) {
      throw new OidcError("configuration", 503);
    }
    config = await resolveOidcConfig(env);
    if (!config) {
      throw new OidcError("configuration", 503);
    }
  }
  const fetchImpl = env.__testHooks?.fetch || fetch;
  const as = await resolveAuthorizationServer(config, fetchImpl);

  let setupId = null;
  if (pendingEmail) {
    try {
      await deleteExpiredPendingSsoSetups(env.DB);
      const pending = await savePendingSsoSetup(env.DB, {
        issuer: as.issuer,
        authorizationEndpoint: as.authorization_endpoint,
        tokenEndpoint: as.token_endpoint,
        jwksUri: as.jwks_uri,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        allowedEmail: pendingEmail,
      }, env.CREDENTIAL_ENCRYPTION_KEY);
      setupId = pending.id;
    } catch (error) {
      throw new OidcConfigurationError(classifySsoStorageError(error));
    }
  }

  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);

  const url = new URL(as.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(key, value);
  }

  const stateValue = await createSignedValue(
    {
      state,
      nonce,
      verifier,
      ...(setupId ? { setupId } : {}),
    },
    env.SESSION_SECRET,
  );
  return {
    redirectUrl: url.href,
    // SameSite 必須是 Lax：IdP 回 callback 是跨站頂層導航，Strict 的
    // cookie 瀏覽器不會隨該請求送回，callback 將永遠讀不到 state。
    stateCookie:
      `${STATE_COOKIE}=${encodeURIComponent(stateValue)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${STATE_MAX_AGE_S}`,
  };
}

/** 清除 state cookie 的 Set-Cookie 標頭。 */
export function buildClearedStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

/**
 * 處理 IdP callback：驗 state、交換授權碼並驗證 ID token（簽章、
 * iss/aud/exp 由 oauth4webapi 依 metadata 檢查、nonce 於此處傳入），
 * 最後比對 email 允許清單。OOBE 流程的允許清單來自 D1 pending 設定。
 * 成功回傳 { email, setup }；setup 存在表示需啟用 pending 設定。
 */
export async function completeLogin(env, redirectUri, query, stateValue) {
  if (!env?.SESSION_SECRET) {
    throw new OidcError("configuration", 503);
  }

  const stored = await parseSignedValue(stateValue, env.SESSION_SECRET);
  if (
    !stored?.state
    || !stored?.nonce
    || !stored?.verifier
    || Date.now() - Number(stored.issuedAt) > STATE_MAX_AGE_S * 1000
  ) {
    throw new OidcError("state_mismatch");
  }

  if (stored.setup) {
    // 舊版 cookie 可能含有明文設定；不再接受，避免 secret 回到瀏覽器流程。
    throw new OidcError("state_mismatch");
  }
  const pendingSetupId = typeof stored.setupId === "string" ? stored.setupId : null;
  let pendingSetup = null;
  let config;
  if (pendingSetupId) {
    try {
      pendingSetup = await getPendingSsoSetup(env.DB, pendingSetupId, env.CREDENTIAL_ENCRYPTION_KEY);
    } catch (error) {
      throw new OidcConfigurationError(classifySsoStorageError(error));
    }
    if (!pendingSetup) {
      throw new OidcError("configuration", 503);
    }
    try {
      config = {
        issuer: pendingSetup.issuer,
        issuerUrl: new URL(pendingSetup.issuer),
        clientId: pendingSetup.clientId,
        clientSecret: pendingSetup.clientSecret,
        allowedEmails: [pendingSetup.allowedEmail.toLowerCase()],
        authorizationEndpoint: pendingSetup.authorizationEndpoint,
        tokenEndpoint: pendingSetup.tokenEndpoint,
        jwksUri: pendingSetup.jwksUri,
      };
    } catch {
      throw new OidcError("configuration", 503);
    }
  } else {
    config = await resolveOidcConfig(env);
    if (!config) {
      throw new OidcError("configuration", 503);
    }
  }

  const fetchImpl = env.__testHooks?.fetch || fetch;
  // startLogin 已解析過 metadata，此處通常命中快取
  let as;
  try {
    as = await resolveAuthorizationServer(config, fetchImpl);
  } catch {
    throw new OidcError("configuration", 503);
  }

  const callbackParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      callbackParams.set(key, value);
    }
  }
  // IdP 端拒絕（使用者取消、政策不符等）回 error 參數而非授權碼
  if (callbackParams.get("error")) {
    throw new OidcError("idp_error");
  }

  const client = { client_id: config.clientId };
  // JWKS 快取以每次登入為週期：IdP 輪換金鑰時不會被 isolate 內的
  // 舊快取卡住，單次登入的代價只是多一次 GET。
  const jwksCache = {};
  let tokens;
  try {
    const params = oauth.validateAuthResponse(as, client, callbackParams, stored.state);
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretBasic(config.clientSecret),
      params,
      redirectUri,
      stored.verifier,
      { [oauth.customFetch]: fetchImpl },
    );
    tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: stored.nonce,
      requireIdToken: true,
      [oauth.customFetch]: fetchImpl,
    });
    // oauth4webapi 依 OIDC 規範視「TLS 即身分驗證」，token 回應中的
    // ID token 簽章不在此預設檢查；本主控台以 JWKS 額外驗章。
    await oauth.validateApplicationLevelSignature(as, response, {
      [oauth.customFetch]: fetchImpl,
      [oauth.jwksCache]: jwksCache,
    });
  } catch {
    // state 不符、授權碼無效或 ID token 驗證失敗，一律不對外透露細節
    throw new OidcError("verification_failed", 401);
  }

  const claims = oauth.getValidatedIdTokenClaims(tokens);
  const email = String(claims?.email || "").toLowerCase();
  const allowedEmails = pendingSetup ? [pendingSetup.allowedEmail.toLowerCase()] : config.allowedEmails;
  if (!email || !allowedEmails.includes(email)) {
    throw new OidcError(pendingSetup ? "email_mismatch" : "email_not_allowed", 403);
  }
  return {
    email,
    setup: pendingSetup ? { id: pendingSetup.id } : null,
  };
}
