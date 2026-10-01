"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/** J/K next/previous message, A accepts the suggestion, / jumps to the job search. */
export function InboxKeys({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "j" && nextHref) router.push(nextHref, { scroll: false });
      else if (e.key === "k" && prevHref) router.push(prevHref, { scroll: false });
      else if (e.key === "a") document.querySelector<HTMLButtonElement>("[data-accept] button")?.click();
      else if (e.key === "/") {
        const box = document.querySelector<HTMLElement>("[data-job-search]");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prevHref, nextHref]);
  // Keep the open message visible in the list.
  useEffect(() => {
    document.querySelector("[data-inbox-item][aria-current]")?.scrollIntoView({ block: "nearest" });
  });
  return null;
}
