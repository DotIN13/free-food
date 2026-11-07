// robots.txt: before reading a page, check that the site lets bots read it. Rules are cached a day per site.
import { BOT_UA } from "./config.js";

const cache = new Map(); // origin → { at, rules: [{ allow, path }] }
const AGENT = "free.food-bot";

function parse(text) {
	// The group for our name if there is one, else the group for every bot ("*").
	const groups = [];
	let cur = null, lastWasAgent = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*/, "").trim();
		const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
		if (!m) continue;
		const [, k, v] = m;
		const key = k.toLowerCase();
		if (key === "user-agent") {
			if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
			cur.agents.push(v.toLowerCase());
			lastWasAgent = true;
		} else {
			lastWasAgent = false;
			if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: v });
		}
	}
	const mine = groups.find((g) => g.agents.some((a) => a !== "*" && AGENT.startsWith(a)));
	return (mine ?? groups.find((g) => g.agents.includes("*")))?.rules.filter((r) => r.path !== "" || !r.allow) ?? [];
}

const toRegex = (path) => new RegExp("^" + path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));

export async function allowed(url) {
	const u = new URL(url);
	let entry = cache.get(u.origin);
	if (!entry || Date.now() - entry.at > 864e5) {
		let rules = [];
		try {
			const r = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": BOT_UA }, signal: AbortSignal.timeout(10000), redirect: "follow" });
			// No robots.txt (404) means everything is allowed; a server error is treated the same way, as Google does for 4xx and briefly for 5xx.
			if (r.ok && /text\/plain|octet-stream/i.test(r.headers.get("content-type") ?? "text/plain")) rules = parse(await r.text());
		} catch {}
		cache.set(u.origin, (entry = { at: Date.now(), rules }));
	}
	const path = u.pathname + u.search;
	// The longest matching rule wins; on a tie, allow wins. An empty Disallow allows everything.
	let best = null;
	for (const r of entry.rules) {
		if (!r.path) continue;
		if (toRegex(r.path).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
	}
	return !best || best.allow;
}
