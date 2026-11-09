// What each university is made of (units/<id>.json: schools, departments, institutes, centers, student bodies), and
// which of them we read. A feed in sources/*.json is either university-wide (listed in the file's "wide") or belongs to
// one unit (listed in that unit's "feeds"); a unit with no feed of ours is what we are missing.
import { readFile } from "node:fs/promises";

const DIR = new URL("../units/", import.meta.url);
export const KINDS = ["school", "department", "institute", "center", "student", "library", "museum", "other"];
export const MISSING = ["no-feed", "blocked", "unchecked"];

export async function unitsOf(id) {
	try { return JSON.parse(await readFile(new URL(`${id}.json`, DIR), "utf8")); } catch { return null; }
}

// The unit file read against the university's feeds as they are now: each unit's status is "feed" only when one of
// its feeds is really in sources/*.json, and each feed learns its scope. Feeds nobody claimed are listed as such.
export function coverage(uni, file) {
	const urls = new Set(uni.sources.map((s) => s.url));
	const wide = (file?.wide ?? []).filter((u) => urls.has(u));
	const owner = new Map();
	const units = (file?.units ?? []).map((x) => {
		const feeds = (x.feeds ?? []).filter((u) => urls.has(u));
		for (const f of feeds) owner.set(f, x);
		const status = feeds.length ? "feed" : x.status === "feed" ? "unchecked" : x.status ?? "unchecked";
		return { id: x.id, name: x.name, kind: KINDS.includes(x.kind) ? x.kind : "other", parent: x.parent, url: x.url, feeds, status, note: x.note, found: x.found };
	});
	const scopeOf = (url) => (wide.includes(url) ? { scope: "university" } : owner.has(url) ? { scope: "unit", unit: owner.get(url).id } : { scope: null });
	const counts = { units: units.length, feed: 0, "in-wide": 0, "no-feed": 0, blocked: 0, unchecked: 0 };
	for (const x of units) counts[x.status] = (counts[x.status] ?? 0) + 1;
	counts.missing = MISSING.reduce((n, k) => n + counts[k], 0);
	const unclaimed = uni.sources.filter((s) => !scopeOf(s.url).scope).map((s) => s.url);
	return { listed: !!file, wide, units, counts, unclaimed, scopeOf };
}
