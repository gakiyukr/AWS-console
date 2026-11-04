// 首頁導向 EC2 區塊：EC2 與 Lightsail 已拆分為各自獨立的總覽，
// `/` 不再是混合清單，僅作入口轉址。
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function HomePage() {
  redirect("/ec2");
}
