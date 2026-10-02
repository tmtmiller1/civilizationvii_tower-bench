// Page side of the canvas static-resource test. Every canvas fill()/stroke() is reported to take a slot in a
// 49,152-item Coherent pool that nothing frees, and overflow is a hard crash. These functions look for a
// readable counter of that pool, paint on demand, and count paint calls when no counter exists. Each runs in
// the game through CdpSession.call, so each is self-contained.


// Numbers that might count the pool: numeric properties, and zero-argument get* functions, on the engine's
// script objects, whose names look like resources, caches, pools, statistics or memory. Reading is all
// this does; a get* call is the only call it makes.
export function canvasCandidates() {
  const NAME = /resource|cache|pool|stat|memory|texture|canvas|count/i;
  const roots = ["UI", "engine", "Coherent", "cohtml", "Renderer", "Graphics", "Game", "Automation", "performance"];
  const out = {};
  const seen = new Set();
  const namesOf = (obj) => {
    const names = new Set();
    for (let o = obj; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) if (NAME.test(n)) names.add(n);
    }
    return names;
  };
  const record = (key, r) => {
    if (typeof r === "number") out[key] = r;
    else if (r && typeof r === "object") for (const [k, x] of Object.entries(r)) if (typeof x === "number") out[`${key}.${k}`] = x;
  };
  const callGetter = (obj, n, fn, key) => {
    try { record(`${key}()`, fn.call(obj)); } catch { /* a getter that needs arguments or state is skipped */ }
  };
  const readProp = (obj, n) => { try { return obj[n]; } catch { return undefined; } };
  const visit = (label, obj) => {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function") || seen.has(obj)) return;
    seen.add(obj);
    for (const n of namesOf(obj)) visitProp(label, obj, n);
  };
  const visitProp = (label, obj, n) => {
    const v = readProp(obj, n);
    const key = `${label}.${n}`;
    if (typeof v === "number") out[key] = v;
    else if (typeof v === "function" && /^get/.test(n) && v.length === 0) callGetter(obj, n, v, key);
    else if (v && typeof v === "object" && !label.includes(".")) visit(key, v);
  };
  for (const r of roots) visit(r, /** @type {any} */ (globalThis)[r]);
  return {
    candidates: out,
    canvas2d: typeof CanvasRenderingContext2D !== "undefined",
    pixelApi: typeof ImageData !== "undefined",
  };
}

// Paints `k` fills on a small visible canvas, `perFrame` per animation frame so each batch is flushed, with a
// different colour per call so the renderer cannot merge them. Resolves when every batch was drawn.
export function canvasPaint({ k, perFrame = 250, method = "fill" }) {
  return new Promise((resolve) => {
    if (k <= 0) { resolve({ painted: 0 }); return; }
    const c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    c.style.cssText = "position:fixed;left:0;top:0;width:64px;height:64px;opacity:0.02;pointer-events:none;z-index:99999";
    document.body.appendChild(c);
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    let done = 0;
    const step = () => {
      const n = Math.min(perFrame, k - done);
      for (let i = 0; i < n; i++) {
        const j = done + i;
        ctx.fillStyle = ctx.strokeStyle = `rgb(${j % 251},${(j >> 3) % 241},${(j >> 6) % 239})`;
        if (method === "fillRect") ctx.fillRect(j % 60, (j >> 4) % 60, 3, 3);
        else {
          ctx.beginPath();
          ctx.rect(j % 60, (j >> 4) % 60, 3, 3);
          if (method === "stroke") ctx.stroke(); else ctx.fill();
        }
      }
      done += n;
      if (done < k) requestAnimationFrame(step);
      else requestAnimationFrame(() => { c.remove(); resolve({ painted: done }); });
    };
    requestAnimationFrame(step);
  });
}

// The fallback when no counter exists: wrap the 2D context's paint methods and count calls on this page.
// It is an upper bound on slots (the renderer merges some calls within a frame), from install onwards.
export function canvasCounter({ op = "read", logEvery = 0 }) {
  const g = /** @type {any} */ (globalThis);
  if (op === "install") {
    if (typeof CanvasRenderingContext2D === "undefined") return { installed: false, reason: "no CanvasRenderingContext2D" };
    if (!g.__tbCanvas) {
      const state = { since: Date.now(), calls: 0, byMethod: {}, logEvery };
      const proto = CanvasRenderingContext2D.prototype;
      for (const m of ["fill", "stroke", "fillRect", "strokeRect", "fillText", "strokeText"]) {
        const orig = proto[m];
        if (typeof orig !== "function") continue;
        proto[m] = function (...a) {
          state.calls++;
          state.byMethod[m] = (state.byMethod[m] ?? 0) + 1;
          if (state.logEvery && state.calls % state.logEvery === 0) console.error(`[TB-CANVAS] calls=${state.calls}`);
          return orig.apply(this, a);
        };
      }
      g.__tbCanvas = state;
    }
    return { installed: true, ...g.__tbCanvas };
  }
  return g.__tbCanvas ? { installed: true, ...g.__tbCanvas } : { installed: false };
}

// The crash test: paints in batches in the background, writing a breadcrumb to UI.log after each batch, so
// the last breadcrumb before the game dies is the count it died at. Progress is readable while it runs.
export function canvasStress({ op = "start", batch = 1000, limit = 200000, start = 0 }) {
  const g = /** @type {any} */ (globalThis);
  if (op === "read") return g.__tbStress ?? null;
  if (g.__tbStress?.running) return g.__tbStress;
  const st = { running: true, painted: start, batch, limit, page: Math.random().toString(36).slice(2, 8) };
  g.__tbStress = st;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  c.style.cssText = "position:fixed;left:0;top:0;width:64px;height:64px;opacity:0.02;pointer-events:none;z-index:99999";
  document.body.appendChild(c);
  const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  const step = () => {
    if (!st.running) return;
    for (let i = 0; i < batch; i++) {
      const j = st.painted + i;
      ctx.fillStyle = `rgb(${j % 251},${(j >> 3) % 241},${(j >> 6) % 239})`;
      ctx.beginPath();
      ctx.rect(j % 60, (j >> 4) % 60, 3, 3);
      ctx.fill();
    }
    st.painted += batch;
    console.error(`[TB-CANVAS-STRESS] page=${st.page} painted=${st.painted}`);
    if (st.painted >= limit) { st.running = false; c.remove(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return st;
}

