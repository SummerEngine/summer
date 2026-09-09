import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDINGS_ENCODING,
  buildEmbeddingText,
  cosineSimilarity,
  createEmbedProvider,
  decodeVector,
  encodeVector,
  parseEmbeddingsFile,
  reciprocalRankFusion,
} from "./embeddings.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vector encoding (base64 float32)", () => {
  it("round-trips at float32 precision", () => {
    const vector = [0.25, -1.5, 3.141592653589793, 1e-7, 0];
    const decoded = decodeVector(encodeVector(vector));
    expect(decoded.length).toBe(vector.length);
    for (let i = 0; i < vector.length; i++) expect(decoded[i]).toBeCloseTo(vector[i]!, 6);
  });

  it("is about 2x more compact than a rounded JSON number array for 384 dims", () => {
    const vector = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.1);
    const b64 = encodeVector(vector).length;
    const rounded = JSON.stringify(vector.map((x) => Math.round(x * 1e6) / 1e6)).length;
    expect(b64).toBe(2048);
    expect(rounded / b64).toBeGreaterThan(1.5);
  });

  it("rejects a byte length that is not a multiple of 4", () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(/multiple of 4/);
  });
});

describe("vector math", () => {
  it("cosine: identical = 1, orthogonal = 0, zero or mismatched = 0", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 9);
  });

  it("reciprocal rank fusion sums 1/(k+rank) across lists and breaks ties on id", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "d"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    // a (rank 1 in list 1) and d (rank 2 in list 2) share nothing; a wins on 1/61 > 1/62.
    expect(fused[1]!.score).toBeCloseTo(1 / 61, 12);
    // Ties: same rank in different lists -> id order.
    const tie = reciprocalRankFusion([["z"], ["y"]]);
    expect(tie.map((f) => f.id)).toEqual(["y", "z"]);
  });
});

describe("buildEmbeddingText", () => {
  it("joins summary, use_when lines and facet tokens; ignores non-strings", () => {
    const text = buildEmbeddingText({
      summary: "  Water ripples  ",
      use_when: ["splash ripples", 42, "footsteps in a puddle"],
      facets: { lifecycle: ["build"], domains: ["vfx"], modalities: ["shaders"], junk: "ignored" },
    });
    expect(text).toBe("Water ripples\nsplash ripples\nfootsteps in a puddle\nbuild vfx shaders");
    expect(buildEmbeddingText({})).toBe("");
  });
});

describe("parseEmbeddingsFile", () => {
  it("accepts the documented shape and defaults the model", () => {
    const parsed = parseEmbeddingsFile({
      dims: 2,
      encoding: EMBEDDINGS_ENCODING,
      entries: { "skill/a": { content_hash: "abc", vector: encodeVector([1, 0]) }, bad: { vector: 3 } },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.model).toBe("unknown");
    expect(Object.keys(parsed!.entries)).toEqual(["skill/a"]);
  });

  it("returns null for another encoding, bad dims, or no entries object", () => {
    expect(parseEmbeddingsFile({ dims: 2, encoding: "json", entries: {} })).toBeNull();
    expect(parseEmbeddingsFile({ dims: 0, encoding: EMBEDDINGS_ENCODING, entries: {} })).toBeNull();
    expect(parseEmbeddingsFile({ dims: 2, encoding: EMBEDDINGS_ENCODING, entries: [] })).toBeNull();
    expect(parseEmbeddingsFile(null)).toBeNull();
    expect(parseEmbeddingsFile("nope")).toBeNull();
  });
});

describe("createEmbedProvider", () => {
  it("POSTs {text} with the account token and returns vector + model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ vector: [0.1, 0.2], model: "m1" }), { status: 200 })
    );
    const provider = createEmbedProvider({ url: "https://example.test/embed", token: "tok-1", timeoutMs: 500, fetchImpl: fetchMock as never });
    const result = await provider("hello");
    expect(result).toEqual({ vector: [0.1, 0.2], model: "m1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/embed");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends no Authorization header without a token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vector: [1] }), { status: 200 }));
    await createEmbedProvider({ url: "https://example.test/embed", timeoutMs: 500, fetchImpl: fetchMock as never })("x");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("throws on non-2xx and on a body without a numeric vector", async () => {
    const bad = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(createEmbedProvider({ url: "https://x", timeoutMs: 500, fetchImpl: bad as never })("q")).rejects.toThrow(/503/);
    const empty = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vector: [] }), { status: 200 }));
    await expect(createEmbedProvider({ url: "https://x", timeoutMs: 500, fetchImpl: empty as never })("q")).rejects.toThrow(/no numeric vector/);
    const nan = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vector: ["a"] }), { status: 200 }));
    await expect(createEmbedProvider({ url: "https://x", timeoutMs: 500, fetchImpl: nan as never })("q")).rejects.toThrow(/no numeric vector/);
  });

  it("aborts after timeoutMs", async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const started = Date.now();
    await expect(createEmbedProvider({ url: "https://x", timeoutMs: 30, fetchImpl: hanging as never })("q")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
