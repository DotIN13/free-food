// One fetcher per kind of feed. Each returns events in one shape:
// { title, start, end, allDay, location, lat, lng, url, desc, image, org, benefits, ics }

import { BOT_HEADERS } from "./config.js";

const DAYS = 21;
const MAX_BYTES = 40e6; // a feed bigger than this is cut off rather than filling memory

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every request says who we are and gives up after the timeout (robots.txt is checked per feed, in the pipeline).
// Told to slow down (429, or 503 with Retry-After), it waits as asked, up to a minute, and tries again twice more.
async function get(url, { json = false, timeout = 45000 } = {}) {
	let r;
	for (let attempt = 0; ; attempt++) {
		r = await fetch(url, { headers: { ...BOT_HEADERS, accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
		if (!(r.status === 429 || (r.status === 503 && r.headers.get("retry-after"))) || attempt >= 2) break;
		const after = Number(r.headers.get("retry-after"));
		await r.body?.cancel();
		await sleep(Math.min(60e3, (Number.isFinite(after) && after > 0 ? after * 1000 : 10e3 * (attempt + 1)) + Math.random() * 2000));
	}
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("feed too large");
	const text = await r.text();
	if (text.length > MAX_BYTES) throw new Error("feed too large");
	return json ? JSON.parse(text) : text;
}

export const strip = (html = "") =>
	String(html)
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
		.replace(/&#(\d+);/g, (_, n) => (+n > 0 && +n <= 0x10ffff ? String.fromCodePoint(+n) : " ")).replace(/&[a-z]+;/g, " ")
		.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const num = (v) => (v === null || v === undefined || v === "" || isNaN(+v) || +v === 0 ? null : +v);
const until = () => Date.now() + DAYS * 864e5;

// --- Localist: /api/2/events, 100 a page, at most two campuses at a time (they share Localist's servers)
let localistBusy = 0;
const localistWaiting = [];
async function localist(src) {
	if (localistBusy >= 2) await new Promise((r) => localistWaiting.push(r));
	localistBusy++;
	try { return await localistRead(src); } finally { localistBusy--; localistWaiting.shift()?.(); }
}
async function localistRead(src) {
	const out = [];
	for (let page = 1; page <= 15; page++) {
		if (page > 1) await sleep(800); // Localist hosts many campuses together: a pause between pages keeps us under its limit
		const j = await get(`${src.url.replace(/\/$/, "")}/api/2/events?days=${DAYS}&pp=100&page=${page}`, { json: true });
		for (const { event: e } of j.events ?? []) {
			for (const { event_instance: i } of (e.event_instances ?? []).slice(0, 4)) {
				out.push({
					title: e.title, start: i.start, end: i.end, allDay: i.all_day,
					location: [e.location_name, e.room_number].filter(Boolean).join(", ") || e.address || "",
					address: e.address || [e.geo?.street, e.geo?.city].filter(Boolean).join(", "),
					lat: num(e.geo?.latitude), lng: num(e.geo?.longitude),
					url: e.localist_url, desc: e.description_text, image: e.photo_url,
					online: e.experience === "virtual", ics: e.localist_ics_url,
					org: e.departments?.[0]?.name, tags: [...(e.filters?.event_types ?? []).map((t) => t.name), ...(e.keywords ?? [])],
				});
			}
		}
		if (!j.page?.next_page) break;
	}
	return out;
}

// --- Anthology Engage / CampusLabs: student orgs, with a "Free Food" benefit
async function engage(src) {
	const base = src.url.replace(/\/api\/discovery.*$/, "").replace(/\?.*$/, "").replace(/\/$/, "");
	const out = [];
	for (let skip = 0; skip < 1000; skip += 100) {
		const q = `endsAfter=${encodeURIComponent(new Date().toISOString())}&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=100&skip=${skip}`;
		const j = await get(`${base}/api/discovery/event/search?${q}`, { json: true });
		for (const e of j.value ?? []) {
			if (Date.parse(e.startsOn) > until()) continue;
			out.push({
				title: e.name, start: e.startsOn, end: e.endsOn, location: e.location || "",
				lat: num(e.latitude), lng: num(e.longitude), url: `${base}/event/${e.id}`,
				desc: strip(e.description), image: e.imagePath ? `https://se-images.campuslabs.com/clink/images/${e.imagePath}?preset=med-w` : null,
				org: e.organizationName, benefits: e.benefitNames ?? [], tags: e.categoryNames ?? [],
				online: /online|virtual|zoom/i.test(e.location || ""),
			});
		}
		if ((j.value ?? []).length < 100) break;
	}
	return out;
}

// --- The Events Calendar (WordPress) REST API
async function tribe(src) {
	const out = [];
	let url = `${src.url.replace(/\/$/, "")}${/wp-json/.test(src.url) ? "" : "/wp-json/tribe/events/v1/events"}?per_page=50&start_date=now`;
	for (let n = 0; url && n < 10; n++) {
		const j = await get(url, { json: true });
		for (const e of j.events ?? []) {
			const v = Array.isArray(e.venue) ? {} : e.venue ?? {};
			out.push({
				title: strip(e.title), start: (e.utc_start_date ?? e.start_date).replace(" ", "T") + (e.utc_start_date ? "Z" : ""),
				end: (e.utc_end_date ?? e.end_date)?.replace(" ", "T") + (e.utc_end_date ? "Z" : ""), allDay: e.all_day,
				location: v.venue ?? "", address: [v.address, v.city].filter(Boolean).join(", "), lat: num(v.geo_lat), lng: num(v.geo_lng),
				url: e.url, desc: strip(e.description), image: e.image?.url,
			});
		}
		url = j.next_rest_url;
		if (out.length && Date.parse(out.at(-1).start) > until()) break;
	}
	return out;
}

// --- LiveWhale JSON
async function livewhale(src) {
	const base = src.url.replace(/\/+$/, "").replace(/\/(max|paginate)\/\d+$/, "");
	// LiveWhale leaves out the place and the text unless asked: without them the map gets no room and the food check
	// sees only titles.
	const fields = /\/response_fields\//.test(base) ? "" : "response_fields/location,location_title,location_latitude,location_longitude,summary,description,group_title,tags/";
	const seen = new Map();
	// Up to 1,000 a page (the default is 100); a server too slow for that gets pages of 200. A short page, nothing new,
	// or three weeks covered ends it; otherwise the next page starts from the last day seen.
	let size = 1000, start = "";
	for (let n = 0; n < 20; n++) {
		let j;
		try { j = await get(`${base}/${start}${fields}paginate/${size}/`, { json: true }); }
		catch (err) { if (size === 1000) { size = 200; n--; continue; } throw err; }
		const page = Array.isArray(j) ? j : j.results ?? j.data ?? j.events ?? [];
		let added = 0;
		for (const e of page) { const k = `${e.id}|${e.date_iso ?? e.date_utc ?? e.date}`; if (!seen.has(k)) { seen.set(k, e); added++; } }
		const last = page.at(-1);
		const lastDate = String(last?.date_iso ?? last?.date_utc ?? "").slice(0, 10);
		if (page.length < size || !added || !lastDate || Date.parse(lastDate) > Date.now() + DAYS * 864e5) break;
		start = `start_date/${lastDate}/`;
	}
	const list = [...seen.values()];
	return list.map((e) => ({
		title: strip(e.title), start: e.date_iso ?? e.date_utc ?? e.date, end: e.date2_iso ?? e.date2_utc,
		allDay: !!e.is_all_day, location: strip(e.location ?? e.location_title ?? ""),
		lat: num(e.location_latitude), lng: num(e.location_longitude), url: e.url,
		desc: strip(`${e.summary ?? ""}\n${e.description ?? ""}`), image: e.thumbnail ?? null, tags: e.tags ?? [], org: e.group_title ? strip(e.group_title) : undefined,
	}));
}

// --- iCalendar
const qp = (s) => {
	try { return decodeURIComponent(s.replace(/=\r?\n/g, "").replace(/%/g, "%25").replace(/=([0-9A-F]{2})/gi, "%$1")); } catch { return s; }
};
const NO_PLACE = /sign in to (?:download|view|see) the location|^\s*tba\s*$|^\s*tbd\s*$/i;

export function parseIcs(text, defaultTz) {
	const calTz = text.match(/^X-WR-TIMEZONE:(.+)$/m)?.[1]?.trim() || defaultTz;
	const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
	const out = [];
	let cur = null;
	for (const line of lines) {
		if (line === "BEGIN:VEVENT") cur = {};
		else if (line === "END:VEVENT") { if (cur) out.push(cur); cur = null; }
		else if (cur) {
			const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
			if (!m) continue;
			const [, key, params, value] = m;
			if (!(key in cur)) cur[key] = { params, value: /QUOTED-PRINTABLE/i.test(params) ? qp(value) : value };
		}
	}
	const unesc = (s = "") => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
	return out.map((v) => {
		const start = icsDate(v.DTSTART, calTz), end = icsDate(v.DTEND, calTz);
		const geo = v.GEO?.value.split(/[;,]/);
		return {
			title: unesc(v.SUMMARY?.value), start: start?.iso, end: end?.iso, allDay: start?.allDay,
			location: NO_PLACE.test(v.LOCATION?.value ?? "") ? "" : unesc(v.LOCATION?.value).trim(), lat: num(geo?.[0]), lng: num(geo?.[1]),
			url: v.URL?.value, desc: strip(unesc(v.DESCRIPTION?.value ?? v["X-ALT-DESC"]?.value ?? "")),
			rrule: v.RRULE?.value,
		};
	}).filter((e) => e.title && e.start);
}

function icsDate(p, calTz) {
	if (!p) return null;
	const v = p.value.trim();
	const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
	if (!m) return null;
	const [, y, mo, d, h, mi, s, z] = m;
	if (!h) return { iso: `${y}-${mo}-${d}T00:00:00`, allDay: true, local: true };
	if (z) return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z` };
	const tz = p.params.match(/TZID=([^;:]+)/)?.[1]?.replace(/^"|"$/g, "") || calTz;
	return { iso: zoned(+y, +mo, +d, +h, +mi, +(s ?? 0), tz) };
}

// Wall-clock time in a named zone → UTC ISO.
export function zoned(y, mo, d, h, mi, s, tz) {
	const guess = Date.UTC(y, mo - 1, d, h, mi, s);
	if (!tz) return new Date(guess).toISOString();
	try {
		const f = new Intl.DateTimeFormat("en-US", { timeZone: tz.replace(/^\/.*\//, ""), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
		const parts = Object.fromEntries(f.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
		const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
		return new Date(guess - (asIfUtc - guess)).toISOString();
	} catch {
		return new Date(guess).toISOString();
	}
}

async function ical(src) {
	const url = src.url.replace(/^webcal:/, "https:");
	if (!src.pages) return parseIcs(await get(url), src.tz);
	// A calendar that serves its events a page at a time ("pages": N in the source adds &page=1…N).
	const out = [], seen = new Set();
	for (let page = 1; page <= src.pages; page++) {
		const text = await get(`${url}${url.includes("?") ? "&" : "?"}page=${page}`);
		const list = parseIcs(text, src.tz).filter((e) => { const k = `${e.title}|${e.start}`; return !seen.has(k) && seen.add(k); });
		if (!list.length) break;
		out.push(...list);
		if (page > 1) await sleep(500);
	}
	return out;
}

// --- RSS / Atom (Trumba, LiveWhale and Drupal event feeds)
async function rss(src) {
	const xml = await get(src.url);
	if (/campusgroups\.com\/rss_calendar/.test(xml)) return campusgroupsRss(xml, src);
	const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
	const tag = (s, ...names) => {
		for (const n of names) {
			const m = s.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
			if (m) return m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
		}
		return "";
	};
	const list = items.map((it) => {
		const desc = strip(tag(it, "description", "content:encoded", "summary", "content"));
		const link = tag(it, "link") || it.match(/<link[^>]*href="([^"]+)"/)?.[1];
		// Event start: a dedicated tag when the feed has one, else a date written in the description.
		// Event start: a dedicated tag, else a date written in the title or text, else the post date when it lies
		// ahead (some feeds put the event's date there; a date in the past is when the item was posted).
		const title = strip(tag(it, "title"));
		const unesc = it.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
		const evTime = unesc.match(/Event time[\s\S]{0,300}?<time[^>]*datetime="([^"]+)"[\s\S]{0,200}?(?:<time[^>]*datetime="([^"]+)")?/i);
		let start = evTime?.[1] || tag(it, "xCal:dtstart", "ev:startdate", "livewhale:date_start", "trumba:localstart", "start");
		start = start && !isNaN(Date.parse(start)) ? new Date(Date.parse(start)).toISOString() : dateIn(`${title}\n${desc}`, src.tz);
		if (!start) {
			const pub = Date.parse(tag(it, "pubDate", "dc:date"));
			if (pub > Date.now() - 864e5) start = new Date(pub).toISOString();
		}
		return {
			title: title.replace(/\s*\(\d{1,2}\/\d{1,2}\/\d{4},?\s*\d{1,2}:\d{2}\)\s*$/, "").replace(/^\d{1,2}\/\d{1,2}\/20\d\d\s+/, ""), start, end: evTime?.[2] || tag(it, "xCal:dtend", "ev:enddate") || null,
			location: strip(tag(it, "xCal:location", "ev:location", "livewhale:location", "georss:featurename")),
			lat: null, lng: null, url: strip(link), desc,
		};
	});
	// A feed whose dates are when each item was posted ("eventPages" in its entry): read the event's date from its page.
	if (src.eventPages) {
		await Promise.all([0, 1].map(async (w) => {
			for (let i = w; i < Math.min(list.length, 40); i += 2) {
				const e = list[i];
				try { const d = pageDate(await get(e.url, { timeout: 20000 }), src.tz); e.start = d?.start ?? null; e.end = d?.end ?? null; } catch { e.start = null; }
				await sleep(300);
			}
		}));
		list.splice(40);
	}
	return list.filter((e) => e.title && e.start);
}

// An event's own page: its structured start (JSON-LD startDate, a start_date field, a <time> tag), else a date in its text.
function pageDate(html, tz) {
	const iso = (v) => (v && !isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
	const zoneless = (v) => /T\d\d:\d\d/.test(v) && !/(Z|[+-]\d\d:?\d\d)$/.test(v);
	const ld = html.match(/"startDate"\s*:\s*"([^"]+)"/)?.[1];
	if (ld) {
		const end = html.match(/"endDate"\s*:\s*"([^"]+)"/)?.[1];
		return { start: zoneless(ld) ? wallIso(ld, tz) : iso(ld), end: end ? (zoneless(end) ? wallIso(end, tz) : iso(end)) : null };
	}
	const field = html.match(/name="start_date"[^>]*value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"[^>]*name="start_date"/)?.[1];
	if (field) return { start: iso(field), end: iso(html.match(/name="end_date"[^>]*value="([^"]+)"/)?.[1]) };
	const t = html.match(/<time[^>]*datetime="(\d{4}-\d\d-\d\d(?:T\d\d:\d\d)?)[^"]*"/)?.[1];
	if (t?.length > 10) return { start: wallIso(t, tz) };
	// The text from the page's heading on, so a sidebar's other dates come after the event's own.
	const main = html.includes("<h1") ? html.slice(html.indexOf("<h1")) : html;
	const text = strip(main.replace(/<head[\s\S]*?<\/head>/i, " ").replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, " "));
	// A <time> with a date but no hour: take the hour from a "6:30 pm" in the text, else the start of that day.
	if (t) {
		const hm = text.match(/\b(\d{1,2})[:.](\d\d)\s*(am|pm|a\.m\.|p\.m\.)/i);
		const h = hm ? (+hm[1] % 12) + (/p/i.test(hm[3]) ? 12 : 0) : 0;
		return { start: wallIso(`${t}T${String(h).padStart(2, "0")}:${hm ? hm[2] : "00"}`, tz) };
	}
	const dm = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(20\d\d)(?:[^0-9]{0,30}?(\d{1,2})[:.](\d\d)\s*(am|pm|a\.m\.|p\.m\.)?)?/i);
	if (dm) {
		let h = dm[4] ? +dm[4] : 0;
		if (dm[6] && /p/i.test(dm[6]) && h < 12) h += 12;
		return { start: zoned(+dm[3], new Date(`${dm[2].slice(0, 3)} 1, 2000`).getMonth() + 1, +dm[1], h, +(dm[5] ?? 0), 0, tz) };
	}
	const md = dateIn(text, tz);
	return md ? { start: md } : null;
}
// --- A WordPress post type of events (/wp-json/wp/v2/<type>) with no date field of its own (e.g. HKU's schools):
// the newest 30 posts, each dated from its own text, else from its page.
async function wpposts(src) {
	const sep = src.url.includes("?") ? "&" : "?";
	const posts = await get(`${src.url}${/per_page=/.test(src.url) ? "" : `${sep}per_page=30`}`, { json: true });
	const out = [];
	for (const p of (Array.isArray(posts) ? posts : []).slice(0, 30)) {
		const body = p.content?.rendered ?? p.excerpt?.rendered ?? "";
		let d = pageDate(`<html><body>${body}</body></html>`, src.tz);
		if (!d && p.link) { try { d = pageDate(await get(p.link, { timeout: 20000 }), src.tz); } catch {} await sleep(300); }
		if (d?.start) out.push({ title: strip(p.title?.rendered ?? ""), start: d.start, end: d.end ?? null, url: p.link, desc: strip(body).slice(0, 3000) });
	}
	return out;
}

// "2026-11-11T23:00" with no zone: the campus's wall clock.
function wallIso(v, tz) {
	const m = v.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
	return m ? zoned(+m[1], +m[2], +m[3], +m[4], +m[5], 0, tz) : null;
}

// "Wednesday, November 12, 2025, 12 – 1pm" style dates, as Trumba writes them.
function dateIn(text, tz) {
	const uk = text.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})\)/); // "(12/11/2026, 17:00)", UK order
	if (uk) return zoned(+uk[3], +uk[2], +uk[1], +uk[4], +uk[5], 0, tz);
	const cjk = text.match(/(20\d\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:[^\d]{0,12}?(\d{1,2})[:：時时](\d{2})?)?/);
	if (cjk) return zoned(+cjk[1], +cjk[2], +cjk[3], +(cjk[4] ?? 0), +(cjk[5] ?? 0), 0, tz);
	const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)?/i);
	if (!m) {
		// "11/19/2026 12:00 PM" (Harvard Berkman Klein) or a title starting "11/09/2026" (USC Viterbi): US order, American campuses only.
		const us = /^America\//.test(tz ?? "") && text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b(?:,?\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?)?/);
		if (us) {
			let h = us[4] ? +us[4] % 12 : 0;
			if (us[6] && /p/i.test(us[6])) h += 12;
			return zoned(+us[3], +us[1], +us[2], h, +(us[5] ?? 0), 0, tz);
		}
		return null;
	}
	let h = m[4] ? +m[4] : 0;
	const ap = (m[6] || "").toLowerCase();
	if (ap.startsWith("p") && h < 12) h += 12;
	if (ap.startsWith("a") && h === 12) h = 0;
	const mo = new Date(`${m[1]} 1, 2000`).getMonth() + 1;
	return zoned(+m[3], mo, +m[2], h, +(m[5] ?? 0), 0, tz);
}

// --- CampusGroups RSS: dates as M/D/YYYY and 6:00pm in the campus's own zone
function campusgroupsRss(xml, src) {
	const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
	const t = (s, n) => (s.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)) ?? [])[1]?.replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() ?? "";
	const when = (d, tm) => {
		const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
		if (!m) return null;
		const k = tm.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
		let h = k ? +k[1] : 0;
		if (k?.[3]?.toLowerCase() === "pm" && h < 12) h += 12;
		if (k?.[3]?.toLowerCase() === "am" && h === 12) h = 0;
		return zoned(+m[3], +m[1], +m[2], h, +(k?.[2] ?? 0), 0, src.tz);
	};
	return items.map((it) => {
		const loc = strip(t(it, "eventLocation"));
		return {
			title: strip(t(it, "title")), start: when(t(it, "eventDate"), t(it, "eventTime")), end: when(t(it, "eventEndDate"), t(it, "eventEndTime")),
			allDay: t(it, "allDayEvent") === "1", location: /sign in|private location/i.test(loc) ? "" : loc,
			url: strip(t(it, "eventLink")), desc: strip(t(it, "fullDescription") || t(it, "description")), org: strip(t(it, "group")),
			image: strip(t(it, "eventPhotoFullUrl")) || null, online: /virtual|online/i.test(t(it, "locationType")),
		};
	}).filter((e) => e.title && e.start);
}

// --- Imperial College London events JSON
async function imperial(src) {
	const out = [];
	for (let start = 0; start < 600; start += 100) {
		const j = await get(`https://www.imperial.ac.uk/events/feed/json/?quantity=100&show=future&start=${start}`, { json: true });
		for (const e of j.data?.events ?? []) {
			if (e.cancelled) continue;
			out.push({
				title: e.title, start: e.starts?.iso8601, end: e.ends?.iso8601, location: e.venue ?? "", address: e.address ?? "",
				url: e.url?.absolute, desc: strip(`${e.summary ?? ""}\n${e.description ?? ""}`), online: !!e.location?.online,
				org: e.groups?.[0], tags: e.categories,
			});
		}
		if (!j.meta?.page?.more) break;
	}
	return out;
}

// --- EPFL Memento
async function epfl(src) {
	const out = [];
	let url = "https://memento.epfl.ch/api/v1/events/?format=json&limit=100";
	for (let n = 0; url && n < 4; n++) {
		const j = await get(url, { json: true });
		for (const e of j.results ?? []) {
			if (e.canceled === "True") continue;
			const [y, mo, d] = e.start_date.split("-").map(Number);
			const [h, mi] = (e.start_time ?? "00:00").split(":").map(Number);
			const [y2, mo2, d2] = (e.end_date ?? e.start_date).split("-").map(Number);
			const [h2, mi2] = (e.end_time ?? e.start_time ?? "00:00").split(":").map(Number);
			out.push({
				title: e.title, start: zoned(y, mo, d, h, mi, 0, "Europe/Zurich"), end: zoned(y2, mo2, d2, h2, mi2, 0, "Europe/Zurich"),
				allDay: !e.start_time, location: e.place_and_room ?? "", url: e.event_url, desc: strip(e.description), image: e.visual_large_url,
				org: e.organizer, online: !!e.url_online_room && !e.place_and_room,
			});
		}
		url = j.next;
	}
	return out;
}

// --- ETH Zurich event calendar (the API behind ethz.ch/en/news-and-events/events.html)
async function eth(src) {
	const j = await get(src.url, { json: true, timeout: 45000 });
	const out = [];
	for (const e of j["entry-array"] ?? []) {
		const loc = e.location?.internal ? [e.location.internal.building, e.location.internal.addition].filter(Boolean).join(" ") : e.location?.address?.["1st-line"] ?? "";
		for (const d of (e["date-time-indication"]?.["date-with-times-array"] ?? []).slice(0, 4)) {
			const [y, mo, dd] = d.date.split("-").map(Number);
			const [h, mi] = (d["time-from"] ?? "00:00").split(":").map(Number);
			const [h2, mi2] = (d["time-to"] ?? d["time-from"] ?? "00:00").split(":").map(Number);
			out.push({
				title: e.content?.title, start: zoned(y, mo, dd, h, mi, 0, "Europe/Zurich"), end: zoned(y, mo, dd, h2, mi2, 0, "Europe/Zurich"),
				allDay: !d["time-from"], location: loc, address: [e.location?.address?.["2nd-line"], e.location?.address?.["3rd-line"]].filter(Boolean).join(", "),
				url: e.content?.["link-url"] || `https://ethz.ch/en/news-and-events/events/details.html?eventFeedId=${e.id}`,
				desc: strip(e.content?.description), tags: [e.classification?.["entry-type-desc"]].filter(Boolean),
			});
		}
	}
	return out;
}

// --- Boston University calendar API (no descriptions in the list)
async function bu(src) {
	const j = await get(src.url, { json: true });
	return (j.events ?? []).map((e) => ({
		title: strip(e.summary), start: new Date(e.starts * 1000).toISOString(), end: e.ends ? new Date(e.ends * 1000).toISOString() : null,
		allDay: !!e.allday, location: strip(e.location ?? ""), url: e.url, desc: "",
	}));
}

// --- Any other JSON, described by a field map in the source: { list, title, start, end, location, desc, url, lat, lng }
async function json(src) {
	const j = await get(src.url, { json: true });
	const at = (o, path) => (path ? path.split(".").reduce((x, k) => x?.[k], o) : undefined);
	const f = src.fields ?? {};
	// Times may be ISO text or epoch numbers (seconds or milliseconds).
	const when = (v) => (typeof v === "number" || /^\d{10,13}$/.test(String(v ?? "")) ? new Date(+v < 1e12 ? +v * 1000 : +v).toISOString() : v);
	const list = f.list ? at(j, f.list) : Array.isArray(j) ? j : j.events ?? j.data ?? j.items ?? j.results ?? [];
	return (list ?? []).map((e) => ({
		title: strip(at(e, f.title ?? "title")), start: when(at(e, f.start ?? "start")), end: when(at(e, f.end ?? "end")),
		location: strip(at(e, f.location ?? "location") ?? ""), desc: strip(at(e, f.desc ?? "description") ?? ""),
		url: at(e, f.url ?? "url"), lat: num(at(e, f.lat)), lng: num(at(e, f.lng)),
	}));
}

// --- Statamic's REST API (e.g. Stanford HAI): /cms/api/collections/<events>/entries, upcoming first.
// Times are the site's wall clock written with a Z, so they are read in the entry's own time zone.
async function statamic(src) {
	const base = src.url.replace(/\?.*$/, "");
	const today = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
	const startKey = src.fields?.start ?? "event_start", endKey = src.fields?.end ?? "event_end";
	const out = [];
	for (let page = 1; page <= 5; page++) {
		const j = await get(`${base}?filter[${startKey}:gte]=${today}&sort=${startKey}&limit=100&page=${page}`, { json: true });
		for (const e of j.data ?? []) {
			const wall = (v) => {
				const m = String(v ?? "").match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/);
				return m ? zoned(+m[1], +m[2], +m[3], +m[4], +m[5], 0, (typeof e.timezone === "string" ? e.timezone : e.timezone?.value) || src.tz) : null;
			};
			const text = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v).replace(/"[a-z_]+":/g, " "));
			const virtualOnly = Array.isArray(e.location) && e.location.length && e.location.every((l) => l.value === "virtual");
			out.push({
				title: strip(e.title), start: wall(e[startKey]), end: wall(e[endKey]),
				location: strip(e.address ?? ""), url: e.permalink ?? e.url, online: virtualOnly,
				desc: strip(`${text(e.dek)}\n${text(e.registration_info)}\n${text(e.sections_stream).slice(0, 4000)}`).slice(0, 3000),
			});
		}
		if (!j.links?.next) break;
	}
	return out.filter((e) => e.start);
}

