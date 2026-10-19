/**
 * The one page `summer preview` serves. Self-contained: inline style and
 * script, no fonts, no CDN, no request leaves 127.0.0.1 (the server's
 * Content-Security-Policy enforces it), and no token anywhere (the server
 * holds the engine connection).
 *
 * Loop: fetch /api/frame, show it, wait the interval the server derived from
 * the measured capture time, repeat. Hidden tab = no requests. Each frame
 * response carries the status (x-summer-status) so one request a frame is all
 * the page makes. The first frame after the page loads or comes back into
 * view, and the Refresh button, ask for a fresh one (?fresh=1): game frames
 * are otherwise about 20 s apart, and the header says how old the frame is.
 * While the game runs, keys and clicks on the frame go to it; a key release is
 * always sent, so no key stays held in the game. A page framed inside another
 * page sends no input.
 *
 * For agents checking the page: <body data-state> is connecting, no_editor,
 * editor or game; #status holds the status line; #refresh fetches a fresh
 * frame; the page logs nothing to the console in normal operation, so a
 * console error is a real one.
 */
export const PREVIEW_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summer preview</title>
<style>
  :root { --cobalt: #0047ab; --ink: #111; --muted: #6b6b6b; --line: #e6e6e6; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #fff; color: var(--ink);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header, footer { display: flex; align-items: center; gap: 12px; padding: 8px 14px; min-height: 36px; }
  header { border-bottom: 1px solid var(--line); }
  footer { border-top: 1px solid var(--line); color: var(--muted); }
  .brand { color: var(--cobalt); font-weight: 700; }
  #project { font-weight: 600; }
  #scene { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  #source { color: #fff; background: var(--cobalt); border-radius: 4px; padding: 1px 8px; font-weight: 600; }
  #source:empty { display: none; }
  #rate { color: var(--muted); font-variant-numeric: tabular-nums; }
  #refresh { font: inherit; color: var(--cobalt); background: #fff; border: 1px solid var(--line); border-radius: 4px; padding: 1px 8px; cursor: pointer; }
  body[data-state="no_editor"] #refresh, body[data-state="connecting"] #refresh { display: none; }
  main { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; outline: none; }
  #frame { width: 100%; height: 100%; object-fit: contain; display: block; user-select: none; -webkit-user-drag: none; }
  body[data-state="game"] #frame { cursor: crosshair; }
  #empty { display: none; text-align: center; max-width: 520px; padding: 24px; }
  #empty h1 { font-size: 20px; margin: 0 0 8px; }
  #empty code { display: inline-block; margin-top: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 4px; color: var(--cobalt); }
  body[data-state="no_editor"] #frame, body[data-state="connecting"] #frame { display: none; }
  body[data-state="no_editor"] #empty, body[data-state="connecting"] #empty { display: block; }
  #status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body data-state="connecting">
<header>
  <span class="brand">Summer</span>
  <span id="project"></span>
  <span id="scene"></span>
  <span class="spacer"></span>
  <span id="source"></span>
  <span id="rate"></span>
  <button id="refresh" type="button" title="Capture a fresh frame now">Refresh</button>
</header>
<main id="stage" tabindex="0">
  <img id="frame" alt="Live frame from Summer Engine">
  <div id="empty">
    <h1 id="empty-title">Looking for Summer Engine</h1>
    <div id="empty-text"></div>
  </div>
</main>
<footer><span id="status">Looking for Summer Engine</span></footer>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $("frame");
  const stage = $("stage");
  const framed = window.top !== window.self;
  let status = null;
  let timer = null;
  let loop = 0;
  let lastUrl = null;
  let note = null;
  const shown = [];

  function render() {
    const s = status;
    if (!s) return;
    const message = typeof s.message === "string" ? s.message : "";
    document.body.dataset.state = s.state;
    document.body.dataset.source = s.frame ? s.frame.source : "";
    $("project").textContent = s.project || "";
    $("scene").textContent = s.scene || "";
    $("source").textContent = s.state === "game" ? "Game" : s.state === "editor" ? "Editor" : "";
    const now = Date.now();
    while (shown.length > 2 && now - shown[0] > 12000) shown.shift();
    const fps = shown.length > 1 ? (shown.length - 1) / ((shown[shown.length - 1] - shown[0]) / 1000) : 0;
    const rate = [];
    if (s.frame && s.frame.source === "game") rate.push("frame " + Math.max(0, Math.round((now - s.frame.capturedAt) / 1000)) + " s old");
    else if (s.frame && fps) rate.push(fps.toFixed(1) + " fps");
    if (s.frame && s.latencyMs != null) rate.push(s.latencyMs + " ms per frame");
    $("rate").textContent = rate.join(" · ");
    $("status").textContent = note && now < note.until ? note.text : message;
    const parts = message.split(": run ");
    $("empty-title").textContent = s.state === "connecting" ? "Looking for Summer Engine" : parts[0];
    const empty = $("empty-text");
    empty.textContent = "";
    if (parts[1]) {
      const code = document.createElement("code");
      code.textContent = parts[1];
      empty.append("Run this in the project folder:", document.createElement("br"), code);
    }
    document.title = (s.project ? s.project + " · " : "") + "Summer preview";
  }

  async function show(blob) {
    const url = URL.createObjectURL(blob);
    const next = new Image();
    next.src = url;
    try { await next.decode(); } catch (_) {}
    frame.src = url;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = url;
    shown.push(Date.now());
  }

  function readStatus(value) {
    return value && typeof value === "object" && typeof value.state === "string" ? value : null;
  }

  async function tick(id, fresh) {
    if (id !== loop || document.hidden) return;
    const started = performance.now();
    let wait = 2000;
    try {
      const res = await fetch(fresh ? "/api/frame?fresh=1" : "/api/frame", { cache: "no-store" });
      const header = res.headers.get("x-summer-status");
      let next = null;
      if (res.status === 200) {
        if (header) next = readStatus(JSON.parse(decodeURIComponent(header)));
        await show(await res.blob());
      } else {
        next = readStatus(await res.json().catch(() => null));
      }
      if (next) {
        status = next;
        wait = status.intervalMs || 2000;
      }
    } catch (_) {
      status = { state: "no_editor", message: "The preview server stopped: run npx -y summer-engine@latest preview", frame: null };
    }
    try { render(); } catch (_) {}
    if (id !== loop || document.hidden) return;
    timer = setTimeout(() => tick(id, false), Math.max(0, wait - (performance.now() - started)));
  }

  function start() {
    clearTimeout(timer);
    loop += 1;
    if (!document.hidden) tick(loop, true);
  }
  document.addEventListener("visibilitychange", start);
  $("refresh").addEventListener("click", start);
  setInterval(() => { if (!document.hidden) { try { render(); } catch (_) {} } }, 1000);

  function framePoint(event) {
    const rect = frame.getBoundingClientRect();
    const w = frame.naturalWidth, h = frame.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(rect.width / w, rect.height / h);
    const x = (event.clientX - rect.left - (rect.width - w * scale) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - h * scale) / 2) / scale;
    return x < 0 || y < 0 || x > w || y > h ? null : { x: x, y: y };
  }

  function inputOn() {
    return !framed && status && status.input;
  }

  // Releases go out even while input is off, so a key never stays held.
  async function send(inputs, release) {
    if (framed || (!release && !inputOn())) return;
    try {
      const res = await fetch("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inputs: inputs }) });
      const body = await res.json();
      note = body.ok || release ? null : { text: "Input not sent: " + body.error, until: Date.now() + 4000 };
    } catch (_) {
      note = { text: "Input not sent: the preview server did not answer", until: Date.now() + 4000 };
    }
    try { render(); } catch (_) {}
  }

  frame.addEventListener("click", (event) => {
    const point = framePoint(event);
    stage.focus();
    if (point && status && status.state === "game") send([{ kind: "click", x: point.x, y: point.y, button: 1 }], false);
  });
  frame.addEventListener("contextmenu", (event) => {
    if (!inputOn() || status.state !== "game") return;
    event.preventDefault();
    const point = framePoint(event);
    if (point) send([{ kind: "click", x: point.x, y: point.y, button: 2 }], false);
  });
  const held = new Set();
  function onKey(event, pressed) {
    if (pressed) {
      if (!inputOn() || event.metaKey) return;
      event.preventDefault();
      if (held.has(event.code)) return;
      held.add(event.code);
      send([{ kind: "key", code: event.code, pressed: true }], false);
    } else if (held.delete(event.code)) {
      event.preventDefault();
      send([{ kind: "key", code: event.code, pressed: false }], true);
    }
  }
  stage.addEventListener("keydown", (event) => onKey(event, true));
  stage.addEventListener("keyup", (event) => onKey(event, false));
  stage.addEventListener("blur", () => {
    const codes = Array.from(held);
    held.clear();
    if (codes.length) send(codes.map((code) => ({ kind: "key", code: code, pressed: false })), true);
  });

  start();
})();
</script>
</body>
</html>
`;
