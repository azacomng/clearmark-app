// Small stroke icons (24px grid, currentColor) used by the shell, KPIs and landing page.
type P = { className?: string };
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconInvoices = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M6 3h9l4 4v14l-2.5-1.5L14 21l-2.5-1.5L9 21l-2.5-1.5L4 21V5a2 2 0 0 1 2-2Z" /><path d="M8 9h7M8 13h7M8 17h4" /></svg>
);
export const IconReview = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8.5 11l1.8 1.8L13.8 9" /></svg>
);
export const IconHistory = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" /><path d="M3.5 3.5v5h5M12 7.5V12l3 2" /></svg>
);
export const IconShield = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2 2 4-4" /></svg>
);
export const IconBooks = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5v-13ZM10 4h8.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10" /><path d="M13 8.5h4M13 12h4M13 15.5h2.5" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);
export const IconWallet = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M16 13.5h.01" /></svg>
);
export const IconBolt = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IconInbox = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M4 13.5 6.5 5h11l2.5 8.5V19H4v-5.5Z" /><path d="M4 13.5h4.5l1.5 2h4l1.5-2H20" /></svg>
);
export const IconReceipt = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="M9 11.5h6M9 14.5h4" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
);
export const IconLogout = (p: P) => (
  <svg {...base} {...p} aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" /></svg>
);
