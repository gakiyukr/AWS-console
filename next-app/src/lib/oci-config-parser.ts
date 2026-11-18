// 解析 OCI CLI 設定檔（~/.oci/config）的 ini 格式內容，
// 取出 tenancy／user／fingerprint／region／key_file 五個欄位。
// key_file 僅為本機路徑，瀏覽器無法讀取檔案內容，因此只回傳路徑供提示使用。
// 多 profile（多個 [section]）時以第一個出現的鍵為準，避免後段 profile 覆蓋前段。

export interface OciConfigFields {
  tenancy: string | null;
  user: string | null;
  fingerprint: string | null;
  region: string | null;
  keyFile: string | null;
}

const CONFIG_KEY_TO_FIELD: Record<string, keyof OciConfigFields> = {
  tenancy: "tenancy",
  user: "user",
  fingerprint: "fingerprint",
  region: "region",
  key_file: "keyFile",
};

export function parseOciConfig(text: string): OciConfigFields {
  const fields: OciConfigFields = {
    tenancy: null,
    user: null,
    fingerprint: null,
    region: null,
    keyFile: null,
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 略過空行、註解與 [section] 標頭
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim().toLowerCase();
    const field = CONFIG_KEY_TO_FIELD[key];
    if (!field || fields[field]) {
      continue;
    }
    const value = line.slice(eq + 1).trim();
    if (value) {
      fields[field] = value;
    }
  }
  return fields;
}
