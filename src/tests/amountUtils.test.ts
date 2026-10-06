import { describe, it, expect } from "vitest";
import { AmountUtils } from "../utils/amountUtils";

describe("AmountUtils", () => {
  describe("toBaseUnits", () => {
    it("should not lose a base unit to floating point error", () => {
      expect(AmountUtils.toBaseUnits(0.29)).toBe(29000000);
      expect(AmountUtils.toBaseUnits(1.15)).toBe(115000000);
      expect(AmountUtils.toBaseUnits(0.00000001)).toBe(1);
    });

    it("should convert whole amounts", () => {
      expect(AmountUtils.toBaseUnits(0)).toBe(0);
      expect(AmountUtils.toBaseUnits(50000)).toBe(5000000000000);
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
  });
});
