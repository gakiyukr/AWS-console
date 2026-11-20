import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRegionKeyMap,
  listRegionSubscriptions,
  readyOciRegions,
  regionFromInstanceOcid,
  resolveInstanceContext,
  sortOciRegions,
} from "../src/server/utils/oci-regions.js";
import { ociEndpoint } from "../src/server/utils/oci-request.js";
import {
  listCachedOciRegions,
  replaceCachedOciRegions,
} from "../src/server/utils/db.js";

const SUBSCRIPTIONS = [
  { region: "eu-frankfurt-1", regionKey: "FRA", isHomeRegion: true, status: "READY" },
  { region: "ap-tokyo-1", regionKey: "NRT", isHomeRegion: false, status: "READY" },
  { region: "us-ashburn-1", regionKey: "IAD", isHomeRegion: false, status: "PENDING_UPGRADE" },
];

test("OCID 含 identifier 段時直接回傳該區域", () => {
  const keyMap = buildRegionKeyMap(SUBSCRIPTIONS);
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.ap-tokyo-1.abcd1234", keyMap), "ap-tokyo-1");
  assert.equal(
    regionFromInstanceOcid("ocid1.instance.oc1.us-ashburn-1.aaaaaaaax", keyMap),
    "us-ashburn-1",
  );
});

test("OCID 含舊式 region key 段時以對映轉回 identifier", () => {
  const keyMap = buildRegionKeyMap(SUBSCRIPTIONS);
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.fra.abcd1234", keyMap), "eu-frankfurt-1");
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.NRT.abcd1234", keyMap), "ap-tokyo-1");
});

test("全域資源 OCID（雙點、無區域段）或未知段回 null", () => {
  const keyMap = buildRegionKeyMap(SUBSCRIPTIONS);
  assert.equal(regionFromInstanceOcid("ocid1.tenancy.oc1..aaaaaaaax", keyMap), null);
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.not-a-region.aaaa", keyMap), null);
  assert.equal(regionFromInstanceOcid("", keyMap), null);
  // 未提供對映時 identifier 仍可直接辨識
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.ap-tokyo-1.abcd1234"), "ap-tokyo-1");
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.fra.abcd1234"), null);
});

test("訂閱清單對映涵蓋 identifier 與 key 兩種鍵", () => {
  const keyMap = buildRegionKeyMap(SUBSCRIPTIONS);
  assert.equal(keyMap.get("fra"), "eu-frankfurt-1");
  assert.equal(keyMap.get("eu-frankfurt-1"), "eu-frankfurt-1");
  assert.equal(keyMap.get("iad"), "us-ashburn-1");
});

class MockD1 {
  constructor(rows = []) {
    this.rows = rows.map(row => ({ ...row }));
    this.batches = [];
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
    this.batches.push(statements.map(statement => statement.sql));
    for (const statement of statements) {
      this._execute(statement.sql, statement.values);
    }
    return statements.map(() => ({ meta: { changes: 1 } }));
  }

  _select(sql, values) {
    if (!sql.startsWith("SELECT")) return [];
    // 模擬 D1 的 SELECT 別名：is_home_region AS isHomeRegion
    return this.rows.filter(row => Number(row.oci_account_id) === Number(values[0]))
      .sort((a, b) => a.region.localeCompare(b.region))
      .map(row => ({
        region: row.region,
        regionKey: row.region_key,
        isHomeRegion: row.is_home_region,
        status: row.status,
      }));
  }

