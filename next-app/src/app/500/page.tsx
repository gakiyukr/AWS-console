import { StatusPage } from "@/components/status-page";

export default function InternalErrorPage() {
  return (
    <StatusPage
      code="500"
      title="Oops! Something went wrong :')"
      description={"We apologize for the inconvenience. \n Please try again later."}
    />
  );
}
