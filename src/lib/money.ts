// USDC amounts are kept as bigint "units" with 6 decimals (the ERC-20 interface on Arc).
// They are stored as decimal strings so the JSON store never loses precision.

export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

export type Units = string;

export function toUnits(input: string | number): bigint {
  const s = String(input).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid USDC amount: ${input}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) throw new Error(`USDC has at most ${USDC_DECIMALS} decimals`);
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

export function fmt(units: bigint | Units, opts: { min?: number } = {}): string {
  const v = typeof units === "bigint" ? units : BigInt(units);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const min = opts.min ?? 2;
  if (frac.length < min) frac = frac.padEnd(min, "0");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${frac ? "." + frac : ""}`;
}

export const big = (u: Units | bigint) => (typeof u === "bigint" ? u : BigInt(u));
export const str = (b: bigint): Units => b.toString();
export const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
export const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
