// Run every source, normalise, flag food, place each event on the map, and save.
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { FETCHERS, kindOf, strip } from "./scrape.js";
import { foodOf } from "./food.js";
import { tzOf } from "./tz.js";

const ROOT = new URL("../", import.meta.url);
const DATA = new URL("data/", ROOT);
const at = (name) => new URL(name, DATA);
const readJson = async (url, fallback) => JSON.parse(await readFile(url, "utf8").catch(() => JSON.stringify(fallback)));
async function save(name, value) {
	const tmp = at(`${name}.tmp`);
	await writeFile(tmp, JSON.stringify(value));
	await rename(tmp, at(name));
}

export async function registry() {
	const dir = new URL("sources/", ROOT);
	const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	const byId = new Map();
	for (const f of files) {
		for (const u of await readJson(new URL(f, dir), [])) {
			const old = byId.get(u.id);
			if (old) old.sources.push(...u.sources.filter((s) => !old.sources.some((o) => o.url === s.url)));
			else byId.set(u.id, { ...u, tz: tzOf(u), sources: [...(u.sources ?? [])] });
		}
	}
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
	const status = await readJson(at("status.json"), {});
	const prev = await readJson(at("events.json"), { events: [] });
	const fresh = new Map(); // source url → events
	const now = Date.now(), from = now - 6 * 36e5, to = now + 21 * 864e5;

	await pool(jobs, 8, async ({ u, s }) => {
		state.current.push(s.url);
		const t0 = Date.now();
		try {
			const fetcher = FETCHERS[kindOf(s)];
			if (!fetcher) throw new Error(`no fetcher for type ${s.type}`);
			// One retry after a pause: big calendars sometimes time out on a cold cache.
			const raw = await fetcher({ ...s, tz: u.tz }).catch(async () => {
				await new Promise((r) => setTimeout(r, 4000));
				return fetcher({ ...s, tz: u.tz });
			});
			const list = [];
			for (const e of raw) {
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
			status[s.url] = { uni: u.id, ok: true, at: Date.now(), ms: Date.now() - t0, events: list.length, food: list.filter((e) => e.food && e.food.level !== "maybe").length };
		} catch (err) {
			status[s.url] = { ...(status[s.url] ?? {}), uni: u.id, ok: false, at: Date.now(), error: String(err.message ?? err).slice(0, 200) };
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
	events.forEach((e, i) => (e.id = hash(`${e.uni}|${e.title}|${e.start}`)));

	await place(events, await registry());
	await save("events.json", { at: Date.now(), events });
	await save("status.json", status);
	state.running = false;
	state.finishedAt = Date.now();
}

function hash(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}

// --- Where is it? The feed's own coordinates, else OpenStreetMap's guess for the building, else the campus.
async function place(events, unis) {
	const byId = Object.fromEntries(unis.map((u) => [u.id, u]));
	const cache = await readJson(at("geocache.json"), {});
	let asked = 0;
	for (const e of events) {
		const u = byId[e.uni];
		if (e.lat && e.lng) { e.where = "feed"; continue; }
		if (e.online) continue;
		const name = (e.address || e.location || "").split(/\n/)[0].trim();
		const key = name && `${name.toLowerCase()}|${e.uni}`;
		if (key && cache[key] !== undefined) {
			if (cache[key]) Object.assign(e, { lat: cache[key][0], lng: cache[key][1], where: "osm" });
		} else if (key && e.food && e.food.level !== "maybe" && asked < 300 && u) {
			asked++;
			cache[key] = await geocode(name, u);
			if (cache[key]) Object.assign(e, { lat: cache[key][0], lng: cache[key][1], where: "osm" });
		}
		if (!e.lat && u?.lat) Object.assign(e, { lat: u.lat, lng: u.lng, where: "campus" });
	}
	await save("geocache.json", cache);
}

async function geocode(name, u) {
	await new Promise((r) => setTimeout(r, 1100)); // Nominatim allows one request a second
	const clean = name.replace(/\b(room|rm\.?|suite|floor|level)\s*[\w-]+/gi, "").replace(/\s{2,}/g, " ").trim();
	const d = 0.06; // stay within a few km of the campus
	const box = `${u.lng - d},${u.lat + d},${u.lng + d},${u.lat - d}`;
	try {
		const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&bounded=1&viewbox=${box}&q=${encodeURIComponent(clean)}`, {
			headers: { "user-agent": "FreeFoodHub/1.0 (campus events dashboard)" }, signal: AbortSignal.timeout(10000),
		});
		const [hit] = await r.json();
		return hit ? [+hit.lat, +hit.lon] : null;
	} catch {
		return null;
	}
}

export async function loadEvents() {
	return readJson(at("events.json"), { at: 0, events: [] });
}
export async function loadStatus() {
	return readJson(at("status.json"), {});
}
