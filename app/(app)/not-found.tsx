import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">That record doesn&apos;t exist, was archived, or you don&apos;t have access to it.</p>
      <div className="mt-5 flex justify-center gap-2">
        <Link href="/" className={buttonVariants()}>Go to the dashboard</Link>
      </div>
    </div>
  );
}
