// How much of each university we read: its units (units/<id>.json) against its feeds (sources/*.json).
//   node scripts/coverage.mjs            one line per university, then the totals
//   node scripts/coverage.mjs stanford   that university's missing units, and feeds no unit claims
import { registry } from "../lib/pipeline.js";
import { unitsOf, coverage, KINDS } from "../lib/units.js";

const only = process.argv[2];
const unis = (await registry()).filter((u) => !only || u.id === only);
const total = { units: 0, feed: 0, "in-wide": 0, missing: 0, unlisted: 0, unclaimed: 0 };
for (const u of unis) {
	const file = await unitsOf(u.id);
	if (!file) { total.unlisted++; console.log(`${u.id.padEnd(14)} no units file`); continue; }
	const c = coverage(u, file), n = c.counts;
	for (const k of ["units", "feed", "in-wide", "missing"]) total[k] += n[k];
	total.unclaimed += c.unclaimed.length;
	const bad = c.units.filter((x) => !KINDS.includes(x.kind) || (x.parent && !c.units.some((p) => p.id === x.parent)));
	console.log(`${u.id.padEnd(14)} ${String(n.units).padStart(3)} units · read ${String(n.feed + n["in-wide"]).padStart(3)} (${n.feed} own feed, ${n["in-wide"]} main calendar) · missing ${n.missing} (${n["no-feed"]} no feed, ${n.blocked} blocked, ${n.unchecked} unchecked)${c.unclaimed.length ? ` · ${c.unclaimed.length} feeds unclaimed` : ""}${bad.length ? ` · ${bad.length} bad kind/parent` : ""}`);
	if (only) {
		for (const x of c.units.filter((x) => !["feed", "in-wide"].includes(x.status))) console.log(`   ${x.status.padEnd(10)} ${x.kind.padEnd(10)} ${x.name}${x.found ? `  found: ${x.found}` : ""}${x.note ? `  (${x.note})` : ""}`);
		for (const f of c.unclaimed) console.log(`   unclaimed  ${f}`);
	}
}
if (!only) console.log(`\n${unis.length - total.unlisted} of ${unis.length} universities listed · ${total.units} units · read ${total.feed + total["in-wide"]} (${total.feed} own feed, ${total["in-wide"]} main calendar) · missing ${total.missing} · ${total.unclaimed} feeds unclaimed`);
