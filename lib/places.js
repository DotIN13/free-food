// Find an event's building among the campus's named places (places/<id>.json, from scripts/buildings.mjs).
// "Room 207, William and June Warren Hall" → Warren Hall. The longest place name found whole in the location wins;
// failing that, the location's first part when it begins a place's name ("Becker 208" → "Becker House"), and MIT-style
// building numbers ("33-218" → building 33).
import { readFile } from "node:fs/promises";

const DIR = new URL("../places/", import.meta.url);
const cache = new Map();
const norm = (s) => ` ${String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
// Words too common to identify a building on their own.
const GENERIC = new Set(["hall", "library", "center", "centre", "building", "house", "lounge", "room", "auditorium", "theater", "theatre", "cafe", "the", "main", "student", "union", "chapel", "gym", "lab", "lawn", "quad", "court", "garden", "park", "plaza", "office", "annex", "north", "south", "east", "west", "science", "engineering", "arts", "music", "law", "business", "medicine"]);

async function index(uni) {
	if (cache.has(uni)) return cache.get(uni);
	let list = [];
	try { list = JSON.parse(await readFile(new URL(`${uni}.json`, DIR), "utf8")); } catch {}
	const names = [], refs = new Map();
	for (const [name, lat, lng, ...more] of list) {
		for (const n of [name, ...more]) {
			if (n.startsWith("#")) { refs.set(n.slice(1).toLowerCase(), [lat, lng]); continue; }
			const k = norm(n);
			const words = k.trim().split(" ");
			// A one-word name must be distinctive ("Tresidder", "Gates"), not "Library".
			if (k.trim().length < 4 || words.every((w) => GENERIC.has(w) || /^\d+$/.test(w))) continue;
			names.push([k, lat, lng]);
		}
	}
	names.sort((a, b) => b[0].length - a[0].length);
	const ix = { names, refs };
	cache.set(uni, ix);
	return ix;
}

export async function findPlace(uni, location) {
	if (!location) return null;
	const { names, refs } = await index(uni);
	if (!names.length && !refs.size) return null;
	const loc = norm(location);
	for (const [k, lat, lng] of names) if (loc.includes(k)) return [lat, lng];
	// "Becker 208": the location's first part, without room numbers, starting a place's name.
	const first = norm(String(location).split(/[,;|(]| - /)[0].replace(/\b(room|rm\.?|suite|floor|level)\b.*$/i, "").replace(/\b[a-z]?\d+[a-z]?\b/gi, ""));
	if (first.trim().length >= 5 && !GENERIC.has(first.trim())) for (const [k, lat, lng] of names) if (k.startsWith(first)) return [lat, lng];
	// "33-218", "E14-633", "Building 10": a building number.
	const ref = String(location).match(/\b([A-Z]{0,2}\d{1,3}[A-Z]?)-\d{2,4}\b/i)?.[1] ?? String(location).match(/\bbuilding\s+([A-Z]?\d{1,3}[A-Z]?)\b/i)?.[1];
	if (ref && refs.has(ref.toLowerCase())) return refs.get(ref.toLowerCase());
	return null;
}
