// Free Food Hub: scrapes university event feeds every few hours and serves the free-food ones.
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { run, state, registry, loadEvents, loadStatus } from "./lib/pipeline.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const EVERY = 3 * 36e5;

const send = (res, code, body) => {
	const text = JSON.stringify(body);
	if (/gzip/.test(res.req?.headers["accept-encoding"] ?? "") && text.length > 4096) {
		res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-encoding": "gzip" });
		return res.end(gzipSync(text));
	}
	res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(text);
};

async function maybeRefresh() {
	const { at } = await loadEvents();
	if (!state.running && Date.now() - at > EVERY) run().catch((e) => { console.error(e); state.running = false; });
}
setInterval(maybeRefresh, 10 * 60e3);
maybeRefresh();

createServer(async (req, res) => {
	const url = new URL(req.url, "http://app");
	const p = url.pathname;
	try {
		if (p === "/api/universities") {
			const [unis, status] = await Promise.all([registry(), loadStatus()]);
			return send(res, 200, unis.map((u) => ({ ...u, sources: u.sources.map((s) => ({ ...s, status: status[s.url] ?? null })) })));
		}
		if (p === "/api/events") {
			const { at, events } = await loadEvents();
			const q = url.searchParams;
			const mode = q.get("food") ?? "food"; // food | all
			const unis = q.get("uni")?.split(",").filter(Boolean);
			const text = q.get("q")?.toLowerCase();
			const limit = Math.min(+(q.get("limit") ?? 8000), 8000);
			const now = Date.now() - 2 * 36e5;
			let list = events.filter((e) => Date.parse(e.end ?? e.start) >= now || Date.parse(e.start) >= now);
			if (mode === "food") list = list.filter((e) => e.food && e.food.level !== "maybe");
			if (unis?.length) list = list.filter((e) => unis.includes(e.uni));
			if (text) list = list.filter((e) => `${e.title} ${e.location} ${e.org ?? ""} ${e.desc}`.toLowerCase().includes(text));
			const total = list.length;
			list = list.map(({ desc, srcUrl, ...e }) => ({ ...e, desc: desc.slice(0, mode === "food" ? 600 : 160) }));
			const counts = {};
			for (const e of events) if (e.food && e.food.level !== "maybe" && Date.parse(e.start) >= now) counts[e.uni] = (counts[e.uni] ?? 0) + 1;
			return send(res, 200, { at, total, all: events.length, counts, events: list.slice(0, limit) });
		}
		if (p === "/api/status") return send(res, 200, { ...state, at: (await loadEvents()).at });
		if (p === "/api/refresh" && req.method === "POST") {
			if (!state.running) run({ only: url.searchParams.get("uni") || undefined }).catch((e) => { console.error(e); state.running = false; });
			return send(res, 202, state);
		}
		if (p.startsWith("/api/ics/")) {
			const { events } = await loadEvents();
			const e = events.find((x) => x.id === p.slice(9));
			if (!e) return send(res, 404, { error: "no such event" });
			const d = (s) => s.replace(/[-:]/g, "").replace(/\.\d+/, "");
			const esc = (s = "") => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
			const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Free Food Hub//EN", "BEGIN:VEVENT", `UID:${e.id}@freefoodhub`,
				`DTSTAMP:${d(new Date().toISOString())}`, `DTSTART:${d(e.start)}`, `DTEND:${d(e.end ?? new Date(Date.parse(e.start) + 36e5).toISOString())}`,
				`SUMMARY:${esc("🍕 " + e.title)}`, `LOCATION:${esc(e.location)}`, `DESCRIPTION:${esc((e.food?.why ?? "") + "\n\n" + (e.url ?? ""))}`,
				e.url ? `URL:${e.url}` : "", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
			res.writeHead(200, { "content-type": "text/calendar", "content-disposition": `attachment; filename="free-food-${e.id}.ics"` });
			return res.end(ics);
		}
		const path = normalize(p === "/" ? "/index.html" : p);
		if (path.includes("..")) return send(res, 400, { error: "bad path" });
		const bytes = await readFile(join(PUBLIC, path));
		res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
		res.end(bytes);
	} catch (err) {
		if (err.code === "ENOENT") return send(res, 404, { error: "not found" });
		console.error(err);
		send(res, 500, { error: String(err.message ?? err) });
	}
}).listen(PORT, "127.0.0.1", () => console.log(`listening on ${PORT}`));
