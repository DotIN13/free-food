// "Know a calendar we're missing?": kept for a person to review; never fetched automatically.
import { db, visitor, limited, body, siteJson, send } from "./_lib.js";

export default async function handler(req, res) {
	try {
		const sql = await db();
		if (!sql) return send(res, 503, { error: "off" });
		if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
		if (await limited(sql, "suggest", req, 5, 3600)) return send(res, 429, { error: "Too many suggestions: try again later" });
		const { uni, url } = await body(req);
		const unis = await siteJson(req, "data/universities.json");
		if (!unis?.some((u) => u.id === uni)) return send(res, 400, { error: "Which campus?" });
		let link;
		try { link = new URL(String(url)); } catch {}
		if (!link || !/^https?:$/.test(link.protocol) || String(url).length > 500) return send(res, 400, { error: "That doesn't look like a web address" });
		const rows = await sql`INSERT INTO suggestions (uni, url, visitor) VALUES (${uni}, ${link.href}, ${visitor(req)}) ON CONFLICT (uni, url) DO NOTHING RETURNING id`;
		return send(res, 200, { ok: true, added: rows.length > 0 });
	} catch (err) {
		if (err.code) return send(res, err.code, { error: err.message });
		console.error(err);
		return send(res, 500, { error: "Something went wrong on our side" });
	}
}
