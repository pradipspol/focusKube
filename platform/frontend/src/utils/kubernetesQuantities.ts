const NUMERIC_QUANTITY = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MEMORY_QUANTITY = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([KMGTE]i|[kMGTPE]|m)?$/;

const MEMORY_FACTORS: Record<string, number> = {
  '': 1,
  k: 1_000,
  M: 1_000_000,
  G: 1_000_000_000,
  T: 1_000_000_000_000,
  P: 1_000_000_000_000_000,
  E: 1_000_000_000_000_000_000,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  m: 0.001,
};

function finiteQuantity(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseCpuToMillicores(value?: string): number {
  if (!value) return 0;
  const suffix = value.at(-1);
  const numericValue = suffix === 'm' || suffix === 'u' || suffix === 'n' ? value.slice(0, -1) : value;
  if (!NUMERIC_QUANTITY.test(numericValue)) return 0;

  const quantity = finiteQuantity(numericValue);
  const millicoreFactor = suffix === 'm' ? 1 : suffix === 'u' ? 0.001 : suffix === 'n' ? 0.000001 : 1000;
  return quantity * millicoreFactor;
}

export function parseMemoryToBytes(value?: string): number {
  if (!value) return 0;
  const match = MEMORY_QUANTITY.exec(value);
  if (!match) return 0;
  return finiteQuantity(match[1]) * MEMORY_FACTORS[match[2] ?? ''];
}