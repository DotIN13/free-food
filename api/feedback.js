// "Was there food?": one answer per visitor per event; a second tap changes it.
import { db, visitor, limited, body, siteJson, send } from "./_lib.js";

const ID = /^[a-z0-9]{1,16}$/, UNI = /^[\w-]{1,40}$/;

async function tally(sql, id, who) {
	const [t] = await sql`SELECT count(*) FILTER (WHERE yes)::int AS yes, count(*) FILTER (WHERE NOT yes)::int AS no FROM votes WHERE event_id = ${id}`;
	const [m] = await sql`SELECT yes FROM votes WHERE event_id = ${id} AND visitor = ${who}`;
	return { yes: t.yes, no: t.no, mine: m ? (m.yes ? "yes" : "no") : null };
}

export default async function handler(req, res) {
	try {
		const sql = await db();
		if (!sql) return send(res, 503, { error: "off" });
		if (req.method === "GET") {
			const id = String(req.query.id ?? "");
			if (!ID.test(id)) return send(res, 400, { error: "Which event?" });
			return send(res, 200, await tally(sql, id, visitor(req)));
		}
		if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
		if (await limited(sql, "vote", req, 10, 60)) return send(res, 429, { error: "Too many requests: try again in a little while" });
		const { id, uni, yes } = await body(req);
		if (!ID.test(String(id)) || !UNI.test(String(uni))) return send(res, 400, { error: "No such event" });
		const campus = await siteJson(req, `data/campus/${uni}.json`);
		if (!campus?.events?.some((e) => e.id === id)) return send(res, 400, { error: "No such event" });
		const who = visitor(req);
		await sql`INSERT INTO votes (event_id, visitor, yes) VALUES (${id}, ${who}, ${!!yes}) ON CONFLICT (event_id, visitor) DO UPDATE SET yes = excluded.yes, at = now()`;
		return send(res, 200, await tally(sql, id, who));
	} catch (err) {
		if (err.code) return send(res, err.code, { error: err.message });
		console.error(err);
		return send(res, 500, { error: "Something went wrong on our side" });
	}
}
