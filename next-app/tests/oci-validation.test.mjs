import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  importSigningKey,
  MAX_OCI_PRIVATE_KEY_LENGTH,
  normalizePrivateKeyPem,
} from "../src/server/utils/oci-request.js";
import { validateInput } from "../src/server/utils/validate.js";
import {
  mergeOciCredentialFields,
  normalizeOciAccountInput,
  validateOciPrivateKeyPem,
} from "../src/server/utils/oci-account-normalize.js";
import { createOciAccount, updateOciAccount } from "../src/server/utils/db.js";

const FINGERPRINT_UPPER = Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(2, "0"))
  .join(":")
  .toUpperCase();
const FINGERPRINT = FINGERPRINT_UPPER.toLowerCase();
const TENANCY = "ocid1.tenancy.oc1..RootTenant123";
const USER = "ocid1.user.oc1..ApiUser123";
const COMPARTMENT = "ocid1.compartment.oc1..ChildCompartment123";

function makeKeyPair() {
  const pkcs8 = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const pkcs1 = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey;
  const encrypted = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-only-passphrase",
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  return { pkcs8, pkcs1, encrypted };
}

function baseInput(overrides = {}) {
  return {
    name: "測試 OCI",
    tenancyOcid: TENANCY,
    userOcid: USER,
    fingerprint: FINGERPRINT_UPPER,
    region: "us-phoenix-1",
    compartmentOcid: COMPARTMENT,
    ...overrides,
  };
}

test("指紋接受 16 組大小寫十六進位並在正規化後轉小寫", () => {
  const direct = validateInput(FINGERPRINT_UPPER, "fingerprint", "Fingerprint");
  assert.equal(direct.valid, true);

  const normalized = normalizeOciAccountInput(baseInput());
  assert.equal(normalized.valid, true);
  assert.equal(normalized.values.fingerprint, FINGERPRINT);

  for (const invalid of [
    "00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e",
    `${FINGERPRINT}:10`,
    FINGERPRINT.replace("0f", "gg"),
    FINGERPRINT.replaceAll(":", ""),
  ]) {
    assert.equal(validateInput(invalid, "fingerprint", "Fingerprint").valid, false, invalid);
  }
});

test("OCID 只 trim 並保留類型限制，根 compartment 等於 tenancy 時轉空字串", () => {
  const normalized = normalizeOciAccountInput(baseInput({
    tenancyOcid: `  ${TENANCY}  `,
    userOcid: ` ${USER} `,
    compartmentOcid: ` ${TENANCY} `,
  }));
  assert.equal(normalized.valid, true);
  assert.equal(normalized.values.tenancyOcid, TENANCY);
  assert.equal(normalized.values.userOcid, USER);
  assert.equal(normalized.values.compartmentOcid, "");

  assert.equal(normalizeOciAccountInput(baseInput({ tenancyOcid: "ocid1.tenancy.oc2..wrongRealm" })).valid, false);
  assert.equal(normalizeOciAccountInput(baseInput({ compartmentOcid: "ocid1.compartment.oc2..wrongRealm" })).valid, false);
  assert.equal(normalizeOciAccountInput(baseInput({ userOcid: "ocid1.tenancy.oc1..wrongType" })).valid, false);
  assert.equal(normalizeOciAccountInput(baseInput({ compartmentOcid: 0 })).valid, false);
  assert.equal(normalizeOciAccountInput(baseInput({ compartmentOcid: false })).valid, false);
});

test("PUT 省略認證欄位時沿用既有帳號值並執行相同驗證", () => {
  const existing = {
    name: "既有名稱",
    tenancyOcid: TENANCY,
    userOcid: USER,
    fingerprint: FINGERPRINT_UPPER,
    region: "us-phoenix-1",
    compartmentOcid: COMPARTMENT,
  };
  const result = normalizeOciAccountInput({ name: "  新名稱  " }, { existing });
  assert.equal(result.valid, true);
  assert.deepEqual(result.values, {
    name: "新名稱",
    tenancyOcid: TENANCY,
    userOcid: USER,
    fingerprint: FINGERPRINT,
    region: "us-phoenix-1",
    compartmentOcid: COMPARTMENT,
  });
});

test("PKCS#8、PKCS#1 與 OCI_API_KEY 尾行可在儲存前由 WebCrypto 匯入", async () => {
  const keys = makeKeyPair();
  for (const pem of [keys.pkcs8, keys.pkcs1, `${keys.pkcs8}\nOCI_API_KEY\n`, `${keys.pkcs1}\nOCI_API_KEY\n`]) {
    const normalized = normalizePrivateKeyPem(pem);
    assert.doesNotMatch(normalized, /OCI_API_KEY/);
    await importSigningKey(pem);
    const checked = await validateOciPrivateKeyPem(pem);
    assert.equal(checked.valid, true);
  }
});

