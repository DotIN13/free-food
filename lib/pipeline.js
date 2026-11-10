// Run every source, normalise, flag food, place each event on the map, and save.
import { readFile, readdir } from "node:fs/promises";
import { FETCHERS, kindOf, strip, zoned } from "./scrape.js";
import { BOT_HEADERS, config } from "./config.js";
import { allowed } from "./robots.js";
export const ROBOTS = "not allowed by the site's robots.txt";
import { foodOf } from "./food.js";
import { tzOf } from "./tz.js";
import { findPlace } from "./places.js";

const ROOT = new URL("../", import.meta.url);
const readJson = async (url, fallback) => JSON.parse(await readFile(url, "utf8").catch(() => JSON.stringify(fallback)));
// Where the scrape keeps its memory: the SQLite file when the server runs it (lib/db.js),
// or an in-memory copy read back from the live site when a CI build runs it (scripts/build.mjs).
// A store has loadEvents(), loadStatus(), saveScrape(events, status), geoGet(key), geoSet(key, latlng).
let store = null;
export function useStore(s) { store = s; }

export async function registry() {
	const dir = new URL("sources/", ROOT);
	const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	const byId = new Map();
	for (const f of files) {
		for (const u of await readJson(new URL(f, dir), [])) {
			const old = byId.get(u.id);
			if (old) {
				old.sources.push(...u.sources.filter((s) => !old.sources.some((o) => o.url === s.url)));
				// A file that only adds feeds (no name, no place) leaves those to the university's main entry.
				for (const [k, v] of Object.entries(u)) if (k !== "sources" && old[k] === undefined) old[k] = v;
			}
			else byId.set(u.id, { ...u, sources: [...(u.sources ?? [])] });
		}
	}
	for (const u of byId.values()) u.tz = tzOf(u);
	return [...byId.values()].sort((a, b) => (b.country === "US") - (a.country === "US") || a.rank - b.rank);
}

export const state = { running: false, done: 0, total: 0, startedAt: null, current: [] };

