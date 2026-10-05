import { RecordsNav } from "@/components/records-nav";

export default function RecordsLayout({ children }: { children: React.ReactNode }) {
  return <><RecordsNav />{children}</>;
}