test("拒絕 encrypted、錯誤 boundary、錯誤 Base64 與超過大小上限的 PEM", async () => {
  const keys = makeKeyPair();
  assert.throws(() => normalizePrivateKeyPem(keys.encrypted), /不支援含密碼保護/);
  assert.throws(
    () => normalizePrivateKeyPem(keys.pkcs8.replace("END PRIVATE KEY", "END RSA PRIVATE KEY")),
    /PEM 私鑰格式無效/,
  );
  assert.throws(
    () => normalizePrivateKeyPem("-----BEGIN PRIVATE KEY-----\n%%%%\n-----END PRIVATE KEY-----"),
    /Base64/,
  );
  const tooLarge = "x".repeat(MAX_OCI_PRIVATE_KEY_LENGTH + 1);
  assert.throws(() => normalizePrivateKeyPem(tooLarge), /內容過大/);
  const checked = await validateOciPrivateKeyPem(tooLarge, { required: false });
  assert.deepEqual(checked, { valid: false, error: "PEM 私鑰內容過大" });
});

test("PUT 的空白私鑰保留密文，輪替私鑰後由 normalized fingerprint 重算 keyHint", () => {
  const existing = {
    keyCiphertext: "old-ciphertext",
    keyIv: "old-iv",
    encryptionKeyVersion: 1,
    keyHint: "old-hint",
  };
  const fingerprint = FINGERPRINT;
  const retained = mergeOciCredentialFields({ fingerprint, existing });
  assert.equal(retained.keyCiphertext, "old-ciphertext");
  assert.equal(retained.keyIv, "old-iv");
  assert.equal(retained.keyHint, fingerprint.slice(-5));

  const rotated = mergeOciCredentialFields({
    fingerprint,
    existing,
    encrypted: {
      keyCiphertext: "new-ciphertext",
      keyIv: "new-iv",
      encryptionKeyVersion: 1,
      keyHint: "stale-hint-must-not-win",
    },
  });
  assert.equal(rotated.keyCiphertext, "new-ciphertext");
  assert.equal(rotated.keyIv, "new-iv");
  assert.equal(rotated.keyHint, fingerprint.slice(-5));
});

class MockD1 {
  constructor(rows = []) {
    this.rows = rows.map(row => ({ ...row }));
    this.batchCalls = [];
    this.failOnInsert = false;
    this.failOnAccountUpdate = false;
  }

  prepare(sql) {
    const statement = {
      sql,
      values: [],
      bind: (...values) => {
        statement.values = values;
        return statement;
      },
      all: async () => ({ results: this._select(sql, statement.values) }),
      first: async () => this._select(sql, statement.values)[0] ?? null,
      run: async () => this._execute(sql, statement.values),
    };
    return statement;
  }

  async batch(statements) {
    this.batchCalls.push(statements.map(statement => statement.sql));
    const snapshot = this.rows.map(row => ({ ...row }));
    const previousRows = this.rows;
    this.rows = snapshot;
    try {
      const results = statements.map(statement => this._execute(statement.sql, statement.values));
      previousRows.splice(0, previousRows.length, ...this.rows.map(row => ({ ...row })));
      return results;
    } catch (error) {
      this.rows = previousRows;
      throw error;
    }
  }

  _select(sql, values) {
    if (!sql.startsWith("SELECT")) return [];
    if (sql.includes("WHERE id = ?1")) {
      return this.rows.filter(row => row.id === Number(values[0]));
    }
    return [...this.rows].sort((left, right) => left.id - right.id);
  }

