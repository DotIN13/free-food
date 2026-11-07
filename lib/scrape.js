// One fetcher per kind of feed. Each returns events in one shape:
// { title, start, end, allDay, location, lat, lng, url, desc, image, org, benefits, ics }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";
const DAYS = 21;

async function get(url, { json = false, timeout = 45000 } = {}) {
	const r = await fetch(url, { headers: { "user-agent": UA, accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return json ? r.json() : r.text();
}

export const strip = (html = "") =>
	String(html)
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&[a-z]+;/g, " ")
		.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const num = (v) => (v === null || v === undefined || v === "" || isNaN(+v) || +v === 0 ? null : +v);
const until = () => Date.now() + DAYS * 864e5;

// --- Localist: /api/2/events, 100 a page
async function localist(src) {
	const out = [];
	for (let page = 1; page <= 15; page++) {
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
	const j = await get(src.url, { json: true });
	const list = Array.isArray(j) ? j : j.data ?? j.events ?? [];
	return list.map((e) => ({
		title: strip(e.title), start: e.date_iso ?? e.date_utc ?? e.date, end: e.date2_iso ?? e.date2_utc,
		allDay: !!e.is_all_day, location: strip(e.location ?? e.location_title ?? ""),
		lat: num(e.location_latitude), lng: num(e.location_longitude), url: e.url,
		desc: strip(`${e.summary ?? ""}\n${e.description ?? ""}`), image: e.thumbnail ?? null, tags: e.tags ?? [],
	}));
}

// --- iCalendar
const qp = (s) => {
	try { return decodeURIComponent(s.replace(/=\r?\n/g, "").replace(/%/g, "%25").replace(/=([0-9A-F]{2})/gi, "%$1")); } catch { return s; }
};
const NO_PLACE = /sign in to (?:download|view|see) the location|^\s*tba\s*$|^\s*tbd\s*$/i;

export function parseIcs(text) {
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
		const start = icsDate(v.DTSTART), end = icsDate(v.DTEND);
		const geo = v.GEO?.value.split(/[;,]/);
		return {
			title: unesc(v.SUMMARY?.value), start: start?.iso, end: end?.iso, allDay: start?.allDay,
			location: NO_PLACE.test(v.LOCATION?.value ?? "") ? "" : unesc(v.LOCATION?.value).trim(), lat: num(geo?.[0]), lng: num(geo?.[1]),
			url: v.URL?.value, desc: strip(unesc(v.DESCRIPTION?.value ?? v["X-ALT-DESC"]?.value ?? "")),
			rrule: v.RRULE?.value,
		};
	}).filter((e) => e.title && e.start);
}

function icsDate(p) {
	if (!p) return null;
	const v = p.value.trim();
	const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
	if (!m) return null;
	const [, y, mo, d, h, mi, s, z] = m;
	if (!h) return { iso: `${y}-${mo}-${d}T00:00:00`, allDay: true, local: true };
	if (z) return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z` };
	const tz = p.params.match(/TZID=([^;:]+)/)?.[1]?.replace(/^"|"$/g, "");
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
	return parseIcs(await get(src.url.replace(/^webcal:/, "https:")));
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
	return items.map((it) => {
		const desc = strip(tag(it, "description", "content:encoded", "summary", "content"));
		const link = tag(it, "link") || it.match(/<link[^>]*href="([^"]+)"/)?.[1];
		// Event start: a dedicated tag when the feed has one, else a date written in the description.
		// Event start: a dedicated tag, else a date written in the title or text, else the post date when it lies
		// ahead (some feeds put the event's date there; a date in the past is when the item was posted).
		const title = strip(tag(it, "title"));
		let start = tag(it, "xCal:dtstart", "ev:startdate", "livewhale:date_start", "trumba:localstart", "start");
		start = start && !isNaN(Date.parse(start)) ? new Date(Date.parse(start)).toISOString() : dateIn(`${title}\n${desc}`, src.tz);
		if (!start) {
			const pub = Date.parse(tag(it, "pubDate", "dc:date"));
			if (pub > Date.now() - 864e5) start = new Date(pub).toISOString();
		}
		return {
			title: title.replace(/\s*\(\d{1,2}\/\d{1,2}\/\d{4},?\s*\d{1,2}:\d{2}\)\s*$/, ""), start, end: tag(it, "xCal:dtend", "ev:enddate") || null,
			location: strip(tag(it, "xCal:location", "ev:location", "livewhale:location", "georss:featurename")),
			lat: null, lng: null, url: strip(link), desc,
		};
	}).filter((e) => e.title && e.start);
}

// "Wednesday, November 12, 2025, 12 – 1pm" style dates, as Trumba writes them.
function dateIn(text, tz) {
	const uk = text.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})\)/); // "(12/11/2026, 17:00)", UK order
	if (uk) return zoned(+uk[3], +uk[2], +uk[1], +uk[4], +uk[5], 0, tz);
	const cjk = text.match(/(20\d\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:[^\d]{0,12}?(\d{1,2})[:：時时](\d{2})?)?/);
	if (cjk) return zoned(+cjk[1], +cjk[2], +cjk[3], +(cjk[4] ?? 0), +(cjk[5] ?? 0), 0, tz);
	const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)?/i);
	if (!m) return null;
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
	const list = f.list ? at(j, f.list) : Array.isArray(j) ? j : j.events ?? j.data ?? j.items ?? j.results ?? [];
	return (list ?? []).map((e) => ({
		title: strip(at(e, f.title ?? "title")), start: at(e, f.start ?? "start"), end: at(e, f.end ?? "end"),
		location: strip(at(e, f.location ?? "location") ?? ""), desc: strip(at(e, f.desc ?? "description") ?? ""),
		url: at(e, f.url ?? "url"), lat: num(at(e, f.lat)), lng: num(at(e, f.lng)),
	}));
}

export const FETCHERS = { localist, engage, tribe, livewhale, ical, rss, json, trumba: ical, imperial, epfl, eth, bu };

// Some feeds were recorded as plain "json" or "rss"; send each to the reader that knows its shape.
export function kindOf(src) {
	const u = src.url;
	if (/\/api\/discovery\/event\/search/.test(u)) return "engage";
	if (/imperial\.ac\.uk\/events\/feed\/json/.test(u)) return "imperial";
	if (/memento\.epfl\.ch\/api/.test(u)) return "epfl";
	if (/idapps\.ethz\.ch\/pcm-pub-services/.test(u)) return "eth";
	if (/bu\.edu\/phpbin\/calendar\/rpc\/events/.test(u)) return "bu";
	if (/\/live\/json\//.test(u)) return "livewhale";
	if (/wp-json\/tribe/.test(u)) return "tribe";
	return src.type;
}
