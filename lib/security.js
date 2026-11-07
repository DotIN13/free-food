// Who is asking, how often, and what the page may load.
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export function clientIp(req) {
	if (config.trustProxy) {
		const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
		if (xff) return xff;
	}
	return req.socket?.remoteAddress ?? "unknown";
}

// A visitor is the pair (network address, the random id this browser keeps), hashed with a secret salt:
// students behind one campus address still count separately, and no address is ever stored.
export function visitorId(req) {
	const id = String(req.headers["x-visitor"] ?? "").replace(/[^\w-]/g, "").slice(0, 64);
	return createHash("sha256").update(`${config.salt}|${clientIp(req)}|${id}`).digest("base64url").slice(0, 32);
}

// Sliding-window counters in memory: enough for one server; a fleet would move these to Redis.
const hits = new Map();
export function limit(key, max, windowMs) {
	const now = Date.now();
	const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
	if (list.length >= max) { hits.set(key, list); return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) }; }
	list.push(now);
	hits.set(key, list);
	return { ok: true };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v.at(-1) > 36e5) hits.delete(k); }, 10 * 60e3).unref();

export function headers(req) {
	const https = req.socket?.encrypted || (config.trustProxy && req.headers["x-forwarded-proto"] === "https");
	const csp = [
		"default-src 'self'",
		"script-src 'self' https://unpkg.com",
		"style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
		"font-src 'self' https://fonts.gstatic.com",
		"img-src 'self' data: blob: https:",
		"connect-src 'self' https://routing.openstreetmap.de",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		config.frameAncestors ? `frame-ancestors ${config.frameAncestors}` : "",
	].filter(Boolean).join("; ");
	return {
		"content-security-policy": csp,
		"x-content-type-options": "nosniff",
		"referrer-policy": "strict-origin-when-cross-origin",
		"permissions-policy": "geolocation=(self), camera=(), microphone=(), payment=()",
		"cross-origin-opener-policy": "same-origin",
		...(https ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
	};
}

// A write must be JSON (so another site's form can't post it, and a script on another site needs a CORS
// permission we never give), small, and, when the browser names its origin, from us.
export class HttpError extends Error {
	constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
export async function readJson(req, max = 8192) {
	if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON");
	const origin = req.headers.origin;
	if (origin && origin !== "null") {
		const host = req.headers["x-forwarded-host"] && config.trustProxy ? req.headers["x-forwarded-host"] : req.headers.host;
		let ok = false;
		try { ok = new URL(origin).host === host || config.allowedOrigins.includes(origin); } catch {}
		if (!ok) throw new HttpError(403, "Not allowed from this site");
	}
	let size = 0;
	const chunks = [];
	for await (const c of req) {
		size += c.length;
		if (size > max) throw new HttpError(413, "Too large");
		chunks.push(c);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "Bad JSON"); }
}

export function isAdmin(req) {
	const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
	const want = Buffer.from(config.adminToken);
	return got.length === want.length && timingSafeEqual(got, want);
}
