/**
 * Frame-quality probe for engine screenshots (tool/screenshot).
 *
 * WHY THIS EXISTS. In the 2026-09-03 end-to-end run,
 * `summer_screenshot target:"viewport"` returned an entirely black
 * 1072x1280 JPEG (src/core/capabilities/__fixtures__/frames/01-mcp-viewport-black.jpg)
 * with a caption
 * telling the agent to describe what it saw. It was the first viewport capture
 * after scene mutations had flipped the editor from the 3D to the 2D tab; the
 * same call 67 s later returned real content. Engine side, the ViewportSnapshot
 * op reads the
 * editor SubViewport's texture with get_texture()->get_image() AS-IS — no forced
 * RenderingServer draw and no blank-frame retry, both of which ScenePreview has
 * because a not-yet-drawn
 * texture reads back black. That is consistent with a 2D subviewport that had
 * not been redrawn since the tab switch, but it has NOT been proven by
 * instrumenting the engine, so this module detects the SYMPTOM (a flat frame)
 * instead of asserting a cause.
 *
 * The engine encodes snapshots as interleaved baseline JPEG. Each 8×8
 * block's DC coefficient gives its mean. Its AC coefficients describe
 * variation around that mean, including detail repeated in every block.
 * We walk the entropy stream once and bound the possible sample range from
 * the dequantized coefficients, without an IDCT, upsampling or RGB conversion.
 *
 * Progressive/lossless/12-bit JPEGs (which the engine never writes) and
 * anything that fails to parse come back `analyzable: false` — never a throw,
 * and never a verdict.
 */

export interface FrameQuality {
  /** False when the bytes are not a baseline JPEG this probe can walk. */
  analyzable: boolean;
  /** Why the frame could not be analysed (only when !analyzable). */
  reason?: string;
  width?: number;
  height?: number;
  /** Number of luma (first component) blocks decoded. */
  lumaBlocks?: number;
  /** Mean of the decoded luma block means, including edge padding, 0..255. */
  meanLuma?: number;
  /** max - min of the luma block means, 0..255. 0 = the block means are equal. */
  lumaSpread?: number;
  /** Largest max - min over the chroma components' block means (0 for greyscale). */
  chromaSpread?: number;
  /** Each component has constant DC and zero AC throughout the scan. */
  uniform: boolean;
  /** The encoded range of every component is bounded by FLAT_SPREAD_MAX. */
  flat: boolean;
  /** Coarse tone of a flat frame, for the caption. */
  tone?: "black" | "white" | "grey" | "color";
}

/** Maximum certified component range in 8-bit samples for a near-flat frame. */
export const FLAT_SPREAD_MAX = 4;

const BLACK_LUMA_MAX = 24;
const WHITE_LUMA_MIN = 232;
/** Chroma this close to the 128 neutral point reads as achromatic. */
const NEUTRAL_CHROMA_TOLERANCE = 12;

const NOT_ANALYZABLE = (reason: string): FrameQuality => ({
  analyzable: false,
  reason,
  uniform: false,
  flat: false,
});

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  dcTable?: HuffmanTable;
  acTable?: HuffmanTable;
  pred: number;
  // DC statistics (quantised coefficient units)
  blocks: number;
  first: number;
  allSame: boolean;
  min: number;
  max: number;
  sum: number;
  maxAcSpan: number; // Largest upper bound on a block’s internal sample range.
}

interface HuffmanTable {
  /** F.2.2.3 decode tables, indexed by code length 1..16. */
  maxcode: Int32Array;
  mincode: Int32Array;
  valptr: Int32Array;
  huffval: Uint8Array;
}

function buildHuffmanTable(bits: Uint8Array, huffval: Uint8Array): HuffmanTable {
  // C.2: HUFFSIZE / HUFFCODE generation, folded into the F.2.2.3 tables.
  const maxcode = new Int32Array(18).fill(-1);
  const mincode = new Int32Array(18);
  const valptr = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len - 1];
    if (count === 0) {
      maxcode[len] = -1;
    } else {
      valptr[len] = k;
      mincode[len] = code;
      code += count;
      k += count;
      maxcode[len] = code - 1;
    }
    code <<= 1;
  }
  return { maxcode, mincode, valptr, huffval };
}

