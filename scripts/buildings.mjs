// Each campus's named buildings from OpenStreetMap, so an event's "Room 207, Warren Hall" lands on Warren Hall rather
// than the campus centre. Writes places/<id>.json: [[name, lat, lng, ...other names and refs]]. Buildings rarely
// change: run it again now and then, not on every scrape.
//   node scripts/buildings.mjs            every campus without a file
//   node scripts/buildings.mjs stanford   one campus, again
import { mkdir, writeFile, access } from "node:fs/promises";
import { registry } from "../lib/pipeline.js";
import { BOT_HEADERS } from "../lib/config.js";

const OUT = new URL("../places/", import.meta.url);
await mkdir(OUT, { recursive: true });
const only = process.argv[2];
const RADIUS = 2500; // metres around the campus point
const unis = (await registry()).filter((u) => (only ? u.id === only : true) && u.lat);
for (const u of unis) {
	const file = new URL(`${u.id}.json`, OUT);
	if (!only && (await access(file).then(() => true, () => false))) continue;
	const around = `(around:${RADIUS},${u.lat},${u.lng})`;
	const q = `[out:json][timeout:90];(nwr["building"]["name"]${around};nwr["amenity"~"^(university|library|theatre|arts_centre|cafe|restaurant|food_court|community_centre|conference_centre)$"]["name"]${around};nwr["leisure"~"^(park|garden|stadium|sports_centre)$"]["name"]${around};nwr["building"]["ref"]${around};);out center tags;`;
	try {
		const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }), headers: BOT_HEADERS, signal: AbortSignal.timeout(120000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		const seen = new Set(), list = [];
		for (const el of j.elements) {
			const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
			const t = el.tags ?? {};
			const names = [t.name, t["name:en"], t.alt_name, t.official_name, t.short_name, t.old_name, t.loc_name].flatMap((n) => (n ?? "").split(";")).map((n) => n.trim()).filter(Boolean);
			if (t.ref && t.building) names.push(`#${t.ref}`); // a building number, as MIT writes "33-218"
			if (!names.length || lat == null) continue;
			const key = `${names[0]}|${lat.toFixed(4)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			list.push([names[0], +lat.toFixed(5), +lng.toFixed(5), ...new Set(names.slice(1))]);
		}
		await writeFile(file, JSON.stringify(list));
		console.log(`${u.id.padEnd(14)} ${list.length} places`);
	} catch (err) {
		console.log(`${u.id.padEnd(14)} failed: ${err.message}`);
	}
	await new Promise((r) => setTimeout(r, 3000)); // Overpass is shared: one campus at a time, with a pause
}
