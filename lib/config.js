// Settings, from the environment or an .env file beside server.js. Every one has a safe default.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ROOT = new URL("../", import.meta.url);
try {
	for (const line of readFileSync(new URL(".env", ROOT), "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
	}
} catch {}

const env = process.env;
export const DATA_DIR = new URL(`${(env.DATA_DIR ?? "data").replace(/\/?$/, "/")}`, ROOT);
mkdirSync(DATA_DIR, { recursive: true });

// A secret kept in the data folder, made on first start: it signs visitor ids and, unless ADMIN_TOKEN is set, is the admin token.
function secret(name) {
	const file = new URL(name, DATA_DIR);
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	const value = randomBytes(24).toString("base64url");
	writeFileSync(file, value + "\n", { mode: 0o600 });
	try { chmodSync(file, 0o600); } catch {}
	return value;
}

const host = env.HOST ?? "127.0.0.1";
export const config = {
	port: Number(env.PORT ?? 3000),
	host,
	// Behind a proxy (Caddy, nginx, a platform's router, Decks) the visitor's address is in X-Forwarded-For.
	// Trusted by default only when bound to loopback, where nobody but that proxy can reach us.
	trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === "1" : host === "127.0.0.1" || host === "localhost",
	adminToken: env.ADMIN_TOKEN || secret(".admin-token"),
	salt: secret(".salt"),
	allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
	frameAncestors: env.FRAME_ANCESTORS ?? "", // e.g. "'self' https://decks.example"; empty sends no frame-ancestors rule
	// Who we are, for the sites we read: a page about the bot (served at /bot) and an address to write to.
	contact: env.CONTACT_URL ?? "",
	contactEmail: env.CONTACT_EMAIL ?? "",
	siteUrl: (env.SITE_URL ?? "").replace(/\/$/, ""),
	respectRobots: env.RESPECT_ROBOTS !== "0",
	refreshHours: Number(env.REFRESH_HOURS ?? 3),
	backupDays: Number(env.BACKUP_DAYS ?? 7),
	dataDir: DATA_DIR,
};
// Every request we make names us, links to the page about us, and gives an address when one is set.
const botPage = config.contact || (config.siteUrl ? `${config.siteUrl}/bot` : "");
export const BOT_UA = `free.food-bot/1.0 (+${[botPage, config.contactEmail].filter(Boolean).join("; ") || "free.food: campus free-food events"}; reads public event calendars every ${config.refreshHours} hours)`;
// The From header is the HTTP way to give the address of the person responsible for a bot.
export const BOT_HEADERS = { "user-agent": BOT_UA, ...(config.contactEmail ? { from: config.contactEmail } : {}) };
