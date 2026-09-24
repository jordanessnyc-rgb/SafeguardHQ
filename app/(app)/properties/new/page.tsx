import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { AddressSearch } from "./address-search";

export const metadata = { title: "New property" };

export default async function NewPropertyPage() {
  await requireStaff();
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New property"
        description="Look up the address to resolve its BBL/BIN, then we pull PLUTO, HPD registration, and HPD/DOB/ECB violations."
      />
      <AddressSearch />
    </div>
  );
}
