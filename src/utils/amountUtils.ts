// XNA and asset amounts both have 8 decimals.
const BASE_UNITS_PER_COIN = 100000000;

export class AmountUtils {
  /**
   * Converts an RPC decimal amount (e.g. `vout[].value`) to integer base units. Rounds rather than floors:
   * `0.29 * 1e8` is `28999999.999999996` in floating point.
   */
  static toBaseUnits(value: number): number {
    return Math.round(value * BASE_UNITS_PER_COIN);
  }

  /** Formats integer base units as a decimal amount without trailing zeros, e.g. `29000000` -> `"0.29"`. */
  static format(baseUnits: number): string {
    return (baseUnits / BASE_UNITS_PER_COIN).toFixed(8).replace(/\.?0+$/, "");
  }
}
