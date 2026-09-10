import { StatusPage } from "@/components/status-page";

export default function ForbiddenPage() {
  return (
    <StatusPage
      code="403"
      title="Access Forbidden"
      description={"You don't have necessary permission \n to view this resource."}
    />
  );
}
