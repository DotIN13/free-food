// Storage: one SQLite file (Node's built-in driver, so nothing to install), written in transactions,
// read once into memory for the API, and copied to a dated backup every day.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, renameSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { config } from "./config.js";

const file = new URL("free-food.db", config.dataDir);
const db = new DatabaseSync(file.pathname);
db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	PRAGMA foreign_keys = ON;
	PRAGMA busy_timeout = 5000;
	CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY, uni TEXT NOT NULL, start TEXT NOT NULL, src_url TEXT, food TEXT, data TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS events_uni_start ON events (uni, start);
	CREATE TABLE IF NOT EXISTS feeds (url TEXT PRIMARY KEY, uni TEXT NOT NULL, data TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS geocache (key TEXT PRIMARY KEY, lat REAL, lng REAL, at INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS votes (
		event_id TEXT NOT NULL, visitor TEXT NOT NULL, yes INTEGER NOT NULL, at INTEGER NOT NULL,
		PRIMARY KEY (event_id, visitor));
	CREATE TABLE IF NOT EXISTS suggestions (
		id INTEGER PRIMARY KEY AUTOINCREMENT, uni TEXT NOT NULL, url TEXT NOT NULL, visitor TEXT NOT NULL,
		at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', UNIQUE (uni, url));
`);

const q = {
	meta: db.prepare("SELECT value FROM meta WHERE key = ?"),
	setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
	allEvents: db.prepare("SELECT data FROM events ORDER BY start"),
	clearEvents: db.prepare("DELETE FROM events"),
	addEvent: db.prepare("INSERT OR REPLACE INTO events (id, uni, start, src_url, food, data) VALUES (?, ?, ?, ?, ?, ?)"),
	allFeeds: db.prepare("SELECT url, data FROM feeds"),
	setFeed: db.prepare("INSERT INTO feeds (url, uni, data) VALUES (?, ?, ?) ON CONFLICT (url) DO UPDATE SET uni = excluded.uni, data = excluded.data"),
	geo: db.prepare("SELECT lat, lng FROM geocache WHERE key = ?"),
	setGeo: db.prepare("INSERT OR REPLACE INTO geocache (key, lat, lng, at) VALUES (?, ?, ?, ?)"),
	vote: db.prepare("INSERT INTO votes (event_id, visitor, yes, at) VALUES (?, ?, ?, ?) ON CONFLICT (event_id, visitor) DO UPDATE SET yes = excluded.yes, at = excluded.at"),
	tally: db.prepare("SELECT COALESCE(SUM(yes), 0) AS yes, COALESCE(SUM(1 - yes), 0) AS no FROM votes WHERE event_id = ?"),
	mine: db.prepare("SELECT yes FROM votes WHERE event_id = ? AND visitor = ?"),
	suggest: db.prepare("INSERT INTO suggestions (uni, url, visitor, at) VALUES (?, ?, ?, ?) ON CONFLICT (uni, url) DO NOTHING"),
	suggestions: db.prepare("SELECT id, uni, url, at, status FROM suggestions ORDER BY at DESC LIMIT ?"),
	setSuggestion: db.prepare("UPDATE suggestions SET status = ? WHERE id = ?"),
};

function tx(fn) {
	db.exec("BEGIN IMMEDIATE");
	try { const r = fn(); db.exec("COMMIT"); return r; } catch (err) { db.exec("ROLLBACK"); throw err; }
}

// ---------- the scrape: events in memory for the API, the file as the record
let cache = null;
export function loadEvents() {
	if (!cache) cache = { at: Number(q.meta.get("scraped_at")?.value ?? 0), events: q.allEvents.all().map((r) => JSON.parse(r.data)) };
	return cache;
}
export function loadStatus() {
	return Object.fromEntries(q.allFeeds.all().map((r) => [r.url, JSON.parse(r.data)]));
}
export function saveScrape(events, status) {
	const at = Date.now();
	tx(() => {
		q.clearEvents.run();
		for (const e of events) q.addEvent.run(e.id, e.uni, e.start, e.srcUrl ?? null, e.food?.level ?? null, JSON.stringify(e));
		for (const [url, s] of Object.entries(status)) q.setFeed.run(url, s.uni ?? "", JSON.stringify(s));
		q.setMeta.run("scraped_at", String(at));
	});
	cache = { at, events };
}
export const geoGet = (key) => { const r = q.geo.get(key); return r === undefined ? undefined : r.lat == null ? null : [r.lat, r.lng]; };
export const geoSet = (key, ll) => q.setGeo.run(key, ll?.[0] ?? null, ll?.[1] ?? null, Date.now());

// ---------- people's input: one food vote per visitor per event (a second tap changes it), suggestions kept for review
export function vote(eventId, visitor, yes) {
	q.vote.run(eventId, visitor, yes ? 1 : 0, Date.now());
	return tally(eventId, visitor);
}
export function tally(eventId, visitor) {
	const t = q.tally.get(eventId);
	const m = visitor ? q.mine.get(eventId, visitor) : undefined;
	return { yes: Number(t.yes), no: Number(t.no), mine: m ? (m.yes ? "yes" : "no") : null };
}
export const suggest = (uni, url, visitor) => q.suggest.run(uni, url, visitor, Date.now()).changes > 0;
export const listSuggestions = (limit = 200) => q.suggestions.all(limit);
export const markSuggestion = (id, status) => q.setSuggestion.run(status, id).changes > 0;

// ---------- the JSON files of the first version, read once and set aside
function migrate() {
	if (q.meta.get("migrated_json")) return;
	const read = (name) => { const f = new URL(name, config.dataDir); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
	const events = read("events.json"), status = read("status.json"), geo = read("geocache.json"), fb = read("feedback.json"), sg = read("suggestions.json");
	tx(() => {
		if (events?.events?.length) {
			for (const e of events.events) q.addEvent.run(e.id, e.uni, e.start, e.srcUrl ?? null, e.food?.level ?? null, JSON.stringify(e));
			q.setMeta.run("scraped_at", String(events.at ?? 0));
		}
		for (const [url, s] of Object.entries(status ?? {})) q.setFeed.run(url, s.uni ?? "", JSON.stringify(s));
		for (const [k, v] of Object.entries(geo ?? {})) q.setGeo.run(k, v?.[0] ?? null, v?.[1] ?? null, Date.now());
		// Old votes had no visitor; each count becomes that many anonymous votes.
		for (const [id, c] of Object.entries(fb ?? {})) {
			for (let i = 0; i < (c.yes ?? 0); i++) q.vote.run(id, `legacy-yes-${i}`, 1, Date.now());
			for (let i = 0; i < (c.no ?? 0); i++) q.vote.run(id, `legacy-no-${i}`, 0, Date.now());
		}
		for (const s of sg ?? []) q.suggest.run(s.uni ?? "", s.url, "legacy", s.at ?? Date.now());
		q.setMeta.run("migrated_json", String(Date.now()));
	});
	for (const name of ["events.json", "status.json", "geocache.json", "feedback.json", "suggestions.json"]) {
		const f = new URL(name, config.dataDir);
		if (existsSync(f)) renameSync(f, new URL(`${name}.migrated`, config.dataDir));
	}
}
migrate();

// ---------- backups: a consistent copy of the database once a day, the last N kept
const backups = new URL("backups/", config.dataDir);
export function backup() {
	mkdirSync(backups, { recursive: true });
	const day = new Date().toISOString().slice(0, 10);
	const target = new URL(`free-food-${day}.db`, backups);
	if (!existsSync(target)) db.exec(`VACUUM INTO '${target.pathname.replace(/'/g, "''")}'`);
	const old = readdirSync(backups).filter((f) => /^free-food-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -config.backupDays);
	for (const f of old) unlinkSync(new URL(f, backups));
	return target.pathname;
}
export function close() { try { db.close(); } catch {} }
