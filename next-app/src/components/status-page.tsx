'use client'

// 錯誤頁共用外框：對應 Nuxt 版 app/pages/(error) 的版面與行為。
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";

interface StatusPageProps {
  code: string
  title: string
  description: string
  showRetry?: boolean
}

export function StatusPage({ code, title, description, showRetry = false }: StatusPageProps) {
  const router = useRouter();

  // 直接輸入網址進入錯誤頁時瀏覽歷史長度為 1，router.back() 無作用；
  // 此時改為導向首頁，避免留下死按鈕。
  function goBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/");
  }

  return (
    <div className="h-svh">
      <div className="m-auto flex h-full w-full flex-col items-center justify-center gap-2">
        <h1 className="text-[7rem] font-bold leading-tight">{code}</h1>
        <span className="font-medium">{title}</span>
        <p className="text-center text-muted whitespace-pre-line">{description}</p>
        <div className="mt-6 flex gap-4">
          <Button variant="secondary" onPress={goBack}>
            返回上一頁
          </Button>
          {showRetry
            ? <Button onPress={() => window.location.reload()}>重新檢查</Button>
            : <Button onPress={() => router.push("/")}>回到首頁</Button>}
        </div>
      </div>
    </div>
  );
}
