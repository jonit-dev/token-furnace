/**
 * Python's %-format. burn.py's message strings are the product, so the numbers inside them must
 * round the way Python rounds: the exact value of the double, ties to even.
 */

/**
 * The exact decimal expansion of a finite double, as digits with the decimal point `point`
 * digits from the left. A double is m * 2^e, and for e < 0 that is m * 5^(-e) / 10^(-e), so the
 * expansion terminates and BigInt holds it exactly.
 */
function exact(value: number): { digits: string; point: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponentField = Number((bits >> 52n) & 0x7ffn);
  if (exponentField === 0) return { digits: String(bits & ((1n << 52n) - 1n)), point: -1074 }; // subnormal or 0
  const m = (bits & ((1n << 52n) - 1n)) | (1n << 52n); // the implicit leading bit is always set
  const exponent = exponentField - 1023 - 52;
  const n = exponent >= 0 ? m << BigInt(exponent) : m * 5n ** BigInt(-exponent);
  const digits = n.toString();
  return { digits, point: exponent >= 0 ? digits.length : digits.length + exponent };
}

/** `%.<digits>f` of a finite double, rounded from its exact value with ties to even. */
export function fixed(value: number, digits = 0): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const sign = value < 0 ? "-" : "";
  const { digits: all, point } = exact(value);
  const text = all.padEnd(point + digits + 1, "0");

  const kept = text.slice(0, point + digits);
  const next = text[point + digits] ?? "0";
  const tail = text.slice(point + digits + 1).replace(/0+$/, "");

  let n = BigInt(kept === "" ? "0" : kept);
  if (next > "5" || (next === "5" && (tail !== "" || n % 2n !== 0n))) n += 1n;

  const body = n.toString().padStart(digits + 1, "0");
  return sign + (digits === 0 ? body : `${body.slice(0, -digits)}.${body.slice(-digits)}`);
}

/** `%d` on a float: Python truncates toward zero. */
export function int0(value: number): string {
  return String(Math.trunc(value));
}