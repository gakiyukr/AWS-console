// 只解析一個 OCI CLI profile，避免將不同帳號的憑證混在一起。
// key_file 僅為本機路徑；瀏覽器不會據此讀取檔案。
export interface OciConfigFields {
  tenancy: string | null;
  user: string | null;
  fingerprint: string | null;
  region: string | null;
  keyFile: string | null;
}

const CONFIG_KEY_TO_FIELD = new Map<string, keyof OciConfigFields>([
  ["tenancy", "tenancy"],
  ["user", "user"],
  ["fingerprint", "fingerprint"],
  ["region", "region"],
  ["key_file", "keyFile"],
]);

function emptyFields(): OciConfigFields {
  return { tenancy: null, user: null, fingerprint: null, region: null, keyFile: null };
}

function configValue(text: string): string {
  // 只移除引號外、前面有空白的行尾註解，保留路徑內的 # 或分號。
  let quote = "";
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === quote) {
      quote = "";
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && (char === "#" || char === ";") && (index === 0 || /\s/.test(text[index - 1]))) {
      end = index;
      break;
    }
  }
  const value = text.slice(0, end).trim();
  return value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[0] === value[value.length - 1]
    ? value.slice(1, -1).trim()
    : value;
}

export function parseOciConfig(text: string): OciConfigFields {
  const profiles = new Map<string, OciConfigFields>();
  let profileName = "";
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (section) {
      profileName = section[1].trim();
      if (profiles.has(profileName)) {
        throw new Error("設定檔含重複的 profile，請只貼上要匯入的單一區段。");
      }
      profiles.set(profileName, emptyFields());
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const field = CONFIG_KEY_TO_FIELD.get(line.slice(0, eq).trim().toLowerCase());
    if (!field) continue;
    if (!profiles.has(profileName)) profiles.set(profileName, emptyFields());
    const fields = profiles.get(profileName)!;
    if (fields[field] !== null) {
      throw new Error("同一個 profile 含重複欄位，請確認設定檔內容。");
    }
    const value = configValue(line.slice(eq + 1).trim());
    fields[field] = field === "fingerprint" ? value.toLowerCase() : value;
  }
  // 完整設定檔固定選 DEFAULT；沒有 DEFAULT 時只接受唯一 profile，不做跨區段繼承。
  const selected = profiles.get("DEFAULT");
  if (selected) return selected;
  if (profiles.size > 1) {
    throw new Error("設定檔含多個 profile，請只貼上要匯入的單一區段，或使用 [DEFAULT]。");
  }
  return profiles.values().next().value ?? emptyFields();
}
