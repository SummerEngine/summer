import { describe, expect, it } from "vitest";
import { checkStoreSignIn } from "./doctor.js";

describe("doctor store check", () => {
  it("is ok and quiet without a store sign-in, and never calls the store", async () => {
    const check = await checkStoreSignIn(async () => {
      throw new Error("must not call the store");
    }, async () => false);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("summer login --store");
  });

  it("warns with the platform reason when the store refuses the sign-in", async () => {
    const check = await checkStoreSignIn(
      async () => ({ status: "refused", code: "not_signed_in", message: "Summer Games does not accept AI-tool sign-in yet.", requestId: "r1" }),
      async () => true
    );
    expect(check).toMatchObject({ id: "store-access", status: "warning" });
    expect(check.message).toContain("not_signed_in");
    expect(check.message).toContain("does not accept AI-tool sign-in yet");
    expect(check.message).toContain("r1");
  });

  it("is ok when the store lists the games", async () => {
    const check = await checkStoreSignIn(async () => ({ status: "ok", games: 3 }), async () => true);
    expect(check).toMatchObject({ status: "ok", message: "the store accepts this sign-in (3 games)" });
  });
});
