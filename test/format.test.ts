import { expect, it } from "vitest";
import { fixed } from "../src/core/analyze/format";

it("fixed() rounds values below 0.1 like Python's %-format", () => {
  expect(fixed(0.0345)).toBe("0");
  expect(fixed(0.0345, 1)).toBe("0.0");
  expect(fixed(0.0345, 2)).toBe("0.03");
  expect(fixed(0.05, 1)).toBe("0.1");
  expect(fixed(-0.004, 2)).toBe("-0.00");
  expect(fixed(5e-324, 3)).toBe("0.000");
  expect(fixed(0.5)).toBe("0");
  expect(fixed(2.5)).toBe("2");
  expect(fixed(1234.5678, 2)).toBe("1234.57");
});
