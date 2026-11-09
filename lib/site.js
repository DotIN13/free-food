// The site as static files: what the page reads, the same whether a CI build or the Node server wrote it.
//   data/home.json            the upcoming food events, slimmed to what the home page shows (~210 KB compressed)
//   data/all.json             every other upcoming event, slimmed the same way, for "All events"
//   data/campus/<id>.json     every upcoming event at one campus, in full (opened from a campus or an event)
//   data/universities.json    campuses, their feeds and each feed's last checks
//   data/meta.json            when the data was built, and how many feeds worked
//   data/state.json           the scraper's memory for the next CI run: feed history and place lookups
//   bot/index.html            who we are, for the sites we read
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { registry } from "./pipeline.js";
import { kindOf } from "./scrape.js";
import { BOT_UA, config } from "./config.js";

const PUBLIC = new URL("../public/", import.meta.url);
const upcoming = (e, now) => Date.parse(e.end ?? e.start) >= now || Date.parse(e.start) >= now;
const isFood = (e) => e.food && e.food.level !== "maybe";

export function slim(e) {
	return {
		id: e.id, uni: e.uni, title: e.title, start: e.start, end: e.end ?? null, allDay: e.allDay || undefined,
		location: e.location || undefined, lat: e.lat == null ? undefined : +(+e.lat).toFixed(5), lng: e.lng == null ? undefined : +(+e.lng).toFixed(5),
		where: e.where, online: e.online || undefined, org: e.org || undefined,
		food: e.food ? { level: e.food.level, words: (e.food.words ?? []).slice(0, 4), why: (e.food.why ?? "").slice(0, 200) } : undefined,
	};
}

async function put(out, rel, value) {
	const file = new URL(rel, out);
	await mkdir(new URL(".", file), { recursive: true });
	const tmp = new URL(`${rel}.tmp`, out);
	await writeFile(tmp, typeof value === "string" ? value : JSON.stringify(value));
	await rename(tmp, file);
}

export async function writeSite({ events, status, at, out, geocache = null }) {
	out = new URL(String(out).replace(/\/?$/, "/"));
	const unis = await registry();
	const now = Date.now() - 2 * 36e5;
	const up = events.filter((e) => upcoming(e, now));
	const food = up.filter(isFood);
	const counts = {};
	for (const e of food) if (e.food.level === "sure") counts[e.uni] = (counts[e.uni] ?? 0) + 1;

	await put(out, "data/home.json", { at, counts, events: food.map(slim) });
	// The rest, fetched only when someone picks "All events" (about 600 KB compressed).
	await put(out, "data/all.json", { at, events: up.filter((e) => !isFood(e)).map(slim) });
	await rm(new URL("data/campus/", out), { recursive: true, force: true });
	for (const u of unis) await put(out, `data/campus/${u.id}.json`, { at, events: up.filter((e) => e.uni === u.id) });
	await put(out, "data/universities.json", unis.map((u) => ({ ...u, sources: u.sources.map((s) => ({ ...s, kind: kindOf(s), status: status[s.url] ?? null })) })));
	const feeds = unis.flatMap((u) => u.sources);
	await put(out, "data/meta.json", { at, feeds: feeds.length, ok: feeds.filter((s) => status[s.url]?.ok).length, events: up.length, food: food.length, refreshHours: config.refreshHours });
	await put(out, "data/state.json", { at, status, geocache: geocache ?? undefined });

	const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const contact = config.contactEmail
		? `Write to <a href="mailto:${escape(config.contactEmail)}">${escape(config.contactEmail)}</a> to ask us to stop, slow down, or read a different feed. We answer every message.`
		: "Contact details are being set up. Until then, a robots.txt rule for <code>free.food-bot</code> (above) stops us at the next check.";
	const bot = (await readFile(new URL("bot.html", PUBLIC), "utf8"))
		.replace("{{FEEDS}}", String(feeds.length))
		.replace("{{CAMPUSES}}", String(unis.filter((u) => u.sources.length).length))
		.replace("{{HOURS}}", String(config.refreshHours))
		.replace("{{UA}}", escape(BOT_UA))
		.replace("{{CONTACT}}", contact)
		.replace('href="./"', 'href="../"');
	await put(out, "bot/index.html", bot);
}
