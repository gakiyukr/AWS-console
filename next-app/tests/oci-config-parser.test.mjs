import assert from "node:assert/strict";
import test from "node:test";
import { parseOciConfig } from "../src/lib/oci-config-parser.ts";

const config = [
  "user=ocid1.user.oc1..exampleuser",
  "fingerprint=F6:38:39:EF:41:27:61:6C:89:5D:01:17:0A:07:93:8E",
  "tenancy=ocid1.tenancy.oc1..exampletenancy",
  "region=eu-frankfurt-1",
  "key_file=\"C:\\keys\\key #1.pem\" # TODO",
].join("\n");

test("解析單一 DEFAULT、空白、註解與大寫指紋", () => {
  const fields = parseOciConfig(`\uFEFF[DEFAULT]\r\n${config}\r\n`);
  assert.equal(fields.user, "ocid1.user.oc1..exampleuser");
  assert.equal(fields.tenancy, "ocid1.tenancy.oc1..exampletenancy");
  assert.equal(fields.fingerprint, "f6:38:39:ef:41:27:61:6c:89:5d:01:17:0a:07:93:8e");
  assert.equal(fields.region, "eu-frankfurt-1");
  assert.equal(fields.keyFile, "C:\\keys\\key #1.pem");
});

test("沒有區段標頭或只有一個具名 profile 皆可解析", () => {
  assert.deepEqual(parseOciConfig(config), parseOciConfig(`[CUSTOM]\n${config}`));
});

test("優先使用 DEFAULT，絕不以其他 profile 補齊缺欄", () => {
  const fields = parseOciConfig(`[OTHER]\n${config}\n[DEFAULT]\nuser=ocid1.user.oc1..defaultuser`);
  assert.equal(fields.user, "ocid1.user.oc1..defaultuser");
  assert.equal(fields.tenancy, null);
  assert.equal(fields.fingerprint, null);
  assert.equal(fields.region, null);
});

test("多個具名 profile 未指定 DEFAULT 時拒絕猜測", () => {
  assert.throws(() => parseOciConfig(`[FIRST]\n${config}\n[SECOND]\nregion=ap-tokyo-1`), /多個 profile/);
});

test("拒絕重複區段或欄位，避免靜默採用錯誤值", () => {
  assert.throws(() => parseOciConfig(`[DEFAULT]\n${config}\n[DEFAULT]\nregion=ap-tokyo-1`), /重複/);
  assert.throws(() => parseOciConfig(`${config}\nregion=ap-tokyo-1`), /重複/);
});

test("不接受原型屬性作為設定欄位", () => {
  assert.deepEqual(parseOciConfig(`${config}\n__proto__=invalid\nconstructor=invalid`), parseOciConfig(config));
});

test("保留引號與路徑中的註解符號，忽略獨立註解行", () => {
  const fields = parseOciConfig("# 說明\r; 說明\rregion = eu-frankfurt-1 ; 預設區域\rkey_file=/keys/key#1.pem # TODO");
  assert.equal(fields.region, "eu-frankfurt-1");
  assert.equal(fields.keyFile, "/keys/key#1.pem");
});
