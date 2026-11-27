import assert from "node:assert/strict";
import test from "node:test";

import { initializeNetwork } from "../src/server/utils/oci-network.js";

/** 產生測試用臨時 RSA PKCS#8 PEM 私鑰，供 OCI 簽章層通過金鑰匯入。 */
async function generateTestPem() {
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
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;
}

const TEST_ACCOUNT = {
  tenancyOcid: "ocid1.tenancy.oc1..aaaaexample",
  userOcid: "ocid1.user.oc1..aaaauser",
  fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
  region: "ap-tokyo-1",
  compartmentOcid: "ocid1.compartment.oc1..aaaacomp",
};

test("無既有 VCN 時建立純 IPv4 公開網路且路由表不含 ::/0", async () => {
  const pem = await generateTestPem();
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, query: parsed.search, body });

    if (init.method === "GET" && parsed.pathname === "/20160918/vcns") {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/vcns") {
      return new Response(JSON.stringify({ id: "ocid1.vcn.oc1.ap-tokyo-1.newvcn" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/internetGateways") {
      return new Response(JSON.stringify({ id: "ocid1.internetgateway.oc1.ap-tokyo-1.newigw" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/routeTables") {
      return new Response(JSON.stringify({ id: "ocid1.routetable.oc1.ap-tokyo-1.newrt" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/securityLists") {
      return new Response(JSON.stringify({ id: "ocid1.securitylist.oc1.ap-tokyo-1.newsl" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/subnets") {
      return new Response(JSON.stringify({ id: "ocid1.subnet.oc1.ap-tokyo-1.newsubnet" }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${init.method} ${parsed.pathname}`);
  };

  try {
    const result = await initializeNetwork(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { compartmentOcid: TEST_ACCOUNT.compartmentOcid },
    );
    assert.equal(result.vcnId, "ocid1.vcn.oc1.ap-tokyo-1.newvcn");
    assert.equal(result.subnetId, "ocid1.subnet.oc1.ap-tokyo-1.newsubnet");
    assert.equal(result.securityListId, "ocid1.securitylist.oc1.ap-tokyo-1.newsl");
    assert.deepEqual(result.warnings, []);

    // 確認建立 VCN 時未啟用 IPv6，且路由表僅含 0.0.0.0/0（無 ::/0）
    const vcnCall = calls.find(c => c.method === "POST" && c.path === "/20160918/vcns");
    assert.equal(vcnCall.body.isIpv6Enabled, undefined);

    const rtCall = calls.find(c => c.method === "POST" && c.path === "/20160918/routeTables");
    assert.deepEqual(rtCall.body.routeRules, [
      {
        destination: "0.0.0.0/0",
        destinationType: "CIDR_BLOCK",
        networkEntityId: "ocid1.internetgateway.oc1.ap-tokyo-1.newigw",
      },
    ]);

    const subnetCall = calls.find(c => c.method === "POST" && c.path === "/20160918/subnets");
    assert.equal(subnetCall.body.prohibitPublicIpOnLaunch, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("第二個既有 VCN 含有公開子網時直接沿用，不重複新建資源", async () => {
  const pem = await generateTestPem();
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method || "GET", path: parsed.pathname, query: parsed.search });

    if (init.method === "GET" && parsed.pathname === "/20160918/vcns") {
      return new Response(JSON.stringify([
        { id: "ocid1.vcn.oc1.ap-tokyo-1.privateonly", displayName: "priv-vcn", lifecycleState: "AVAILABLE" },
        { id: "ocid1.vcn.oc1.ap-tokyo-1.haspublic", displayName: "pub-vcn", lifecycleState: "AVAILABLE" },
      ]), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/subnets") {
      const vcnId = parsed.searchParams.get("vcnId");
      if (vcnId === "ocid1.vcn.oc1.ap-tokyo-1.privateonly") {
        return new Response(JSON.stringify([
          { id: "ocid1.subnet.oc1.ap-tokyo-1.priv", lifecycleState: "AVAILABLE", prohibitPublicIpOnLaunch: true },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([
        {
          id: "ocid1.subnet.oc1.ap-tokyo-1.pub",
          lifecycleState: "AVAILABLE",
          prohibitPublicIpOnLaunch: false,
          securityListIds: ["ocid1.securitylist.oc1.ap-tokyo-1.existing"],
        },
      ]), { status: 200 });
    }
    throw new Error(`Unexpected request: ${init.method} ${parsed.pathname}`);
  };

  try {
    const result = await initializeNetwork(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { compartmentOcid: TEST_ACCOUNT.compartmentOcid },
    );
    assert.equal(result.vcnId, "ocid1.vcn.oc1.ap-tokyo-1.haspublic");
    assert.equal(result.subnetId, "ocid1.subnet.oc1.ap-tokyo-1.pub");
    assert.equal(result.securityListId, "ocid1.securitylist.oc1.ap-tokyo-1.existing");
    assert.deepEqual(result.warnings, []);
    assert.equal(calls.some(c => c.method === "POST"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("既有 VCN 皆無公開子網時，附加警告並新建公開網路", async () => {
  const pem = await generateTestPem();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/20160918/vcns") {
      return new Response(JSON.stringify([
        { id: "ocid1.vcn.oc1.ap-tokyo-1.empty", displayName: "empty-vcn", lifecycleState: "AVAILABLE" },
      ]), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/subnets") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/vcns") {
      return new Response(JSON.stringify({ id: "ocid1.vcn.oc1.ap-tokyo-1.created" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/internetGateways") {
      return new Response(JSON.stringify({ id: "ocid1.internetgateway.oc1.ap-tokyo-1.igw" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/routeTables") {
      return new Response(JSON.stringify({ id: "ocid1.routetable.oc1.ap-tokyo-1.rt" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/securityLists") {
      return new Response(JSON.stringify({ id: "ocid1.securitylist.oc1.ap-tokyo-1.sl" }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/subnets") {
      return new Response(JSON.stringify({ id: "ocid1.subnet.oc1.ap-tokyo-1.sub" }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${init.method} ${parsed.pathname}`);
  };

  try {
    const result = await initializeNetwork(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { compartmentOcid: TEST_ACCOUNT.compartmentOcid },
    );
    assert.equal(result.vcnId, "ocid1.vcn.oc1.ap-tokyo-1.created");
    assert.equal(result.subnetId, "ocid1.subnet.oc1.ap-tokyo-1.sub");
    assert.equal(result.warnings.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
