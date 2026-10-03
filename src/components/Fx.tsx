"use client";

import { useEffect, useRef, useState } from "react";

const GLASS = ".card,.panel,.kpi,.co,.rc,.wallet,.rule,.rules>div,.vault,.ringcard";

/** Ambient background plus a cursor spotlight on glass surfaces and scroll reveals. */
export function Fx() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (reduce || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = (e.target as Element | null)?.closest?.(GLASS) as HTMLElement | null;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    };
    document.addEventListener("pointermove", onMove, { passive: true });

    const io = new IntersectionObserver(
      (es) => es.forEach((x) => x.isIntersecting && (x.target.classList.add("in"), io.unobserve(x.target))),
      { rootMargin: "0px 0px -8% 0px" },
    );
    const watch = () => document.querySelectorAll(".reveal:not(.in)").forEach((n) => io.observe(n));
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("pointermove", onMove);
      io.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="bg-fx" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

/** Animates a USDC amount string ("1,250.00") up from zero when it first appears or changes. */
export function CountUp({ value, decimals = 2 }: { value: string; decimals?: number }) {
  const target = Number(value.replace(/,/g, "")) || 0;
  const [shown, setShown] = useState(target);
  const from = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 1200);
      const e = 1 - Math.pow(1 - k, 4);
      setShown(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return <>{shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}