// --- A Next.js page that lists events (e.g. Stanford HAI's /events, whose robots.txt closes its API but not the page):
// the page carries its entries as data in self.__next_f.push(...) strings, one object per event with a title, dek,
// event_start and event_end (the site's wall clock written with a Z, as in its Statamic API) and href.
async function nextpage(src) {
	const html = await get(src.url);
	const data = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return ""; } }).join("");
	const origin = new URL(src.url).origin;
	const seen = new Map();
	for (const chunk of data.split(/(?=\{"title":"(?:[^"\\]|\\.)*","dek")/)) {
		const field = (k) => chunk.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
		const start = field("event_start"), href = field("href");
		if (!start || !href || seen.has(href)) continue;
		const wall = (v) => { const m = String(v ?? "").match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/); return m ? zoned(+m[1], +m[2], +m[3], +m[4], +m[5], 0, src.tz) : null; };
		const dec = (v) => { try { return JSON.parse(`"${v ?? ""}"`); } catch { return v ?? ""; } };
		seen.set(href, {
			title: strip(dec(field("title"))), start: wall(start), end: wall(field("event_end")),
			url: new URL(dec(href), origin).href,
			desc: strip(dec(field("dek"))).slice(0, 1500), location: "",
		});
	}
	const list = [...seen.values()].filter((e) => e.start && e.title);
	// The room is only on each event's own page, under a "Location" label: read it for the next three weeks' events.
	for (const e of list.filter((e) => Date.parse(e.start) > Date.now() - 864e5 && Date.parse(e.start) < until()).slice(0, 30)) {
		try {
			const page = await get(e.url, { timeout: 20000 });
			// The page's own text (its agenda says "Networking Lunch", "Reception") is in rich-text blocks of its data.
			const pdata = [...page.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return ""; } }).join("");
			const body = pdata.split("RichText_root").slice(1).map((seg) => [...seg.slice(0, 20000).matchAll(/"children":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("\n")).join("\n");
			if (body) e.desc = strip(`${e.desc}\n${body.replace(/\\n/g, "\n").replace(/\\"/g, '"')}`).slice(0, 3000);
			const lines = strip(page.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, "\n")).split("\n").map((l) => l.trim()).filter(Boolean);
			const at = lines.indexOf("Location");
			if (at > 0 && lines.indexOf("Date") === at - 2) e.location = lines[at + 1].slice(0, 200);
		} catch {}
		await sleep(400);
	}
	return list;
}

