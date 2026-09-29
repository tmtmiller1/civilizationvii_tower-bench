import { $, state } from "./core.js";

/** @type {{ snap: any, diff: any, geom: any, hoverQueued: boolean }} */
export const map = { snap: null, diff: null, geom: null, hoverQueued: false };

/** @type {[RegExp, string][]} */
const TERRAIN_COLORS = [[/OCEAN/, "#1b3550"], [/COAST|LAKE/, "#2d6186"], [/NAVIGABLE_RIVER/, "#3b8db3"],
  [/MOUNTAIN/, "#6f7076"], [/HILL/, "#6f7d44"], [/FLAT/, "#4f7a38"]];
const terrainColor = (n) => TERRAIN_COLORS.find(([re]) => re.test(n ?? ""))?.[1] ?? "#3a4150";
const playerColor = (id) => `hsl(${(id * 67) % 360} 70% 58%)`;

// Row shift and which way north runs come from the engine (snapshot.layout), not from an assumption.
function mapGeom(canvas, snap) {
  const pad = 6;
  const cssW = canvas.clientWidth || 900;
  const size = Math.max(2.5, (cssW - 2 * pad) / ((snap.w + 0.5) * Math.sqrt(3)));
  const W = Math.sqrt(3) * size;
  const V = 1.5 * size;
  const oddShift = snap.layout ? snap.layout.oddRowShift : true;
  const northUp = snap.layout ? snap.layout.northDy > 0 : true;
  return {
    size, cssW, cssH: (snap.h - 1) * V + 2 * size + 2 * pad,
    center: (x, y) => ({
      cx: pad + x * W + W / 2 + (((y & 1) === 1) === oddShift ? W / 2 : 0),
      cy: pad + size + (northUp ? snap.h - 1 - y : y) * V,
    }),
  };
}

function hexPath(ctx, cx, cy, s) {
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k - 90);
    const px = cx + s * Math.cos(a);
    const py = cy + s * Math.sin(a);
    if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function sizeCanvas(canvas, g) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = `${g.cssH}px`;
  canvas.width = Math.round(g.cssW * dpr);
  canvas.height = Math.round(g.cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawPlots(d) {
  const { ctx, g, snap, s } = d;
  for (let i = 0; i < snap.t.length; i++) {
    const { cx, cy } = g.center(...d.xy(i));
    hexPath(ctx, cx, cy, s);
    ctx.fillStyle = terrainColor(snap.names.terrains[snap.t[i]]);
    ctx.fill();
    if (snap.o[i] >= 0) {
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = playerColor(snap.o[i]);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function drawCities(d) {
  const { ctx, g } = d;
  for (const c of d.snap.cities) {
    const { cx, cy } = g.center(...d.xy(c.i));
    const r = g.size * 0.55;
    ctx.fillStyle = "#f4f6f8";
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.lineWidth = Math.max(1, g.size * 0.2);
    ctx.strokeStyle = playerColor(c.owner);
    ctx.strokeRect(cx - r, cy - r, 2 * r, 2 * r);
  }
}

function drawUnits(d) {
  const { ctx, g } = d;
  for (const u of d.snap.units) {
    const { cx, cy } = g.center(...d.xy(u.i));
    ctx.beginPath();
    ctx.arc(cx + g.size * 0.35, cy + g.size * 0.35, Math.max(1.4, g.size * 0.28), 0, 2 * Math.PI);
    ctx.fillStyle = playerColor(u.owner);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#0b0e12";
    ctx.stroke();
  }
}

function drawDiff(d, diff) {
  const { ctx, g, s } = d;
  const ring = (x, y, color) => {
    const { cx, cy } = g.center(x, y);
    ctx.beginPath();
    ctx.arc(cx, cy, g.size * 0.8, 0, 2 * Math.PI);
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  ctx.lineWidth = Math.max(1.5, g.size * 0.28);
  for (const p of diff.plots) {
    const { cx, cy } = g.center(p.x, p.y);
    hexPath(ctx, cx, cy, s * 0.9);
    ctx.strokeStyle = p.owner ? "#ff5f5f" : "#ffd166";
    ctx.stroke();
  }
  for (const u of diff.units.appeared) ring(u.x, u.y, "#8fe0a8");
  for (const u of diff.units.gone) ring(u.x, u.y, "#ff9f9f");
}

function drawSelection(d, sel) {
  const { cx, cy } = d.g.center(sel.x, sel.y);
  hexPath(d.ctx, cx, cy, d.s);
  d.ctx.lineWidth = 2;
  d.ctx.strokeStyle = "#ffffff";
  d.ctx.stroke();
}

export function drawMap() {
  const snap = map.snap;
  if (!snap) return;
  const canvas = $("map");
  const g = mapGeom(canvas, snap);
  map.geom = g;
  const ctx = sizeCanvas(canvas, g);
  const d = { ctx, g, snap, s: g.size * 0.98, xy: (i) => [i % snap.w, Math.floor(i / snap.w)] };
  drawPlots(d);
  drawCities(d);
  drawUnits(d);
  if (map.diff) drawDiff(d, map.diff);
  if (state.sel) drawSelection(d, state.sel);
}

export function plotAt(evt) {
  const { snap, geom: g } = map;
  if (!snap || !g) return null;
  const r = $("map").getBoundingClientRect();
  const mx = evt.clientX - r.left;
  const my = evt.clientY - r.top;
  let best = null;
  let bd = Infinity;
  for (let i = 0; i < snap.t.length; i++) {
    const x = i % snap.w;
    const y = Math.floor(i / snap.w);
    const { cx, cy } = g.center(x, y);
    const d = (cx - mx) ** 2 + (cy - my) ** 2;
    if (d < bd) { bd = d; best = { x, y, i }; }
  }
  return bd <= (g.size * 1.1) ** 2 ? best : null;
}
