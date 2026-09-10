// OpenNext Cloudflare 執行期的 env 注入入口。
// 與 Nuxt 版的 event.context.cloudflare?.env 對應；所有移植的
// server/utils 模組仍以純函式接收 env，僅路由層經此取得 binding。
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function getEnv(): Promise<CloudflareEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as unknown as CloudflareEnv;
}
