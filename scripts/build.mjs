#!/usr/bin/env node
// Build the deployable site: scrape every feed, write the static files, and lay out a folder Vercel can deploy.
//
//   node scripts/build.mjs --out dist [--site https://free-food.vercel.app] [--only nyu]
//
// The scraper's memory (each feed's last checks, place lookups, and the last good events of a feed that fails)
// is read back from the live site named by --site (or SITE_URL), so a CI run needs no database of its own.
import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { run, useStore, registry, state } from "../lib/pipeline.js";
import { writeSite } from "../lib/site.js";

const { values: args } = parseArgs({ options: { out: { type: "string", default: "dist" }, site: { type: "string" }, only: { type: "string" } } });
const ROOT = new URL("../", import.meta.url);
const OUT = new URL(`${args.out.replace(/\/?$/, "/")}`, `file://${process.cwd()}/`);
const SITE = (args.site ?? process.env.SITE_URL ?? "").replace(/\/$/, "");

async function getJson(path) {
	if (!SITE) return null;
	try {
		const r = await fetch(`${SITE}/${path}`, { signal: AbortSignal.timeout(20000) });
		return r.ok ? await r.json() : null;
	} catch { return null; }
}

// ---------- memory from the last deployment
const prior = (await getJson("data/state.json")) ?? {};
const geocache = new Map(Object.entries(prior.geocache ?? {}));
console.log(`prior state: ${SITE ? `${Object.keys(prior.status ?? {}).length} feeds, ${geocache.size} places from ${SITE}` : "none (first build)"}`);

async function priorEvents() {
	if (!SITE) return { at: 0, events: [] };
	const unis = await registry();
	const lists = await Promise.all(unis.map((u) => getJson(`data/campus/${u.id}.json`)));
	return { at: prior.at ?? 0, events: lists.flatMap((l) => l?.events ?? []) };
}

let written = false;
useStore({
	loadStatus: async () => prior.status ?? {},
	loadEvents: priorEvents,
	geoGet: async (key) => geocache.get(key),
	geoSet: async (key, ll) => { geocache.set(key, ll ?? null); },
	saveScrape: async (events, status) => {
		await rm(OUT, { recursive: true, force: true });
		await mkdir(OUT, { recursive: true });
		// The page itself, without the bot page template (bot/ is written from it).
		for (const f of await readdir(new URL("public/", ROOT))) if (f !== "bot.html") await cp(new URL(`public/${f}`, ROOT), new URL(f, OUT), { recursive: true });
		await writeSite({ events, status, at: Date.now(), out: OUT, geocache: Object.fromEntries(geocache) });
		// What Vercel runs: two small functions for votes and suggestions, and the headers.
		await cp(new URL("api/", ROOT), new URL("api/", OUT), { recursive: true });
		await cp(new URL("vercel.json", ROOT), new URL("vercel.json", OUT));
		await cp(new URL("deploy/package.json", ROOT), new URL("package.json", OUT));
		written = true;
	},
});

const t0 = Date.now();
await run({ only: args.only });
if (!written) { console.error("the scrape did not finish"); process.exit(1); }
console.log(`built ${OUT.pathname} in ${Math.round((Date.now() - t0) / 1000)} s: ${state.done}/${state.total} feeds`);
