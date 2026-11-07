// free.food: reads university event calendars every few hours and serves the events that offer free food.
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { config, BOT_UA } from "./lib/config.js";
import { run, state, registry, loadEvents, loadStatus } from "./lib/pipeline.js";
import { kindOf } from "./lib/scrape.js";
import * as db from "./lib/db.js";
import { clientIp, visitorId, limit, headers, readJson, isAdmin, HttpError } from "./lib/security.js";

const PUBLIC = resolve(new URL("./public/", import.meta.url).pathname);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const ID = /^[a-z0-9]{1,16}$/;

// ---------- responses
function send(req, res, code, body, extra = {}) {
	const text = JSON.stringify(body);
	const h = { ...headers(req), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra };
	if (/gzip/.test(req.headers["accept-encoding"] ?? "") && text.length > 4096) {
		res.writeHead(code, { ...h, "content-encoding": "gzip", vary: "accept-encoding" });
		return res.end(gzipSync(text));
	}
	res.writeHead(code, h);
	res.end(text);
}
const fail = (code, message, extra) => { throw new HttpError(code, message, extra); };
function rate(req, name, max, windowMs) {
	const r = limit(`${name}|${clientIp(req)}`, max, windowMs);
	if (!r.ok) fail(429, "Too many requests: try again in a little while", { "retry-after": String(r.retryAfter) });
}

// ---------- the event index, rebuilt whenever a scrape lands
let index = { at: -1, byId: new Map() };
function events() {
	const data = loadEvents();
	if (index.at !== data.at) index = { at: data.at, byId: new Map(data.events.map((e) => [e.id, e])) };
	return { ...data, byId: index.byId };
}

// ---------- scheduled work: scrape when the data is older than REFRESH_HOURS, back up once a day
async function maybeRefresh() {
	if (!state.running && Date.now() - loadEvents().at > config.refreshHours * 36e5) {
		run().catch((e) => { console.error("scrape failed:", e); state.running = false; });
	}
}
function daily() { try { console.log("backup:", db.backup()); } catch (e) { console.error("backup failed:", e); } }
setInterval(maybeRefresh, 10 * 60e3).unref();
setInterval(daily, 6 * 36e5).unref();
maybeRefresh();
daily();

