import { StatusPage } from "@/components/status-page";

export default function UnauthorizedPage() {
  return (
    <StatusPage
      code="401"
      title="Unauthorized Access"
      description={"Please log in with the appropriate credentials \n to access this resource."}
    />
  );
}
