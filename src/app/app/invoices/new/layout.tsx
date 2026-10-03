import type { Metadata } from "next";

export const metadata: Metadata = { title: "New invoice" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
