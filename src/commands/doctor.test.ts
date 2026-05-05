import { describe, expect, it } from "vitest";
import type { DoctorCheck } from "./doctor.js";

function summarize(checks: DoctorCheck[]) {
  return {
    ok: checks.filter((c) => c.status === "ok").length,
    warnings: checks.filter((c) => c.status === "warning").length,
    failures: checks.filter((c) => c.status === "fail").length,
  };
}

describe("doctor summarization", () => {
  it("counts mixed statuses", () => {
    const summary = summarize([
      { id: "a", label: "A", status: "ok", message: "" },
      { id: "b", label: "B", status: "warning", message: "" },
      { id: "c", label: "C", status: "fail", message: "" },
      { id: "d", label: "D", status: "ok", message: "" },
    ]);
    expect(summary).toEqual({ ok: 2, warnings: 1, failures: 1 });
  });

  it("counts an all-ok run", () => {
    const summary = summarize([
      { id: "a", label: "A", status: "ok", message: "" },
      { id: "b", label: "B", status: "ok", message: "" },
    ]);
    expect(summary).toEqual({ ok: 2, warnings: 0, failures: 0 });
  });

  it("counts an empty check list", () => {
    expect(summarize([])).toEqual({ ok: 0, warnings: 0, failures: 0 });
  });
});
