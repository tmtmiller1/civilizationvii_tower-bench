// Page-side half of the localization lint. Runs inside the game through bench.cdp.call, so it is
// self-contained: no imports, no outer references.

/**
 * Visible text that draws as boxes. A replacement character in the text itself (U+FFFD, or a literal box
 * U+25A1 / U+25AF / U+2610) comes from a file read in the wrong encoding or a glyph pasted as a box; CJK
 * text whose computed font-family names no CJK face draws as boxes because GameFace's BodyFont, TitleFont
 * and sans-serif hold no Han, kana or Hangul. Pixels cannot be read (no getImageData), so a face that is
 * listed but lacks a glyph is not caught.
 * @param {{ scope?: string | null, max?: number }} [opts]
 */
export function scanGlyphs({ scope = null, max = 20000 } = {}) {
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { error: `no element matches ${scope}` };
  const BOX = /[□▯☐�]/;
  const CJK_TEXT = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  const CJK_FACE = /(?:[-_ ](?:SC|TC|JP|KR|CN|HK|TW)\b)|CJK|Hans|Hant|Gothic|Mincho|Hiragino|PingFang|YaHei|JhengHei|Malgun|Noto Sans (?:SC|TC|JP|KR)/i;
  const issues = [];
  let visited = 0;
  const classes = (e) => (typeof e.className === "string" && e.className.trim()
    ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + classes(e));
    }
    return parts.join(" > ");
  };
  const add = (rule, el, detail) => { if (issues.length < 400) issues.push({ rule, path: pathOf(el), detail }); };
  const ownText = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" ").trim();
  const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  const checkText = (el, cs, text) => {
    const box = text.match(BOX);
    if (box) {
      add("replacement-glyph", el, `visible text holds ${hex(box[0])} ("${text.slice(0, 60)}"): the text was read in the wrong encoding or carries a box glyph; save the text file as UTF-8`);
    }
    const fams = String(cs.fontFamily || "").split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    if (CJK_TEXT.test(text) && !fams.some((f) => CJK_FACE.test(f))) {
      add("cjk-no-face", el, `CJK text ("${text.slice(0, 30)}") with font-family ${cs.fontFamily || "(none)"}, which names no CJK face, so it draws as boxes; put the locale's face (BodyFont-SC, -TC, -JP or -KR) in the list`);
    }
  };
  const walk = (el) => {
    if (visited++ > max) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    const text = ownText(el);
    if (text && rect.width > 0 && rect.height > 0 && cs.opacity !== "0") checkText(el, cs, text);
    for (const c of el.children) walk(c);
  };
  walk(root);
  const html = document.documentElement;
  return { visited, truncated: visited > max, lang: html.lang || null, htmlClass: String(html.className || ""), issues };
}
