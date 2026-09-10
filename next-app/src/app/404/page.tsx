import { StatusPage } from "@/components/status-page";

export default function NotFoundPage() {
  return (
    <StatusPage
      code="404"
      title="Oops! Page Not Found!"
      description={"It seems like the page you're looking for \n does not exist or might have been removed."}
    />
  );
}