class ScanReader {
  private readonly data: Uint8Array;
  private pos: number;
  private bitBuf = 0;
  private bitCount = 0;
  /** Set when the reader ran into a marker inside the entropy-coded data. */
  markerHit: number | null = null;

  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.pos = start;
  }

  private fill(): void {
    while (this.bitCount <= 24) {
      let byte = 0;
      if (this.markerHit === null && this.pos < this.data.length) {
        byte = this.data[this.pos];
        if (byte === 0xff) {
          const next = this.data[this.pos + 1];
          if (next === 0x00) {
            this.pos += 2; // stuffed 0xFF data byte
          } else if (next === 0xff) {
            this.pos += 1; // fill byte, re-examine
            continue;
          } else {
            this.markerHit = next; // RSTn / EOI / anything else: stop here
            byte = 0;
          }
        } else {
          this.pos += 1;
        }
      }
      // Past a marker or the end: feed zeros. A well-formed scan never reads
      // them; a corrupt one terminates through the k>63 / bad-code guards.
      this.bitBuf = (this.bitBuf << 8) | byte;
      this.bitCount += 8;
    }
  }

  readBit(): number {
    if (this.bitCount === 0) this.fill();
    this.bitCount -= 1;
    return (this.bitBuf >>> this.bitCount) & 1;
  }

  receive(n: number): number {
    if (n === 0) return 0;
    if (this.bitCount < n) this.fill();
    this.bitCount -= n;
    return (this.bitBuf >>> this.bitCount) & ((1 << n) - 1);
  }

  decode(table: HuffmanTable): number {
    let code = this.readBit();
    let len = 1;
    while (len <= 16 && code > table.maxcode[len]) {
      code = (code << 1) | this.readBit();
      len += 1;
    }
    if (len > 16) throw new Error("bad huffman code");
    return table.huffval[table.valptr[len] + code - table.mincode[len]];
  }

  /** Byte-align and consume the RSTn marker expected at a restart boundary. */
  restart(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
    if (this.markerHit !== null) {
      if (this.markerHit < 0xd0 || this.markerHit > 0xd7) {
        throw new Error(`expected RSTn at restart boundary, saw 0xFF${this.markerHit.toString(16)}`);
      }
      this.pos += 2;
      this.markerHit = null;
      return;
    }
    // Marker not yet reached by the bit reader: it must be the next bytes.
    if (this.data[this.pos] === 0xff && this.data[this.pos + 1] >= 0xd0 && this.data[this.pos + 1] <= 0xd7) {
      this.pos += 2;
      return;
    }
    throw new Error("restart interval ended without an RSTn marker");
  }
}

function extend(value: number, bits: number): number {
  return value < 1 << (bits - 1) ? value - (1 << bits) + 1 : value;
}

function decodeBlock(reader: ScanReader, comp: Component, quant: Uint16Array): void {
  const t = reader.decode(comp.dcTable!);
  const diff = t === 0 ? 0 : extend(reader.receive(t), t);
  comp.pred += diff;
  const dc = comp.pred;
  if (comp.blocks === 0) {
    comp.first = dc;
    comp.min = dc;
    comp.max = dc;
  } else {
    if (dc !== comp.first) comp.allSame = false;
    if (dc < comp.min) comp.min = dc;
    if (dc > comp.max) comp.max = dc;
  }
  comp.blocks += 1;
  comp.sum += dc;

  // Each non-DC term in the inverse DCT contributes at most |coefficient|/4
  // from the block mean. Twice that bounds the span. Quantization entries
  // and entropy coefficients use the same zigzag order.
  let acSpan = 0;
  let k = 1;
  while (k < 64) {
    const rs = reader.decode(comp.acTable!);
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r === 15) {
        k += 16;
        continue;
      }
      break; // EOB
    }
    k += r;
    if (k > 63) throw new Error("AC run past block end");
    const amplitude = reader.receive(s);
    if (comp.maxAcSpan <= FLAT_SPREAD_MAX) {
      acSpan += Math.abs(extend(amplitude, s)) * quant[k] / 2;
    }
    k += 1;
  }
  comp.maxAcSpan = Math.max(comp.maxAcSpan, acSpan);
}

/**
 * Analyse a JPEG frame without decoding pixels. Never throws.
 */
export function analyzeJpegFrame(bytes: Uint8Array): FrameQuality {
  try {
    return analyze(bytes);
  } catch (err) {
    return NOT_ANALYZABLE(err instanceof Error ? err.message : String(err));
  }
}