  _execute(sql, values) {
    if (sql.startsWith("UPDATE oci_accounts SET is_default = 0")) {
      let changes = 0;
      for (const row of this.rows) {
        if (row.isDefault) {
          row.isDefault = 0;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }
    if (sql.startsWith("INSERT INTO oci_accounts")) {
      if (this.failOnInsert) throw new Error("simulated INSERT failure");
      const [name, tenancyOcid, userOcid, fingerprint, region, compartmentOcid,
        keyCiphertext, keyIv, keyHint, encryptionKeyVersion, enabled, isDefault, proxyId] = values;
      const id = Math.max(0, ...this.rows.map(row => row.id)) + 1;
      const row = {
        id,
        name,
        tenancyOcid,
        userOcid,
        fingerprint,
        region,
        compartmentOcid,
        keyCiphertext,
        keyIv,
        keyHint,
        encryptionKeyVersion,
        enabled,
        isDefault,
        proxyId,
        lastVerifiedAt: null,
      };
      this.rows.push(row);
      return { meta: { changes: 1, last_row_id: id } };
    }
    if (sql.startsWith("UPDATE oci_accounts SET")) {
      if (this.failOnAccountUpdate) throw new Error("simulated account UPDATE failure");
      const [id, name, tenancyOcid, userOcid, fingerprint, region, compartmentOcid,
        keyCiphertext, keyIv, keyHint, encryptionKeyVersion, enabled, isDefault, proxyId] = values;
      const row = this.rows.find(item => item.id === Number(id));
      if (!row) return { meta: { changes: 0 } };
      Object.assign(row, {
        name,
        tenancyOcid,
        userOcid,
        fingerprint,
        region,
        compartmentOcid,
        keyCiphertext,
        keyIv,
        keyHint,
        encryptionKeyVersion,
        enabled,
        isDefault,
        proxyId,
      });
      if (sql.includes("last_verified_at = NULL")) row.lastVerifiedAt = null;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled SQL in test mock: ${sql}`);
  }
}

function dbAccount(overrides = {}) {
  return {
    id: 1,
    name: "existing",
    tenancyOcid: TENANCY,
    userOcid: USER,
    fingerprint: FINGERPRINT,
    region: "us-phoenix-1",
    compartmentOcid: COMPARTMENT,
    keyCiphertext: "ciphertext",
    keyIv: "iv",
    keyHint: FINGERPRINT.slice(-5),
    encryptionKeyVersion: 1,
    enabled: 1,
    isDefault: 1,
    proxyId: null,
    lastVerifiedAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

test("OCI create 的清預設與 INSERT 同批次，批次失敗不清除原預設", async () => {
  const db = new MockD1([dbAccount()]);
  db.failOnInsert = true;
  await assert.rejects(
    createOciAccount(db, {
      name: "new",
      tenancyOcid: TENANCY,
      userOcid: USER,
      fingerprint: FINGERPRINT,
      region: "us-phoenix-1",
      compartmentOcid: COMPARTMENT,
      keyCiphertext: "new-ciphertext",
      keyIv: "new-iv",
      keyHint: FINGERPRINT.slice(-5),
      encryptionKeyVersion: 1,
      enabled: true,
      isDefault: true,
      proxyId: null,
    }),
    /simulated INSERT failure/,
  );
  assert.equal(db.rows[0].isDefault, 1);
  assert.equal(db.batchCalls.length, 1);
  assert.equal(db.batchCalls[0].length, 2);
});

test("OCI update 的清預設與 UPDATE 同批次，批次失敗不清除原預設", async () => {
  const db = new MockD1([dbAccount(), dbAccount({ id: 2, name: "other", isDefault: 0 })]);
  db.failOnAccountUpdate = true;
  await assert.rejects(
    updateOciAccount(db, 2, {
      name: "other-renamed",
      tenancyOcid: TENANCY,
      userOcid: USER,
      fingerprint: FINGERPRINT,
      region: "us-phoenix-1",
      compartmentOcid: COMPARTMENT,
      keyCiphertext: "ciphertext-2",
      keyIv: "iv-2",
      keyHint: FINGERPRINT.slice(-5),
      encryptionKeyVersion: 1,
      enabled: true,
      isDefault: true,
      proxyId: null,
    }),
    /simulated account UPDATE failure/,
  );
  assert.equal(db.rows.find(row => row.id === 1).isDefault, 1);
  assert.equal(db.rows.find(row => row.id === 2).isDefault, 0);
});

test("OCI update 名稱變更可保留驗證時間，區域變更會清除驗證時間", async () => {
  const db = new MockD1([dbAccount()]);
  await updateOciAccount(db, 1, {
    name: "renamed",
    tenancyOcid: TENANCY,
    userOcid: USER,
    fingerprint: FINGERPRINT,
    region: "us-phoenix-1",
    compartmentOcid: COMPARTMENT,
    keyCiphertext: "ciphertext",
    keyIv: "iv",
    keyHint: FINGERPRINT.slice(-5),
    encryptionKeyVersion: 1,
    enabled: true,
    isDefault: true,
    proxyId: null,
  });
  assert.equal(db.rows[0].lastVerifiedAt, "2026-01-01 00:00:00");

  await updateOciAccount(db, 1, {
    name: "renamed",
    tenancyOcid: TENANCY,
    userOcid: USER,
    fingerprint: FINGERPRINT,
    region: "eu-frankfurt-1",
    compartmentOcid: COMPARTMENT,
    keyCiphertext: "ciphertext",
    keyIv: "iv",
    keyHint: FINGERPRINT.slice(-5),
    encryptionKeyVersion: 1,
    enabled: true,
    isDefault: true,
    proxyId: null,
  });
  assert.equal(db.rows[0].lastVerifiedAt, null);
});
