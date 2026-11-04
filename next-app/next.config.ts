import path from "node:path";
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  // capjs-core 的 instrumentation（混淆腳本產生）會以動態 import 拉入
  // esbuild 與 javascript-obfuscator，兩者在 Workers 上皆不可用，且本專案
  // 不啟用 instrumentation（generateChallenge 未傳該選項）。lazy import 僅
  // 在使用時執行，故於伺服器打包以空模組替換，避免 webpack／Turbopack
  // 嘗試打包 esbuild 原生二進位（next dev 預設即 Turbopack）。
  turbopack: {
    resolveAlias: {
      esbuild: "./src/server/empty-module.js",
      "javascript-obfuscator": "./src/server/empty-module.js",
    },
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        esbuild: path.resolve(__dirname, "src/server/empty-module.js"),
        "javascript-obfuscator": path.resolve(__dirname, "src/server/empty-module.js"),
      };
    }
    return config;
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