function analyze(data: Uint8Array): FrameQuality {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return NOT_ANALYZABLE("not a JPEG (missing SOI marker)");
  }
  const quant: Array<Uint16Array | undefined> = [];
  const dcTables: Array<HuffmanTable | undefined> = [];
  const acTables: Array<HuffmanTable | undefined> = [];
  let components: Component[] = [];
  let width = 0;
  let height = 0;
  let restartInterval = 0;
  let pos = 2;

  const u16 = (at: number): number => (data[at] << 8) | data[at + 1];

  while (pos < data.length) {
    if (data[pos] !== 0xff) return NOT_ANALYZABLE(`marker desync at byte ${pos}`);
    let marker = data[pos + 1];
    while (marker === 0xff) {
      pos += 1;
      marker = data[pos + 1];
    }
    pos += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) return NOT_ANALYZABLE("reached EOI before a scan");
    if (pos + 2 > data.length) return NOT_ANALYZABLE("truncated segment header");
    const len = u16(pos);
    const segEnd = pos + len;
    if (len < 2 || segEnd > data.length) return NOT_ANALYZABLE("truncated segment");
    const body = pos + 2;

    if (marker === 0xdb) {
      // DQT
      let p = body;
      while (p < segEnd) {
        const pq = data[p] >> 4;
        const tq = data[p] & 15;
        p += 1;
        const table = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          if (pq === 0) {
            table[i] = data[p];
            p += 1;
          } else {
            table[i] = u16(p);
            p += 2;
          }
        }
        quant[tq] = table;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      // SOF0 baseline / SOF1 extended sequential (Huffman)
      const precision = data[body];
      if (precision !== 8) return NOT_ANALYZABLE(`${precision}-bit JPEG not supported`);
      height = u16(body + 1);
      width = u16(body + 3);
      const nf = data[body + 5];
      if (nf < 1 || nf > 4) return NOT_ANALYZABLE(`unsupported component count ${nf}`);
      components = [];
      for (let i = 0; i < nf; i++) {
        const at = body + 6 + i * 3;
        components.push({
          id: data[at],
          h: data[at + 1] >> 4,
          v: data[at + 1] & 15,
          tq: data[at + 2],
          pred: 0,
          blocks: 0,
          first: 0,
          allSame: true,
          min: 0,
          max: 0,
          sum: 0,
          maxAcSpan: 0,
        });
      }
    } else if (marker === 0xc2) {
      return NOT_ANALYZABLE("progressive JPEG not supported");
    } else if ((marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      return NOT_ANALYZABLE(`unsupported JPEG process (SOF${(marker - 0xc0).toString(16)})`);
    } else if (marker === 0xc4) {
      // DHT
      let p = body;
      while (p < segEnd) {
        const tc = data[p] >> 4;
        const th = data[p] & 15;
        p += 1;
        const bits = data.subarray(p, p + 16);
        p += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += bits[i];
        const huffval = data.subarray(p, p + total);
        p += total;
        const table = buildHuffmanTable(bits, huffval);
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (marker === 0xdd) {
      restartInterval = u16(body);
    } else if (marker === 0xda) {
      // SOS — the scan follows the header.
      if (components.length === 0) return NOT_ANALYZABLE("SOS before SOF");
      const ns = data[body];
      if (ns !== components.length) {
        return NOT_ANALYZABLE("non-interleaved scan not supported");
      }
      const scanComps: Component[] = [];
      for (let i = 0; i < ns; i++) {
        const cs = data[body + 1 + i * 2];
        const tables = data[body + 2 + i * 2];
        const comp = components.find((c) => c.id === cs);
        if (!comp) return NOT_ANALYZABLE(`scan references unknown component ${cs}`);
        comp.dcTable = dcTables[tables >> 4];
        comp.acTable = acTables[tables & 15];
        if (!comp.dcTable || !comp.acTable) return NOT_ANALYZABLE("scan references a missing Huffman table");
        if (!quant[comp.tq]) return NOT_ANALYZABLE("component references a missing quantisation table");
        scanComps.push(comp);
      }
      return decodeScan(data, segEnd, scanComps, width, height, restartInterval, quant);
    }
    // APPn, COM, DNL, anything else: skipped.
    pos = segEnd;
  }
  return NOT_ANALYZABLE("no scan found");
}

function decodeScan(
  data: Uint8Array,
  scanStart: number,
  comps: Component[],
  width: number,
  height: number,
  restartInterval: number,
  quant: Array<Uint16Array | undefined>
): FrameQuality {
  if (width === 0 || height === 0) return NOT_ANALYZABLE("zero-sized frame");
  const reader = new ScanReader(data, scanStart);

  let mcusX: number;
  let mcusY: number;
  let blocksPerMcu: (c: Component) => number;
  if (comps.length === 1) {
    // Non-interleaved single component: one block per MCU, sampling ignored.
    mcusX = Math.ceil(width / 8);
    mcusY = Math.ceil(height / 8);
    blocksPerMcu = () => 1;
  } else {
    let hmax = 1;
    let vmax = 1;
    for (const c of comps) {
      if (c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4) return NOT_ANALYZABLE("bad sampling factors");
      hmax = Math.max(hmax, c.h);
      vmax = Math.max(vmax, c.v);
    }
    mcusX = Math.ceil(width / (8 * hmax));
    mcusY = Math.ceil(height / (8 * vmax));
    blocksPerMcu = (c) => c.h * c.v;
  }

  const totalMcus = mcusX * mcusY;
  for (let m = 0; m < totalMcus; m++) {
    if (restartInterval > 0 && m > 0 && m % restartInterval === 0) {
      reader.restart();
      for (const c of comps) c.pred = 0;
    }
    for (const c of comps) {
      const n = blocksPerMcu(c);
      for (let b = 0; b < n; b++) decodeBlock(reader, c, quant[c.tq]!);
    }
  }

  // DC -> block mean for 8-bit samples: mean = dc * Q[0] / 8 + 128.
  const toMean = (c: Component, dc: number): number => {
    const q0 = quant[c.tq]![0];
    return Math.min(255, Math.max(0, (dc * q0) / 8 + 128));
  };
  const luma = comps[0];
  const lumaMean = toMean(luma, luma.sum / luma.blocks);
  const lumaSpread = toMean(luma, luma.max) - toMean(luma, luma.min);
  let chromaSpread = 0;
  let chromaOffset = 0;
  for (const c of comps.slice(1)) {
    chromaSpread = Math.max(chromaSpread, toMean(c, c.max) - toMean(c, c.min));
    chromaOffset = Math.max(chromaOffset, Math.abs(toMean(c, c.sum / c.blocks) - 128));
  }
  // Including padded edge samples is conservative: their variation can keep
  // a cropped frame from being called flat, but cannot hide visible detail.
  const uniform = comps.every((c) => c.allSame && c.maxAcSpan === 0);
  const flat = comps.every((c) => toMean(c, c.max) - toMean(c, c.min) + c.maxAcSpan <= FLAT_SPREAD_MAX);

  let tone: FrameQuality["tone"];
  if (flat) {
    if (chromaOffset > NEUTRAL_CHROMA_TOLERANCE) tone = "color";
    else if (lumaMean <= BLACK_LUMA_MAX) tone = "black";
    else if (lumaMean >= WHITE_LUMA_MIN) tone = "white";
    else tone = "grey";
  }

  return {
    analyzable: true,
    width,
    height,
    lumaBlocks: luma.blocks,
    meanLuma: round1(lumaMean),
    lumaSpread: round1(lumaSpread),
    chromaSpread: round1(chromaSpread),
    uniform,
    flat,
    tone,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Analyse a base64-encoded frame; non-JPEG mime types are not analysable. */
export function analyzeFrameBase64(base64: string, mime?: string): FrameQuality {
  if (mime && !/jpe?g/i.test(mime)) {
    return NOT_ANALYZABLE(`content check only supports JPEG frames (got ${mime})`);
  }
  return analyzeJpegFrame(Buffer.from(base64, "base64"));
}

/** One clause for a caption, e.g. "uniformly black (mean luma 0/255)". */
export function describeFlatFrame(q: FrameQuality): string {
  const how = q.uniform ? "uniformly" : "almost uniformly";
  const appearance = q.tone === "color" ? (q.uniform ? "a solid colour" : "nearly a solid colour") : `${how} ${q.tone ?? "flat"}`;
  return `${appearance} (mean luma ${Math.round(q.meanLuma ?? 0)}/255)`;
}
