import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { createBid } from "../actions";
import { BidFields } from "../bid-fields";

export const metadata = { title: "New bid" };

export default async function NewBidPage() {
  await requireStaff();
  return (
    <>
      <PageHeader title="New bid" description={<Link href="/bids" className="hover:underline">← Bids</Link>} />
      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <p className="mb-4 text-sm text-muted-foreground">Only the title is required — after saving, upload the solicitation PDF and the AI fills in the rest and checks it against ESS&apos;s licenses.</p>
          <ActionForm action={createBid} className="space-y-4">
            <BidFields />
            <SubmitButton>Create bid</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
