import { describe, it, expect } from "vitest";
import { evaluateNumericExpression, inspectArithmeticText, inspectArtifactArithmetic } from "./arithmetic.js";

describe("bounded numeric contradictions, not unrestricted financial verification", () => {
  it("computes precedence, nested parentheses, signs, percentages and decimal arithmetic without eval", () => {
    for (const [text, value] of [["(1200−900)/1200", 0.25], ["100−30×12", -260], ["0.1+0.2", 0.3], ["−(-2+3)*4", -4], ["25%*300", 75]] as const) {
      const out = evaluateNumericExpression(text);
      expect(out.status, text).toBe("checked");
      if (out.status === "checked") expect(out.quantity.value, text).toBeCloseTo(value, 10);
    }
  });
  it("checks known units and conversions instead of stripping units and inventing equivalence", () => {
    for (const text of ["12万元−8万元=4万元", "3000元/人天×12人天=3.6万元", "48小时=2天", "1,200元-900元=300元"]) {
      const checks = inspectArithmeticText(text);
      expect(checks.length, text).toBeGreaterThan(0);
      expect(checks.every((item) => item.status === "checked"), text).toBe(true);
    }
    expect(inspectArithmeticText("12万元−8万元=4元")[0]!.status).toBe("mismatch");
    expect(inspectArithmeticText("5天=5元")[0]!.status).toBe("unsupported");
    expect(inspectArithmeticText("12人天×3000元=3.6万元")[0]).toMatchObject({ status: "unsupported", reason: "UNIT_CONTEXT_REQUIRES_REVIEW" });
    expect(evaluateNumericExpression("5天+2元")).toMatchObject({ status: "invalid", reason: "INCOMPATIBLE_UNITS" });
  });
  it("rejects the actual wrong percentage derivation and other explicit numeric contradictions", () => {
    for (const text of ["假设毛利率75%（(1200−900)/1200）", "(1200-900)/1200=75%", "12-8=5", "8÷20=50%", "100-360=-160"]) {
      expect(inspectArithmeticText(text).some((item) => item.status === "mismatch"), text).toBe(true);
    }
  });
  it("accepts correctly rounded displays but rejects discrepancies outside the displayed precision", () => {
    for (const text of ["1÷3=33.3%", "返工相对增加166.7%（5÷3）", "(28-24)/28=14.3%", "300/1200=25%", "0.1+0.2=0.3"]) {
      expect(inspectArithmeticText(text).every((item) => item.status === "checked"), text).toBe(true);
    }
    expect(inspectArithmeticText("1÷3=33.1%")[0]!.status).toBe("mismatch");
  });
  it("fails closed for zero division, overflow and unit errors while bounding parser work", () => {
    expect(evaluateNumericExpression("1/0")).toMatchObject({ status: "invalid", reason: "DIVISION_BY_ZERO" });
    expect(inspectArithmeticText("1÷0=5")[0]!.status).toBe("invalid");
    expect(evaluateNumericExpression("1000000000000000*1000000000000000")).toMatchObject({ status: "invalid", reason: "NONFINITE_OR_OVERFLOW" });
    expect(evaluateNumericExpression("1+".repeat(300))).toMatchObject({ status: "unsupported", reason: "EXPRESSION_LENGTH" });
    expect(evaluateNumericExpression("(".repeat(20) + "1" + ")".repeat(20))).toMatchObject({ status: "unsupported", reason: "PARENTHESIS_DEPTH" });
  });
  it("never treats variables, functions, exponent notation, malformed grouping or unknown units as verified", () => {
    for (const text of ["revenue-cost", "process.exit(0)", "Math.max(1,2)", "2^3", "1e3", "3公斤+2公斤", "1,20+2", "(1+2", "2(3+4)"]) {
      expect(evaluateNumericExpression(text).status, text).toBe("unsupported");
    }
    expect(inspectArithmeticText("2^3=8").filter((item) => item.status === "mismatch")).toHaveLength(0);
    expect(inspectArithmeticText("Math.max(1,2)=2").filter((item) => item.status === "mismatch")).toHaveLength(0);
    // Chinese-labelled operands cannot be safely reconstructed from a suffix.
    expect(inspectArithmeticText("毛利=收入1200-成本900=300万元").filter((item) => item.status === "mismatch")).toHaveLength(0);
  });
  it("records unrecognized work honestly and does not reinterpret quoted source errors as generated findings", () => {
    const artifact = { summary: "本稿只复核来源，相关比率25%（待核实口径）仍未验证。",
      findings: [{ claim: "原文中的错误数字应退回，不作为结论。", evidence: [{ quote: "75%（(1200-900)/1200）" }] }],
      recommendations: [{ action: "补齐口径后交顾问复核。", verification: "由顾问核对原始账目与公式。" }] };
    const out = inspectArtifactArithmetic(artifact);
    expect(out.checkedCount).toBe(0); expect(out.unsupportedCount).toBeGreaterThan(0); expect(out.issues).toHaveLength(0);
    expect(out.disclosure).toContain("require human review");
  });
});
