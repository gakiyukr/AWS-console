// Wavelength 部署已併入 EC2 新增流程（/ec2/new 的切換分頁），
// 舊網址轉址保留書籤。
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function WavelengthRedirectPage() {
  redirect("/ec2/new/wavelength");
}