// --- Northwestern's PlanIt Purple: /xmlfeed?cal=<ids>&days=N answers only for the calendar ids it is given, and there
// is no list of them, so ask for every id up to `maxId` in blocks of 1,500 and keep each event once.
async function planitpurple(src) {
	const base = src.url.replace(/\?.*$/, "");
	const seen = new Map();
	for (let from = 1; from <= (src.maxId ?? 6000); from += 1500) {
		const ids = Array.from({ length: 1500 }, (_, i) => from + i).join(",");
		const xml = await get(`${base}?cal=${ids}&days=${DAYS}`, { timeout: 90000 });
		for (const [, ev] of xml.matchAll(/<event>([\s\S]*?)<\/event>/g)) {
			const t = (k) => strip(ev.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "") ?? "");
			const url = t("ppurl"), start = +t("start_datetime"), end = +t("end_datetime");
			if (!start || seen.has(`${url}|${start}`)) continue;
			const allDay = !t("time") && /00:00$/.test(t("isodate"));
			const addr = [t("building_name"), t("address_1"), t("city")].filter(Boolean).join(", ");
			seen.set(`${url}|${start}`, {
				title: t("title"), start: new Date(start * 1000).toISOString(), end: end > start ? new Date(end * 1000).toISOString() : null, allDay,
				location: t("building_name") ? `${t("building_name")}${t("room") ? `, ${t("room")}` : ""}` : t("location"), address: addr,
				url: t("externalurl") || url, org: t("name"), online: /virtual|online|zoom/i.test(t("location")) && !t("building_name"),
				desc: `${t("description")}\n${t("cost") ? `Cost: ${t("cost")}` : ""}`.slice(0, 3000),
			});
		}
	}
	return [...seen.values()];
}

export const FETCHERS = { localist, engage, tribe, livewhale, ical, rss, json, trumba: ical, imperial, epfl, eth, bu, statamic, nextpage, planitpurple, wpposts };

// Some feeds were recorded as plain "json" or "rss"; send each to the reader that knows its shape.
export function kindOf(src) {
	const u = src.url;
	if (/\/api\/discovery\/event\/search/.test(u)) return "engage";
	if (/imperial\.ac\.uk\/events\/feed\/json/.test(u)) return "imperial";
	if (/memento\.epfl\.ch\/api/.test(u)) return "epfl";
	if (/idapps\.ethz\.ch\/pcm-pub-services/.test(u)) return "eth";
	if (/bu\.edu\/phpbin\/calendar\/rpc\/events/.test(u)) return "bu";
	if (/\/cms\/api\/collections\/[^/]+\/entries/.test(u)) return "statamic";
	if (/planitpurple\.northwestern\.edu\/xmlfeed/.test(u)) return "planitpurple";
	if (/\/live\/json\//.test(u)) return "livewhale";
	if (/wp-json\/tribe/.test(u)) return "tribe";
	return src.type;
}
