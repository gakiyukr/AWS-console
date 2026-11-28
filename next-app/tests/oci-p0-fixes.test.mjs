import assert from "node:assert/strict";
import test from "node:test";

import { instanceAction } from "../src/server/utils/oci-compute.js";
import {
  enableInstanceIpv6,
  openSecurityList,
  pickSubnetIpv6Cidr,
  rotateInstanceIpv6,
} from "../src/server/utils/oci-network.js";
import {
  getInstanceAgentCommandExecution,
  pollCommandExecution,
} from "../src/server/utils/oci-agent.js";

/** 產生測試用臨時 RSA PKCS#8 PEM 私鑰。 */
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

test("instanceAction 將 action 放在 query parameter 而非 request body", async () => {
  const pem = await generateTestPem();
  const captured = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    captured.push({ method: init.method, pathname: parsed.pathname, actionQuery: parsed.searchParams.get("action"), body });
    return new Response(JSON.stringify({ id: "ocid1.instance.oc1.ap-tokyo-1.demo", lifecycleState: "STARTING" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await instanceAction({ account: TEST_ACCOUNT, privateKeyPem: pem }, "ocid1.instance.oc1.ap-tokyo-1.demo", "START");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].pathname, "/20160918/instances/ocid1.instance.oc1.ap-tokyo-1.demo");
    assert.equal(captured[0].actionQuery, "START");
    assert.deepEqual(captured[0].body, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pickSubnetIpv6Cidr 正確比對壓縮與前導零 IPv6 CIDR 並輸出標準 /64", () => {
  // 2603:c023:8000:100::/56 的第一個子網為 2603:c023:8000:100::/64（與 0100 等價）
  const next1 = pickSubnetIpv6Cidr(
    ["2603:c023:8000:100::/56"],
    ["2603:c023:8000:100::/64", "2603:c023:8000:0101::/64"],
  );
  assert.equal(next1, "2603:c023:8000:102::/64");

  // 第 4 段為 0000 時，2603:c023:8000::/64 與 2603:c023:8000:0000::/64 皆應視為已佔用
  const next2 = pickSubnetIpv6Cidr(
    ["2603:c023:8000::/56"],
    ["2603:c023:8000::/64"],
  );
  assert.equal(next2, "2603:c023:8000:1::/64");
});

test("openSecurityList 具備完整冪等性，不重複寫入且不誤判特定埠規則", async () => {
  const pem = await generateTestPem();
  let currentIngress = [
    { protocol: "6", source: "0.0.0.0/0", tcpOptions: { destinationPortRange: { min: 22, max: 22 } } },
    { protocol: "17", source: "0.0.0.0/0", udpOptions: { destinationPortRange: { min: 53, max: 53 } } },
  ];
  let currentEgress = [];
  let putCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/20160918/securityLists/ocid1.sl.test") {
      return new Response(JSON.stringify({
        ingressSecurityRules: currentIngress,
        egressSecurityRules: currentEgress,
      }), { status: 200 });
    }
    if (init.method === "PUT" && parsed.pathname === "/20160918/securityLists/ocid1.sl.test") {
      putCount += 1;
      const body = JSON.parse(String(init.body));
      currentIngress = body.ingressSecurityRules;
      currentEgress = body.egressSecurityRules;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    throw new Error(`Unexpected: ${init.method} ${parsed.pathname}`);
  };

  try {
    const first = await openSecurityList(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { securityListId: "ocid1.sl.test" },
    );
    assert.equal(first.added.length, 8);
    assert.equal(putCount, 1);

    // 二次執行必須完全冪等，不再送出 PUT
    const second = await openSecurityList(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { securityListId: "ocid1.sl.test" },
    );
    assert.equal(second.added.length, 0);
    assert.equal(putCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rotateInstanceIpv6 使用官方單數 /20160918/ipv6 路徑與 ipAddress 欄位", async () => {
  const pem = await generateTestPem();
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method, pathname: parsed.pathname, query: parsed.search });
    if (init.method === "GET" && parsed.pathname === "/20160918/ipv6") {
      return new Response(JSON.stringify([
        { id: "ocid1.ipv6.oc1.ap-tokyo-1.old", ipAddress: "2603:c023:8000:100::10" },
      ]), { status: 200 });
    }
    if (init.method === "DELETE" && parsed.pathname === "/20160918/ipv6/ocid1.ipv6.oc1.ap-tokyo-1.old") {
      return new Response(null, { status: 204 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/ipv6") {
      return new Response(JSON.stringify({
        id: "ocid1.ipv6.oc1.ap-tokyo-1.new",
        ipAddress: "2603:c023:8000:100::99",
      }), { status: 200 });
    }
    throw new Error(`Unexpected: ${init.method} ${parsed.pathname}`);
  };

  try {
    const result = await rotateInstanceIpv6(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { compartmentOcid: TEST_ACCOUNT.compartmentOcid, vnicId: "ocid1.vnic.test" },
    );
    assert.equal(result.previousIp, "2603:c023:8000:100::10");
    assert.equal(result.newIp, "2603:c023:8000:100::99");
    assert.equal(result.opened, false);
    assert.deepEqual(calls.map(c => `${c.method} ${c.pathname}`), [
      "GET /20160918/ipv6",
      "DELETE /20160918/ipv6/ocid1.ipv6.oc1.ap-tokyo-1.old",
      "POST /20160918/ipv6",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enableInstanceIpv6 使用官方 AddIpv6VcnCidr / AddIpv6SubnetCidr 且正確合併安全清單警告", async () => {
  const pem = await generateTestPem();
  const calls = [];
  let vcnHasIpv6 = false;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method, pathname: parsed.pathname, body });

    if (init.method === "GET" && parsed.pathname === "/20160918/subnets/ocid1.subnet.1") {
      return new Response(JSON.stringify({
        id: "ocid1.subnet.1",
        vcnId: "ocid1.vcn.1",
        routeTableId: "ocid1.rt.1",
        securityListIds: ["ocid1.sl.1"],
      }), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/vcns/ocid1.vcn.1") {
      return new Response(JSON.stringify({
        id: "ocid1.vcn.1",
        lifecycleState: "AVAILABLE",
        ipv6CidrBlocks: vcnHasIpv6 ? ["2603:c023:8000:100::/56"] : [],
      }), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/vcns/ocid1.vcn.1/actions/addIpv6Cidr") {
      vcnHasIpv6 = true;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/subnets") {
      return new Response(JSON.stringify([
        { id: "ocid1.subnet.other", ipv6CidrBlock: "2603:c023:8000:100::/64" },
      ]), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/subnets/ocid1.subnet.1/actions/addIpv6Cidr") {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/internetGateways") {
      return new Response(JSON.stringify([{ id: "ocid1.igw.1" }]), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/routeTables/ocid1.rt.1") {
      return new Response(JSON.stringify({ routeRules: [] }), { status: 200 });
    }
    if (init.method === "PUT" && parsed.pathname === "/20160918/routeTables/ocid1.rt.1") {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/securityLists/ocid1.sl.1") {
      return new Response(JSON.stringify({ ingressSecurityRules: [], egressSecurityRules: [] }), { status: 200 });
    }
    if (init.method === "PUT" && parsed.pathname === "/20160918/securityLists/ocid1.sl.1") {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (init.method === "GET" && parsed.pathname === "/20160918/ipv6") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname === "/20160918/ipv6") {
      return new Response(JSON.stringify({ id: "ocid1.ipv6.new", ipAddress: "2603:c023:8000:101::5" }), { status: 200 });
    }
    throw new Error(`Unexpected: ${init.method} ${parsed.pathname}`);
  };

  try {
    const result = await enableInstanceIpv6(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { compartmentOcid: TEST_ACCOUNT.compartmentOcid, vnicId: "ocid1.vnic.1", vnic: { subnetId: "ocid1.subnet.1" } },
    );
    assert.equal(result.ipv6Address, "2603:c023:8000:101::5");
    assert.equal(result.warnings.length >= 2, true);

    const addVcn = calls.find(c => c.pathname === "/20160918/vcns/ocid1.vcn.1/actions/addIpv6Cidr");
    assert.deepEqual(addVcn?.body, { isOracleGuaAllocationEnabled: true });

    const addSubnet = calls.find(c => c.pathname === "/20160918/subnets/ocid1.subnet.1/actions/addIpv6Cidr");
    assert.deepEqual(addSubnet?.body, { ipv6CidrBlock: "2603:c023:8000:101::/64" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Instance Agent 狀態查詢走 /status?instanceId=... 並正確判讀 content.exitCode", async () => {
  const pem = await generateTestPem();
  const captured = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    captured.push({ method: init.method, pathname: parsed.pathname, instanceId: parsed.searchParams.get("instanceId") });
    return new Response(JSON.stringify({
      lifecycleState: "SUCCEEDED",
      deliveryState: "VISIBLE",
      content: { outputType: "TEXT", exitCode: 1, text: "sudo: a password is required" },
    }), { status: 200 });
  };

  try {
    const exec = await getInstanceAgentCommandExecution(
      { account: TEST_ACCOUNT, privateKeyPem: pem },
      { commandId: "ocid1.cmd.1", instanceId: "ocid1.inst.1" },
    );
    assert.equal(exec.content.exitCode, 1);
    assert.equal(captured[0].pathname, "/20180530/instanceAgentCommands/ocid1.cmd.1/status");
    assert.equal(captured[0].instanceId, "ocid1.inst.1");

    await assert.rejects(
      () => pollCommandExecution(
        { account: TEST_ACCOUNT, privateKeyPem: pem },
        { commandId: "ocid1.cmd.1", instanceId: "ocid1.inst.1", maxAttempts: 1, pollIntervalMs: 1 },
      ),
      /離開代碼：1/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
