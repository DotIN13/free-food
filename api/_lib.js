// Shared by the Vercel functions: the database (Postgres via Neon's HTTP driver, when DATABASE_URL is set),
// who is asking, rate limits kept in the database, and the checks every write passes.
import { createHash } from "node:crypto";

let sqlFn = null;
export async function db() {
	if (!process.env.DATABASE_URL) return null;
	if (!sqlFn) {
		const { neon } = await import("@neondatabase/serverless");
		sqlFn = neon(process.env.DATABASE_URL);
		await sqlFn`CREATE TABLE IF NOT EXISTS votes (event_id text NOT NULL, visitor text NOT NULL, yes boolean NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (event_id, visitor))`;
		await sqlFn`CREATE TABLE IF NOT EXISTS suggestions (id bigserial PRIMARY KEY, uni text NOT NULL, url text NOT NULL, visitor text NOT NULL, at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'new', UNIQUE (uni, url))`;
		await sqlFn`CREATE TABLE IF NOT EXISTS hits (key text NOT NULL, at timestamptz NOT NULL DEFAULT now())`;
		await sqlFn`CREATE INDEX IF NOT EXISTS hits_key_at ON hits (key, at)`;
	}
	return sqlFn;
}

export const ip = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
const salt = () => process.env.VOTE_SALT ?? "free.food";
// A visitor: the network address and the random id the browser keeps, hashed with a secret salt. No address is stored.
export function visitor(req) {
	const id = String(req.headers["x-visitor"] ?? "").replace(/[^\w-]/g, "").slice(0, 64);
	return createHash("sha256").update(`${salt()}|${ip(req)}|${id}`).digest("base64url").slice(0, 32);
}

// At most `max` actions per address in `seconds`, counted in the database (functions share no memory).
export async function limited(sql, name, req, max, seconds) {
	const key = `${name}|${createHash("sha256").update(`${salt()}|${ip(req)}`).digest("base64url").slice(0, 24)}`;
	const [{ n }] = await sql`SELECT count(*)::int AS n FROM hits WHERE key = ${key} AND at > now() - make_interval(secs => ${seconds})`;
	if (n >= max) return true;
	await sql`INSERT INTO hits (key) VALUES (${key})`;
	if (Math.random() < 0.02) await sql`DELETE FROM hits WHERE at < now() - interval '1 day'`;
	return false;
}

// Writes: JSON only, small, and from this site when the browser says where it is.
export async function body(req) {
	if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error("Send JSON"), { code: 415 });
	const origin = req.headers.origin;
	if (origin && origin !== "null" && new URL(origin).host !== req.headers.host) throw Object.assign(new Error("Not allowed from this site"), { code: 403 });
	const text = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
	if (text.length > 8192) throw Object.assign(new Error("Too large"), { code: 413 });
	return typeof req.body === "object" && req.body ? req.body : JSON.parse(text || "{}");
}

// The deployed data files, read once per function instance.
const cache = new Map();
export async function siteJson(req, path) {
	if (cache.has(path)) return cache.get(path);
	const proto = req.headers["x-forwarded-proto"] ?? "https";
	const r = await fetch(`${proto}://${req.headers.host}/${path}`);
	const v = r.ok ? await r.json() : null;
	cache.set(path, v);
	return v;
}

export function send(res, code, value) {
	res.setHeader("cache-control", "no-store");
	res.status(code).json(value);
}
