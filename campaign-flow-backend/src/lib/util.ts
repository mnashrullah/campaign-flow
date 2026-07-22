export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split an array into fixed-size chunks. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Probability helper — true with probability p (0..1). */
export const roll = (p: number) => p > 0 && Math.random() < p;
