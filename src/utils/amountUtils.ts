// XNA and asset amounts both have 8 decimals.
const DECIMALS = 8;
const BASE_UNITS_PER_COIN = BigInt(100000000);
const MAX_JSON_NUMBER = BigInt(Number.MAX_SAFE_INTEGER);
// Decimal text as the node writes it, or as JavaScript prints a number (e.g. `1e-7`).
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,3}))?$/i;

export class AmountUtils {
  /**
   * Converts an RPC decimal amount (`vout[].value`, an asset `amount`) to exact integer base units. The RPC client returns
   * a number only when it carries the node's digits exactly, and the decimal text otherwise, so this parses the text
   * instead of multiplying: `0.29 * 1e8` is `28999999.999999996` in floating point.
   */
  static toBaseUnits(value: number | string): bigint {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    const match = typeof text === "string" ? DECIMAL.exec(text) : null;
    if (!match) throw new Error(`Invalid RPC amount: ${String(value)}`);
    const fraction = match[2] ?? "";
    const scale = DECIMALS - fraction.length + Number(match[3] ?? 0);
    const digits = BigInt(match[1] + fraction);
    if (scale >= 0) return digits * BigInt(10) ** BigInt(scale);
    const divisor = BigInt(10) ** BigInt(-scale);
    if (digits % divisor !== BigInt(0)) throw new Error(`RPC amount has more than ${DECIMALS} decimals: ${text}`);
    return digits / divisor;
  }

  /**
   * Formats integer base units as a decimal amount without trailing zeros, e.g. `29000000` -> `"0.29"`. Accepts the JSON
   * forms of `toJson` too: a safe integer or a string of digits.
   */
  static format(baseUnits: bigint | number | string): string {
    const value = BigInt(baseUnits);
    const sign = value < BigInt(0) ? "-" : "";
    const magnitude = value < BigInt(0) ? -value : value;
    const whole = magnitude / BASE_UNITS_PER_COIN;
    const fraction = (magnitude % BASE_UNITS_PER_COIN).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
    return sign + whole.toString() + (fraction ? "." + fraction : "");
  }

  /** JSON form of base units: a number while JavaScript holds it exactly, its decimal text beyond 2^53 - 1. */
  static toJson(baseUnits: bigint): number | string {
    return baseUnits <= MAX_JSON_NUMBER && baseUnits >= -MAX_JSON_NUMBER ? Number(baseUnits) : baseUnits.toString();
  }
}
