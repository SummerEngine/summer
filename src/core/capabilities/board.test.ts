import { describe, expect, it } from "vitest";
import { boardArgsSchema, boardContent, boardQuery } from "./board.js";

describe("summer_get_board", () => {
  it("asks for the pictures unless told not to", () => {
    expect(boardQuery({ project: "p1" }).toString()).toBe("project=p1&images=1");
    expect(boardQuery({ project: "p1", pictures: false }).toString()).toBe("project=p1");
    expect(boardArgsSchema.safeParse({}).success).toBe(false);
  });

  it("returns the board as text and each picture as a label and an image the model can see", () => {
    const content = boardContent({
      project: "p1",
      version: "abc",
      look: { name: "Flat colour", description: "Palette: sky #8ecae6" },
      pictures: [
        { label: "The look: Flat colour", dataUrl: "data:image/jpeg;base64,QUJD" },
        { label: "Not a picture", dataUrl: "https://example.com/x.png" },
      ],
    });
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("text");
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('"version": "abc"');
    expect(text).not.toContain('"pictures"');
    expect(text).toContain("Compare your latest screenshot");
    expect(content[1]).toEqual({ type: "text", text: "The look: Flat colour" });
    expect(content[2]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
  });

  it("still returns the board when no picture loaded", () => {
    const content = boardContent({ project: "p1" });
    expect(content).toHaveLength(1);
    expect((content[0] as { text: string }).text).toContain("use the descriptions");
  });
});
