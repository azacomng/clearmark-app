import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { signInMessage } from "@/lib/auth";
import { ARC_TESTNET_CHAIN_ID } from "@/lib/arc";

const A = "0x4f2c000000000000000000000000000000091ae0";
const at = new Date("2026-10-04T09:00:00Z");

describe("Sign-In with Ethereum message", () => {
  const msg = signInMessage(A, "abc123def456abc123def456", "https://clearmark-jade.vercel.app", at);
  const f = parseSiweMessage(msg);

  it("uses the standard EIP-4361 format bound to the site's own domain", () => {
    expect(msg.startsWith("clearmark-jade.vercel.app wants you to sign in with your Ethereum account:")).toBe(true);
    expect(f.domain).toBe("clearmark-jade.vercel.app");
    expect(f.uri).toBe("https://clearmark-jade.vercel.app");
    expect(f.chainId).toBe(ARC_TESTNET_CHAIN_ID);
    expect(f.expirationTime?.getTime()).toBe(at.getTime() + 10 * 60_000);
  });

  it("is rejected for any other domain", () => {
    const ok = (domain: string) => validateSiweMessage({ message: f, address: A, domain, nonce: f.nonce, time: at });
    expect(ok("clearmark-jade.vercel.app")).toBe(true);
    expect(ok("evil.example")).toBe(false);
  });
});
