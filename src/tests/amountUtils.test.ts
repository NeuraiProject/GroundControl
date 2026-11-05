import { describe, it, expect } from "vitest";
import { AmountUtils } from "../utils/amountUtils";

describe("AmountUtils", () => {
  describe("toBaseUnits", () => {
    it("should not lose a base unit to floating point error", () => {
      expect(AmountUtils.toBaseUnits(0.29)).toBe(29000000n);
      expect(AmountUtils.toBaseUnits(1.15)).toBe(115000000n);
      expect(AmountUtils.toBaseUnits(0.00000001)).toBe(1n);
      expect(AmountUtils.toBaseUnits(8999.86985)).toBe(899986985000n);
    });

    it("should convert whole amounts", () => {
      expect(AmountUtils.toBaseUnits(0)).toBe(0n);
      expect(AmountUtils.toBaseUnits(50000)).toBe(5000000000000n);
    });

    it("should keep every digit of amounts that no JavaScript number holds", () => {
      // The RPC client returns these as the node's decimal text.
      expect(AmountUtils.toBaseUnits("1000000000.12345678")).toBe(100000000012345678n);
      expect(AmountUtils.toBaseUnits("21000000000.00000000")).toBe(2100000000000000000n);
      expect(AmountUtils.toBaseUnits("90071992.54740993")).toBe(9007199254740993n);
    });

    it("should read the exponent form JavaScript prints for small numbers", () => {
      expect(AmountUtils.toBaseUnits(1e-7)).toBe(10n);
      expect(AmountUtils.toBaseUnits("1e-8")).toBe(1n);
    });

    it("should refuse what is not an amount of at most 8 decimals", () => {
      for (const bad of ["0.000000001", "-1", "", "0x10", "1e-9", NaN, Infinity]) {
        expect(() => AmountUtils.toBaseUnits(bad as any)).toThrow();
      }
    });
  });

  describe("format", () => {
    it("should strip trailing zeros", () => {
      expect(AmountUtils.format(29000000)).toBe("0.29");
      expect(AmountUtils.format(100000)).toBe("0.001");
      expect(AmountUtils.format(1)).toBe("0.00000001");
    });

    it("should keep zeros of the integer part", () => {
      expect(AmountUtils.format(100000000000)).toBe("1000");
      expect(AmountUtils.format(0)).toBe("0");
    });

    it("should format bigint and digit strings exactly", () => {
      expect(AmountUtils.format(100000000012345678n)).toBe("1000000000.12345678");
      expect(AmountUtils.format("9007199254740993")).toBe("90071992.54740993");
    });
  });

  describe("toJson", () => {
    it("should stay a number while it is exact and become text beyond 2^53 - 1", () => {
      expect(AmountUtils.toJson(29000000n)).toBe(29000000);
      expect(AmountUtils.toJson(9007199254740991n)).toBe(9007199254740991);
      expect(AmountUtils.toJson(9007199254740992n)).toBe("9007199254740992");
      expect(AmountUtils.toJson(100000000012345678n)).toBe("100000000012345678");
    });
  });
});
