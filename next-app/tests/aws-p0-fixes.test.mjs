import assert from "node:assert/strict";
import test from "node:test";

import { ensureEniIpv6SgRules } from "../src/server/utils/ipv6.js";
import { rotateEc2Ipv6 } from "../src/server/utils/power.js";
import { generateCloudInitUserData } from "../src/server/utils/lightsail-deploy.js";

const FAKE_AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

test("ensureEniIpv6SgRules 送出單數 GroupId 參數而非 GroupId.1", async () => {
  const capturedBodies = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init = {}) => {
    capturedBodies.push(new URLSearchParams(String(init.body || "")));
    return new Response("<AuthorizeSecurityGroupIngressResponse/>", { status: 200 });
  };

  try {
    const warnings = await ensureEniIpv6SgRules(FAKE_AWS_ENV, "us-east-1", ["sg-0123456789abcdef0"]);
    assert.deepEqual(warnings, []);
    assert.equal(capturedBodies.length, 1);
    assert.equal(capturedBodies[0].get("Action"), "AuthorizeSecurityGroupIngress");
    assert.equal(capturedBodies[0].get("GroupId"), "sg-0123456789abcdef0");
    assert.equal(capturedBodies[0].get("GroupId.1"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rotateEc2Ipv6 可正常解析 ENI 並完成 Unassign → Assign 輪換", async () => {
  const actions = [];
  let describeCount = 0;
  const originalFetch = globalThis.fetch;

  const makeDescribeXml = (ipv6) => `
    <DescribeInstancesResponse>
      <reservationSet><item><instancesSet><item>
        <instanceId>i-0123456789abcdef0</instanceId>
        <vpcId>vpc-12345</vpcId>
        <subnetId>subnet-12345</subnetId>
        <networkInterfaceSet><item>
          <networkInterfaceId>eni-0123456789abcdef0</networkInterfaceId>
          <ipv6AddressesSet><item><ipv6Address>${ipv6}</ipv6Address></item></ipv6AddressesSet>
        </item></networkInterfaceSet>
      </item></instancesSet></item></reservationSet>
    </DescribeInstancesResponse>
  `;

  globalThis.fetch = async (_url, init = {}) => {
    const params = new URLSearchParams(String(init.body || ""));
    const action = params.get("Action");
    actions.push(action);
    if (action === "DescribeInstances") {
      describeCount += 1;
      const ip = describeCount === 1 ? "2600:1f18:100::1" : "2600:1f18:100::2";
      return new Response(makeDescribeXml(ip), { status: 200 });
    }
    return new Response("<Response/>", { status: 200 });
  };

  try {
    const result = await rotateEc2Ipv6(FAKE_AWS_ENV, { region: "us-east-1", instanceId: "i-0123456789abcdef0" });
    assert.deepEqual(result, { previousIp: "2600:1f18:100::1", newIp: "2600:1f18:100::2" });
    assert.deepEqual(actions, [
      "DescribeInstances",
      "UnassignIpv6Addresses",
      "AssignIpv6Addresses",
      "DescribeInstances",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Lightsail userData 支援 keys 陣列、明文非整包 Base64 且免疫密碼特殊字元注入", () => {
  const pubKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyDataForTestingOnly1234567890 test@host";
  const keyScript = generateCloudInitUserData({ type: "ssh_key", keys: [pubKey] });
  assert.equal(keyScript.startsWith("#!/bin/bash\n"), true);
  assert.equal(keyScript.includes("undefined"), false);
  const keyMatch = keyScript.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d >> \/root\/\.ssh\/authorized_keys/);
  assert.ok(keyMatch, "SSH 公鑰腳本應以 Base64 輸送避免跳脫風險");
  assert.equal(Buffer.from(keyMatch[1], "base64").toString("utf8"), `${pubKey}\n`);

  const trickyPassword = `p'w"$(id)\`reboot\`\\123`;
  const pwScript = generateCloudInitUserData({ type: "password", password: trickyPassword });
  assert.equal(pwScript.startsWith("#!/bin/bash\n"), true);
  assert.equal(pwScript.includes("$(id)"), false);
  assert.equal(pwScript.includes("PermitRootLogin yes"), true);
  assert.equal(pwScript.includes("PasswordAuthentication yes"), true);
  const pwMatch = pwScript.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| chpasswd/);
  assert.ok(pwMatch, "密碼腳本應以 Base64 輸送至 chpasswd");
  assert.equal(Buffer.from(pwMatch[1], "base64").toString("utf8"), `root:${trickyPassword}\n`);
});