// ---------- routes
async function api(req, res, url) {
	const p = url.pathname, method = req.method;
	const q = url.searchParams;

	if (p === "/bot" || p === "/bot/") {
		// Who we are, for the sites we read: linked from every request's User-Agent.
		const unis = await registry();
		const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
		const contact = config.contactEmail
			? `Write to <a href="mailto:${escape(config.contactEmail)}">${escape(config.contactEmail)}</a> to ask us to stop, slow down, or read a different feed. We answer every message.`
			: "Contact details are being set up. Until then, a robots.txt rule for <code>free.food-bot</code> (above) stops us at the next check.";
		const html = (await readFile(resolve(PUBLIC, "bot.html"), "utf8"))
			.replace("{{FEEDS}}", String(unis.reduce((a, u) => a + u.sources.length, 0)))
			.replace("{{CAMPUSES}}", String(unis.filter((u) => u.sources.length).length))
			.replace("{{HOURS}}", String(config.refreshHours))
			.replace("{{UA}}", escape(BOT_UA))
			.replace("{{CONTACT}}", contact);
		res.writeHead(200, { ...headers(req), "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
		return res.end(html);
	}
	if (p === "/healthz") {
		const { at, events: list } = loadEvents();
		const age = at ? Math.round((Date.now() - at) / 6e4) : null;
		const ok = age !== null && age < config.refreshHours * 60 * 2;
		return send(req, res, ok ? 200 : 503, { ok, scrapedMinutesAgo: age, events: list.length, scraping: state.running });
	}
	if (method === "GET" && p === "/api/universities") {
		const [unis, status] = [await registry(), loadStatus()];
		return send(req, res, 200, unis.map((u) => ({ ...u, sources: u.sources.map((s) => ({ ...s, kind: kindOf(s), status: status[s.url] ?? null })) })));
	}
	if (method === "GET" && p === "/api/events") {
		const { at, events: all } = events();
		const mode = q.get("food") === "all" ? "all" : "food";
		const unis = (q.get("uni") ?? "").split(",").filter((x) => /^[\w-]{1,40}$/.test(x));
		const src = q.get("src")?.slice(0, 500);
		const text = q.get("q")?.toLowerCase().slice(0, 100);
		const max = Math.max(1, Math.min(Number(q.get("limit")) || 8000, 8000));
		const now = Date.now() - 2 * 36e5;
		let list = all.filter((e) => Date.parse(e.end ?? e.start) >= now || Date.parse(e.start) >= now);
		if (mode === "food") list = list.filter((e) => e.food && e.food.level !== "maybe");
		if (unis.length) list = list.filter((e) => unis.includes(e.uni));
		if (src) list = list.filter((e) => e.srcUrl === src);
		if (text) list = list.filter((e) => `${e.title} ${e.location} ${e.org ?? ""} ${e.desc}`.toLowerCase().includes(text));
		const counts = {};
		for (const e of all) if (e.food && e.food.level !== "maybe" && Date.parse(e.start) >= now) counts[e.uni] = (counts[e.uni] ?? 0) + 1;
		const total = list.length;
		list = list.slice(0, max).map(({ desc = "", ...e }) => ({ ...e, desc: desc.slice(0, mode === "food" ? 600 : 160) }));
		return send(req, res, 200, { at, total, all: all.length, counts, events: list });
	}
	if (method === "GET" && p.startsWith("/api/raw/")) {
		const id = p.slice(9);
		const e = ID.test(id) && events().byId.get(id);
		return e ? send(req, res, 200, e) : fail(404, "No such event");
	}
	if (method === "GET" && p.startsWith("/api/ics/")) {
		const id = p.slice(9);
		const e = ID.test(id) && events().byId.get(id);
		if (!e) fail(404, "No such event");
		const d = (s) => s.replace(/[-:]/g, "").replace(/\.\d+/, "");
		const esc = (s = "") => String(s).replace(/[\r\n]+/g, " ").replace(/([,;\\])/g, "\\$1");
		const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//free.food//EN", "BEGIN:VEVENT", `UID:${e.id}@free.food`,
			`DTSTAMP:${d(new Date().toISOString())}`, `DTSTART:${d(e.start)}`, `DTEND:${d(e.end ?? new Date(Date.parse(e.start) + 36e5).toISOString())}`,
			`SUMMARY:${esc("🍕 " + e.title)}`, `LOCATION:${esc(e.location)}`, `DESCRIPTION:${esc((e.food?.why ?? "") + "  " + (e.url ?? ""))}`,
			/^https?:\/\//.test(e.url ?? "") ? `URL:${esc(e.url)}` : "", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
		res.writeHead(200, { ...headers(req), "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="free-food-${e.id}.ics"`, "cache-control": "no-store" });
		return res.end(ics);
	}
	if (method === "GET" && p === "/api/status") return send(req, res, 200, { running: state.running, done: state.done, total: state.total, at: loadEvents().at });

	// People's input: one vote per visitor per event, a few suggestions an hour.
	if (p === "/api/feedback") {
		if (method === "GET") {
			const id = q.get("id");
			if (!ID.test(id ?? "")) fail(400, "Which event?");
			return send(req, res, 200, db.tally(id, visitorId(req)));
		}
		if (method === "POST") {
			rate(req, "vote-min", 10, 60e3);
			rate(req, "vote-hour", 60, 36e5);
			const { id, yes } = await readJson(req);
			if (!ID.test(String(id)) || !events().byId.has(id)) fail(400, "No such event");
			return send(req, res, 200, db.vote(id, visitorId(req), !!yes));
		}
	}
	if (p === "/api/suggest" && method === "POST") {
		rate(req, "suggest", 5, 36e5);
		const { uni, url: link } = await readJson(req);
		const unis = await registry();
		if (!unis.some((u) => u.id === uni)) fail(400, "Which campus?");
		let parsed;
		try { parsed = new URL(String(link)); } catch {}
		if (!parsed || !/^https?:$/.test(parsed.protocol) || String(link).length > 500) fail(400, "That doesn't look like a web address");
		const added = db.suggest(uni, parsed.href, visitorId(req));
		return send(req, res, 200, { ok: true, added });
	}

	// The owner's: start a scrape, read and mark suggestions, take a backup. Bearer ADMIN_TOKEN.
	if (p === "/api/refresh" || p.startsWith("/api/admin/")) {
		rate(req, "admin", 30, 60e3);
		if (!isAdmin(req)) fail(401, "Admin token required", { "www-authenticate": "Bearer" });
		if (p === "/api/refresh" && method === "POST") {
			const only = q.get("uni");
			if (!state.running) run({ only: only && /^[\w-]{1,40}$/.test(only) ? only : undefined }).catch((e) => { console.error(e); state.running = false; });
			return send(req, res, 202, { running: true });
		}
		if (p === "/api/admin/suggestions" && method === "GET") return send(req, res, 200, db.listSuggestions(Math.min(Number(q.get("limit")) || 200, 1000)));
		const m = p.match(/^\/api\/admin\/suggestions\/(\d+)$/);
		if (m && method === "POST") {
			const { status } = await readJson(req);
			if (!["new", "added", "rejected"].includes(status)) fail(400, "status is new, added or rejected");
			return send(req, res, db.markSuggestion(Number(m[1]), status) ? 200 : 404, { ok: true });
		}
		if (p === "/api/admin/backup" && method === "POST") return send(req, res, 200, { file: db.backup() });
	}
	return null;
}

async function file(req, res, url) {
	if (req.method !== "GET" && req.method !== "HEAD") fail(405, "Method not allowed");
	let rel;
	try { rel = decodeURIComponent(url.pathname); } catch { fail(400, "Bad path"); }
	if (rel.includes("\0")) fail(400, "Bad path");
	const full = resolve(PUBLIC, "." + (rel === "/" ? "/index.html" : rel));
	if (full !== PUBLIC && !full.startsWith(PUBLIC + sep)) fail(404, "Not found");
	const info = await stat(full).catch(() => null);
	if (!info?.isFile()) fail(404, "Not found");
	const etag = `"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}"`;
	const h = { ...headers(req), "content-type": TYPES[extname(full)] ?? "application/octet-stream", etag, "cache-control": "no-cache" };
	if (req.headers["if-none-match"] === etag) { res.writeHead(304, h); return res.end(); }
	let bytes = await readFile(full);
	if (/gzip/.test(req.headers["accept-encoding"] ?? "") && /text|javascript|json|svg/.test(h["content-type"]) && bytes.length > 2048) {
		bytes = gzipSync(bytes);
		Object.assign(h, { "content-encoding": "gzip", vary: "accept-encoding" });
	}
	res.writeHead(200, h);
	res.end(req.method === "HEAD" ? undefined : bytes);
}

const server = createServer(async (req, res) => {
	let url;
	try { url = new URL(req.url, "http://app"); } catch { res.writeHead(400).end(); return; }
	try {
		rate(req, "all", 600, 5 * 60e3);
		if (url.pathname.startsWith("/api/") || url.pathname === "/healthz" || /^\/bot\/?$/.test(url.pathname)) {
			const handled = await api(req, res, url);
			if (handled === null && !res.headersSent) fail(404, "Not found");
			return;
		}
		await file(req, res, url);
	} catch (err) {
		if (res.headersSent || res.destroyed) return res.destroy();
		try {
			if (err instanceof HttpError) {
				// A body we refused mid-upload: answer, then drop the connection rather than read the rest.
				const extra = err.code === 413 ? { ...err.extra, connection: "close" } : err.extra;
				send(req, res, err.code, { error: err.message }, extra);
				if (err.code === 413) res.on("finish", () => req.destroy());
				return;
			}
			console.error(new Date().toISOString(), req.method, url.pathname, err);
			send(req, res, 500, { error: "Something went wrong on our side" });
		} catch (e) { res.destroy(); }
	}
});
// One bad request must never take the whole service down: log it and carry on.
process.on("uncaughtException", (err) => console.error(new Date().toISOString(), "uncaught:", err));
process.on("unhandledRejection", (err) => console.error(new Date().toISOString(), "unhandled rejection:", err));
server.requestTimeout = 30e3;
server.headersTimeout = 15e3;
server.listen(config.port, config.host, () => console.log(`free.food listening on ${config.host}:${config.port}`));

// Finish what is in flight, then close the database cleanly.
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		console.log(`${sig}: shutting down`);
		server.close(() => { db.close(); process.exit(0); });
		setTimeout(() => { db.close(); process.exit(0); }, 8000).unref();
	});
}
