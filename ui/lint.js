import { $, h, api, toast, muted, messageOf } from "./core.js";

function groupByRule(issues) {
  const byRule = new Map();
  for (const i of issues) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
  return byRule;
}

const ruleBlock = ([rule, list]) => h("div", { class: "mod" },
  h("div", {}, h("strong", {}, rule), muted(`  ${list.length}`)),
  h("div", { class: "note" }, list[0].detail),
  list.slice(0, 25).map((i) => h("div", { class: "copy" }, i.path)));

$("lint-run").addEventListener("click", async () => {
  $("lint-meta").textContent = "walking the live UI...";
  try {
    const r = await api(`/api/lint?scope=${encodeURIComponent($("lint-scope").value.trim())}`);
    if (r.error) throw new Error(r.error);
    $("lint-meta").textContent = `${r.issues.length} issue(s) in ${r.visited} element(s)${r.truncated ? ", stopped at the limit" : ""}`;
    const byRule = groupByRule(r.issues);
    $("lint").replaceChildren(...(byRule.size ? [...byRule].map(ruleBlock)
      : [h("span", { class: "ok" }, "No known GameFace failures on this screen.")]));
  } catch (e) { $("lint-meta").textContent = ""; toast(messageOf(e), true); }
});