  _execute(sql, values) {
    if (sql.startsWith("DELETE")) {
      this.rows = this.rows.filter(row => Number(row.oci_account_id) !== Number(values[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT")) {
      const [accountId, region, regionKey, isHomeRegion, status] = values;
      this.rows.push({
        oci_account_id: accountId,
        region,
        region_key: regionKey,
        is_home_region: isHomeRegion,
        status,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled SQL in test mock: ${sql}`);
  }
}

test("訂閱快取整批替換與讀取往返", async () => {
  const db = new MockD1();
  const count = await replaceCachedOciRegions(db, 7, SUBSCRIPTIONS);
  assert.equal(count, 3);
  // 原子批次：先 DELETE 後 INSERT
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0][0], "DELETE FROM oci_account_regions WHERE oci_account_id = ?1");

  const cached = await listCachedOciRegions(db, 7);
  assert.deepEqual(
    cached.map(item => ({ region: item.region, isHomeRegion: item.isHomeRegion, status: item.status })),
    [
      { region: "ap-tokyo-1", isHomeRegion: false, status: "READY" },
      { region: "eu-frankfurt-1", isHomeRegion: true, status: "READY" },
      { region: "us-ashburn-1", isHomeRegion: false, status: "PENDING_UPGRADE" },
    ],
  );
  assert.equal(cached[1].regionKey, "FRA");

  // 再次替換為單一區域：舊列全部清除（冪等）
  await replaceCachedOciRegions(db, 7, [{ region: "ap-tokyo-1", regionKey: "NRT", isHomeRegion: false, status: "READY" }]);
  const after = await listCachedOciRegions(db, 7);
  assert.deepEqual(after.map(item => item.region), ["ap-tokyo-1"]);

  // 空清單也走批次（只有 DELETE），不同帳號互不影響
  await replaceCachedOciRegions(db, 8, []);
  assert.deepEqual(await listCachedOciRegions(db, 8), []);
  assert.equal((await listCachedOciRegions(db, 7)).length, 1);
});

test("ociEndpoint 依服務名稱組出 iaas 或 identity 端點", () => {
  assert.equal(ociEndpoint("eu-frankfurt-1"), "https://iaas.eu-frankfurt-1.oraclecloud.com");
  assert.equal(ociEndpoint("eu-frankfurt-1", "identity"), "https://identity.eu-frankfurt-1.oraclecloud.com");
});

test("sortOciRegions 與 readyOciRegions 排序與篩選行為", () => {
  const sorted = sortOciRegions([
    { region: "us-ashburn-1", isHomeRegion: false, status: "PENDING_UPGRADE" },
    { region: "ap-tokyo-1", isHomeRegion: false, status: "READY" },
    { region: "eu-frankfurt-1", isHomeRegion: true, status: "READY" },
  ]);
  assert.deepEqual(sorted.map(item => item.region), ["eu-frankfurt-1", "ap-tokyo-1", "us-ashburn-1"]);

  assert.deepEqual(readyOciRegions(sorted).map(item => item.region), ["eu-frankfurt-1", "ap-tokyo-1"]);
  const pendingOnly = [{ region: "us-ashburn-1", status: "PENDING_UPGRADE" }];
  assert.deepEqual(readyOciRegions(pendingOnly).map(item => item.region), ["us-ashburn-1"]);
});

test("regionFromInstanceOcid 支援 publicip OCID 與大寫 identifier 正規化", () => {
  const keyMap = buildRegionKeyMap(SUBSCRIPTIONS);
  assert.equal(regionFromInstanceOcid("ocid1.publicip.oc1.NRT.abcd1234", keyMap), "ap-tokyo-1");
  assert.equal(regionFromInstanceOcid("ocid1.instance.oc1.AP-TOKYO-1.abcd1234"), "ap-tokyo-1");
});

test("listRegionSubscriptions 使用 identity 端點、tenancies 路徑並解析 isHomeRegion", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = Buffer.from(pkcs8).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify([
        { regionName: "us-ashburn-1", regionKey: "IAD", isHomeRegion: false, status: "PENDING_UPGRADE" },
        { regionName: "eu-frankfurt-1", regionKey: "FRA", isHomeRegion: true, status: "READY" },
        { regionName: "ap-tokyo-1", regionKey: "NRT", isHomeRegion: false, status: "READY" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await listRegionSubscriptions({
      account: {
        tenancyOcid: "ocid1.tenancy.oc1..aaaaexample",
        userOcid: "ocid1.user.oc1..aaaauser",
        fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
        region: "ap-tokyo-1",
      },
      privateKeyPem: pem,
    });
    assert.equal(
      capturedUrl,
      "https://identity.ap-tokyo-1.oraclecloud.com/20160918/tenancies/ocid1.tenancy.oc1..aaaaexample/regionSubscriptions",
    );
    assert.deepEqual(result, [
      { region: "eu-frankfurt-1", regionKey: "FRA", isHomeRegion: true, status: "READY" },
      { region: "ap-tokyo-1", regionKey: "NRT", isHomeRegion: false, status: "READY" },
      { region: "us-ashburn-1", regionKey: "IAD", isHomeRegion: false, status: "PENDING_UPGRADE" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveInstanceContext 依序處理明確 region、OCID 快取與預設回退", async () => {
  const db = new MockD1();
  await replaceCachedOciRegions(db, 7, SUBSCRIPTIONS);
  const resolved = {
    account: { id: 7 },
    ociAccount: { id: 7, region: "eu-frankfurt-1", compartmentOcid: "ocid1.tenancy.oc1..aaa" },
    privateKeyPem: "dummy-pem",
  };

  // 1. 已明確指定 region 時直接使用（假設呼叫端已覆蓋 ociAccount.region）
  const explicit = await resolveInstanceContext(
    { DB: db },
    { ...resolved, ociAccount: { ...resolved.ociAccount, region: "ap-tokyo-1" } },
    "ocid1.instance.oc1.fra.abcd",
    "ap-tokyo-1",
  );
  assert.equal(explicit.region, "ap-tokyo-1");

  // 2. 含舊式 region key 時由快取轉回 identifier
  const fromKey = await resolveInstanceContext({ DB: db }, resolved, "ocid1.instance.oc1.nrt.abcd");
  assert.equal(fromKey.region, "ap-tokyo-1");

  // 3. 含 identifier 時直接解析
  const fromIdent = await resolveInstanceContext({ DB: db }, resolved, "ocid1.publicip.oc1.ap-tokyo-1.abcd");
  assert.equal(fromIdent.region, "ap-tokyo-1");

  // 4. 無法辨識時回退帳號預設區域
  const fallback = await resolveInstanceContext({ DB: db }, resolved, "ocid1.instance.oc1.unknown.abcd");
  assert.equal(fallback.region, "eu-frankfurt-1");
});
