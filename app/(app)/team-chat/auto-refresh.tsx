"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-reads the chat every `seconds` while the tab is visible, and scrolls to the newest message once. */
export function AutoRefresh({ seconds = 20, scrollTo }: { seconds?: number; scrollTo?: string }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  useEffect(() => {
    if (!location.hash && scrollTo) document.getElementById(scrollTo)?.scrollIntoView({ block: "end" });
  }, [scrollTo]);
  return null;
}