async function pool(items, n, fn) {
	let i = 0;
	await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export async function run({ only } = {}) {
	if (state.running) return;
	const unis = (await registry()).filter((u) => !only || u.id === only);
	const jobs = unis.flatMap((u) => u.sources.map((s) => ({ u, s })));
	Object.assign(state, { running: true, done: 0, total: jobs.length, startedAt: Date.now(), current: [] });
	const status = await store.loadStatus();
	const prev = await store.loadEvents();
	const fresh = new Map(); // source url → events
	const now = Date.now(), from = now - 6 * 36e5, to = now + 21 * 864e5;

	await pool(jobs, 8, async ({ u, s }) => {
		state.current.push(s.url);
		const t0 = Date.now();
		try {
			// robots.txt first, unless the university has given us permission for this feed ("permission" in its source entry).
			// A feed marked "robots" in its source entry is read despite the site's rule for all bots, by the owner's decision.
			// A rule that names free.food-bot itself is always obeyed, and every request says who we are.
			// With the check off (for now, by the owner's decision), only a rule naming free.food-bot is obeyed: the opt-out /bot promises.
			if (!s.permission && !(await allowed(s.url, { onlyNamed: !config.respectRobots || !!s.robots }))) throw new Error(ROBOTS);
			const fetcher = FETCHERS[kindOf(s)];
			if (!fetcher) throw new Error(`no fetcher for type ${s.type}`);
			// One retry after a pause: big calendars sometimes time out on a cold cache.
			const raw = await fetcher({ ...s, tz: u.tz }).catch(async () => {
				await new Promise((r) => setTimeout(r, 4000));
				return fetcher({ ...s, tz: u.tz });
			});
			const list = [];
			for (const e of raw) {
				// A bare date ("2026-11-12") is an all-day event on the campus's own calendar, not midnight UTC.
				for (const k of ["start", "end"]) {
					const d = String(e[k] ?? "").match(/^(\d{4})-(\d\d)-(\d\d)$/);
					if (d) { e[k] = zoned(+d[1], +d[2], +d[3], 0, 0, 0, u.tz); if (k === "start") e.allDay = true; }
				}
				const t = Date.parse(e.start);
				if (isNaN(t) || t < from || t > to) continue;
				if (!e.title) continue;
				const food = foodOf(e);
				list.push({
					uni: u.id, src: s.label ?? s.type, institute: !!s.institute,
					title: strip(e.title).slice(0, 200), start: new Date(t).toISOString(),
					end: e.end && !isNaN(Date.parse(e.end)) ? new Date(Date.parse(e.end)).toISOString() : null,
					allDay: !!e.allDay, location: strip(e.location ?? "").replace(/\n/g, ", ").slice(0, 200), address: e.address ?? "",
					lat: e.lat, lng: e.lng, url: e.url, ics: e.ics, image: e.image, org: e.org,
					online: !!e.online || /^(online|virtual|zoom)\b/i.test(e.location ?? ""),
					desc: (e.desc ?? "").slice(0, food ? 1500 : 400), food,
				});
			}
			fresh.set(s.url, list);
			const food = list.filter((e) => e.food && e.food.level !== "maybe").length;
			const history = [...(status[s.url]?.history ?? []), { at: Date.now(), ok: true, events: list.length, food }].slice(-8);
			status[s.url] = { uni: u.id, ok: true, at: Date.now(), ms: Date.now() - t0, events: list.length, food, history };
		} catch (err) {
			const history = [...(status[s.url]?.history ?? []), { at: Date.now(), ok: false, events: 0, food: 0 }].slice(-8);
			status[s.url] = { ...(status[s.url] ?? {}), uni: u.id, ok: false, at: Date.now(), error: String(err.message ?? err).slice(0, 200), history };
		}
		state.current = state.current.filter((x) => x !== s.url);
		state.done++;
	});

	// Keep the last good events of a source that failed this time.
	const failed = new Set(jobs.filter(({ s }) => !fresh.has(s.url)).map(({ s }) => s.url));
	const kept = prev.events.filter((e) => failed.has(e.srcUrl) && Date.parse(e.start) > from);
	let events = [...kept];
	for (const [url, list] of fresh) events.push(...list.map((e) => ({ ...e, srcUrl: url })));
	if (only) events.push(...prev.events.filter((e) => e.uni !== only));

	// One event listed by two feeds (the university's and an institute's) is shown once.
	const seen = new Map();
	for (const e of events) {
		const key = `${e.uni}|${e.title.toLowerCase().replace(/\W+/g, "")}|${e.start.slice(0, 16)}`;
		const old = seen.get(key);
		if (!old || (!old.food && e.food) || (!old.lat && e.lat)) seen.set(key, e);
	}
	events = [...seen.values()].sort((a, b) => a.start.localeCompare(b.start));
	// An exhibition listed once a day for three weeks is one thing to see: keep the next three of anything listed more
	// than seven times, so it doesn't bury the rest of the campus. Food is kept every day: each day is a meal.
	const runs = new Map();
	for (const e of events) { const k = `${e.uni}|${e.title.toLowerCase()}`; runs.set(k, (runs.get(k) ?? 0) + 1); }
	const shown = new Map();
	events = events.filter((e) => {
		const k = `${e.uni}|${e.title.toLowerCase()}`;
		if (runs.get(k) <= 7 || (e.food && e.food.level !== "maybe")) return true;
		shown.set(k, (shown.get(k) ?? 0) + 1);
		return shown.get(k) <= 3;
	});
	events.forEach((e, i) => (e.id = hash(`${e.uni}|${e.title}|${e.start}`)));

	await place(events, await registry());
	await store.saveScrape(events, status);
	state.running = false;
	state.finishedAt = Date.now();
}

function hash(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}

// --- Where is it? The feed's own coordinates, else the campus building its location names (places/<id>.json),
// else OpenStreetMap's search for it, else the campus.
async function place(events, unis) {
	const byId = Object.fromEntries(unis.map((u) => [u.id, u]));
	let asked = 0;
	for (const e of events) {
		const u = byId[e.uni];
		if (e.lat && e.lng) { e.where = "feed"; continue; }
		if (e.online) continue;
		const building = await findPlace(e.uni, e.location) ?? await findPlace(e.uni, e.address);
		if (building) { Object.assign(e, { lat: building[0], lng: building[1], where: "osm" }); continue; }
		const name = (e.address || e.location || "").split(/\n/)[0].trim();
		const key = name && `${name.toLowerCase()}|${e.uni}`;
		const hit = key ? await store.geoGet(key) : undefined;
		if (hit !== undefined) {
			if (hit) Object.assign(e, { lat: hit[0], lng: hit[1], where: "osm" });
		} else if (key && e.food && e.food.level !== "maybe" && asked < 300 && u) {
			asked++;
			const ll = await geocode(name, u);
			await store.geoSet(key, ll);
			if (ll) Object.assign(e, { lat: ll[0], lng: ll[1], where: "osm" });
		}
		if (!e.lat && u?.lat) Object.assign(e, { lat: u.lat, lng: u.lng, where: "campus" });
	}
}

async function geocode(name, u) {
	await new Promise((r) => setTimeout(r, 1100)); // Nominatim allows one request a second
	const clean = name.replace(/\b(room|rm\.?|suite|floor|level)\s*[\w-]+/gi, "").replace(/\s{2,}/g, " ").trim();
	const d = 0.06; // stay within a few km of the campus
	const box = `${u.lng - d},${u.lat + d},${u.lng + d},${u.lat - d}`;
	try {
		const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&bounded=1&viewbox=${box}&q=${encodeURIComponent(clean)}`, {
			headers: BOT_HEADERS, signal: AbortSignal.timeout(10000),
		});
		const [hit] = await r.json();
		return hit ? [+hit.lat, +hit.lon] : null;
	} catch {
		return null;
	}
}
