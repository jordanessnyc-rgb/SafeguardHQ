"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The email's own HTML, in a sandboxed iframe: no scripts (no allow-scripts), links open in a new
 * tab. allow-same-origin (without scripts) only lets this page measure the height so the email
 * reads like part of the page instead of a box with its own scrollbar.
 */
export function EmailFrame({ doc, title }: { doc: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const fit = () => {
      const d = frame.contentDocument;
      if (d?.documentElement) setHeight(Math.min(20_000, Math.max(80, Math.ceil(d.documentElement.getBoundingClientRect().height))));
    };
    // Fixed-width newsletters (often 600px) are shrunk to fit a phone, as mail apps do. Redone when
    // the frame's own width changes (it can load while hidden), never from inside the email's
    // resize handler, which zooming would re-trigger.
    let lastWidth = -1;
    const shrink = () => {
      const d = frame.contentDocument;
      const room = frame.clientWidth;
      if (!d?.body || room === lastWidth) return;
      lastWidth = room;
      d.body.style.zoom = "";
      const wide = d.documentElement.scrollWidth;
      if (room > 0 && wide > room + 4) d.body.style.zoom = String(Math.max(0.4, room / wide));
      fit();
    };
    const onLoad = () => {
      lastWidth = -1;
      shrink();
      fit();
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(fit);
        observer.observe(body);
      }
    };
    const outer = new ResizeObserver(shrink);
    outer.observe(frame);
    frame.addEventListener("load", onLoad);
    if (frame.contentDocument?.readyState === "complete") onLoad();
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
      outer.disconnect();
    };
  }, [doc]);
  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      style={{ height }}
      className="block w-full rounded-md border-0 bg-white"
    />
  );
}
