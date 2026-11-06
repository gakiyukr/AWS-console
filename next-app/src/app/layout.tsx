import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/toast-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Cloud Console",
    template: "%s - Cloud Console",
  },
  description: "管理 AWS（EC2／Lightsail）與 Oracle Cloud（OCI）執行個體的部署、電源與網路設定。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant" className="h-full" suppressHydrationWarning>
      <body className="min-h-full bg-background text-foreground antialiased">
        {children}
        <ToastProvider />
      </body>
    </html>
  );
}
