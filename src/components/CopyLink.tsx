"use client";

import { useState } from "react";

export function CopyLink() {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        navigator.clipboard?.writeText(window.location.href);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Link copied" : "Copy proof link"}
    </button>
  );
}
