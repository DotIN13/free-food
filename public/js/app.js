// free.food: home (with an event opened in place), event page, campus page, campuses, saved, take me there.
import { esc, icon, fmt, ago, km, distText, walkMin, minText, FOODS, foodsOf, catOf, highlight, quoteOf, perkOf, platformOf, shortUrl, isStudentFeed, timeParts, range, status, dayLabel, inWindow } from "./util.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = (() => { try { return window.localStorage; } catch { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => (m[k] = String(v)) }; } })();
const narrow = () => matchMedia("(max-width: 760px)").matches;
const view = $("#view");

const S = {
	unis: [], byUni: {}, events: [], counts: {}, at: 0, total: 0, loaded: false, error: null, status: null,
	scope: store.getItem("scope") || "",
	when: "soon",
	cat: null, q: "", sel: null,
	me: JSON.parse(store.getItem("me") || "null"),
	saved: JSON.parse(store.getItem("saved") || "{}"),
	mode: "foot",
};
const tzOf = (e) => S.byUni[e.uni]?.tz;
const uniOf = (e) => S.byUni[e.uni];
const shortOf = (id) => S.byUni[id]?.short ?? S.byUni[id]?.name ?? id;
const srcOf = (e) => S.byUni[e.uni]?.sources.find((x) => x.url === e.srcUrl);
const distOf = (e) => (S.me && e.lat && !e.online ? km(S.me, e) : null);
const walkOf = (e) => { const d = distOf(e); return d == null || d > 15 ? null : walkMin(d); };
const sure = (e) => e.food?.level === "sure";
const refreshIcons = () => window.lucide?.createIcons({ attrs: { "stroke-width": 2 } });
let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);

// ---------- data
// A random id this browser keeps, so the server can count one vote per visitor without knowing who anyone is.
const visitor = store.getItem("visitor") || (() => { const v = crypto.randomUUID(); store.setItem("visitor", v); return v; })();
async function getJson(url, opts = {}) {
	// Our own API gets the visitor id; outside services (routing) get nothing extra, or they refuse the request.
	const own = !/^https?:\/\//.test(url);
	const headers = { ...(own ? { "x-visitor": visitor } : {}), ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) };
	const r = await fetch(url, { ...opts, headers });
	if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status} ${r.statusText}`);
	return r.json();
}
async function loadBase() {
	try {
		const [unis, ev] = await Promise.all([getJson("api/universities"), getJson("api/events?food=food")]);
		S.unis = unis;
		S.byUni = Object.fromEntries(unis.map((u) => [u.id, u]));
		Object.assign(S, { events: ev.events, counts: ev.counts, at: ev.at, total: ev.all, loaded: true, error: null });
		$("#banner").hidden = true;
	} catch (err) {
		S.error = err;
		const b = $("#banner");
		b.hidden = false;
		b.innerHTML = `Couldn't reach the server (${esc(err.message)}). <button class="btn sm" id="retry">Try again</button>`;
		$("#retry").onclick = () => loadBase().then(route);
	}
	health();
	updateWhere();
}
// ---------- where: near you, one campus, or everywhere
const NEAR_KM = 40;
const nearestUnis = (p, n = 3) => S.unis.filter((u) => u.lat && u.sources.length).map((u) => ({ u, d: km(p, u) })).sort((a, b) => a.d - b.d).slice(0, n);
function scopeOptions() {
	const opt = (u) => `<option value="${u.id}" ${S.scope === u.id ? "selected" : ""}>${esc(u.short ?? u.name)}</option>`;
	const us = S.unis.filter((u) => u.country === "US"), world = S.unis.filter((u) => u.country !== "US");
	return `<option value="near" ${S.scope === "near" ? "selected" : ""}>Near you</option><option value="" ${!S.scope ? "selected" : ""}>All campuses</option><optgroup label="United States">${us.map(opt).join("")}</optgroup><optgroup label="Rest of the world">${world.map(opt).join("")}</optgroup>`;
}
// With no location, the campus in the browser's own time zone with the most free food this week.
function guessScope() {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const c = S.counts ?? {};
	return S.unis.filter((u) => u.tz === tz && u.sources.length).sort((a, b) => (c[b.id] ?? 0) - (c[a.id] ?? 0))[0]?.id ?? "";
}
function setScope(v, { why = null, save = true } = {}) {
	S.scope = v;
	S.scopeWhy = why;
	S.sel = null;
	if (save) store.setItem("scope", v);
	updateWhere();
}
function health() {
	const el = $("#live"), txt = $("#liveText");
	const feeds = S.unis.flatMap((u) => u.sources), ok = feeds.filter((f) => f.status?.ok).length;
	el.className = "live";
	if (S.status?.running) { el.classList.add("busy"); txt.innerHTML = `Updating ${S.status.done}/${S.status.total}<span class="long"> feeds</span>`; return; }
	if (S.error) { el.classList.add("warn"); txt.textContent = "Offline"; return; }
	if (!S.at) { txt.textContent = "Connecting…"; return; }
	if (Date.now() - S.at > 6 * 36e5) el.classList.add("warn");
	txt.innerHTML = `Live · updated ${ago(S.at)}<span class="long"> · ${ok}/${feeds.length} feeds</span>`;
}
async function poll() {
	try { S.status = await getJson("api/status"); } catch { S.status = null; }
	health();
	if (S.status?.running) setTimeout(poll, 3000);
	else if (S.status && S.status.at && S.status.at !== S.at) { await loadBase(); route(); }
}

// ---------- saved and location
const isSaved = (id) => !!S.saved[id];
function toggleSave(e) {
	if (S.saved[e.id]) delete S.saved[e.id];
	else S.saved[e.id] = e;
	store.setItem("saved", JSON.stringify(S.saved));
	$$(`[data-save="${e.id}"]`).forEach((b) => b.classList.toggle("on", isSaved(e.id)));
	toast(isSaved(e.id) ? "Saved" : "Removed from saved");
}
function setMe(lat, lng) {
	S.me = { lat, lng };
	store.setItem("me", JSON.stringify(S.me));
	updateWhere();
}
// "Near NYU" on the top right, once the person has said where they are: the closest campus, or just "Near you".
function updateWhere() {
	const el = $("#where");
	if (!S.me || !S.unis.length) { el.hidden = true; return; }
	const n = nearestUnis(S.me, 1)[0];
	$("#whereText").textContent = n && n.d <= NEAR_KM ? `Near ${n.u.short ?? n.u.name}` : "Near you";
	el.classList.toggle("on", S.scope === "near");
	el.hidden = false;
}
function locate() {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(false);
		navigator.geolocation.getCurrentPosition((p) => { setMe(p.coords.latitude, p.coords.longitude); resolve(true); }, () => resolve(false), { timeout: 8000, maximumAge: 120000 });
	});
}
function toast(text, ms = 3200) {
	const t = $("#toast");
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toast.t);
	toast.t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- map helpers
function makeMap(el, opts = {}) {
	const map = L.map(el, { zoomControl: false, worldCopyJump: true, ...opts }).setView([32, -40], 3);
	L.control.zoom({ position: "bottomright" }).addTo(map);
	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · routes © FOSSGIS' }).addTo(map);
	onLeave(() => map.remove());
	return map;
}
const pinIcon = (e, big) => L.divIcon({ className: "", iconSize: big ? [56, 56] : [44, 44], iconAnchor: big ? [28, 28] : [22, 22],
	html: `<div class="pin ${big ? "big" : ""} ${e.where === "campus" ? "approx" : ""}" style="${big ? "" : `border-color:${sure(e) ? "var(--tomato)" : "var(--sun)"}`}">${catOf(e).em}</div>` });
const meIcon = () => L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

// ---------- router
function parse() {
	const h = location.hash.replace(/^#\/?/, "");
	const [name = "", id] = h.split("/");
	return { name, id: id && decodeURIComponent(id) };
}
let current = null;
function route() {
	const r = parse();
	const homeish = (n) => n === "" || n === "e" || n === "map";
	$$(".tabs a, .tabbar a").forEach((a) => a.classList.toggle("on", a.dataset.tab === ({ "": "events", e: "events", map: "map", event: "events", go: "events", campus: "campuses", campuses: "campuses", saved: "saved" })[r.name]));
	if (current && homeish(current.name) && homeish(r.name) && (current.name === "map") === (r.name === "map") && homePage.alive) {
		current = r;
		homePage.select(r.name === "e" ? r.id : null);
		return;
	}
	for (const fn of cleanups.splice(0)) try { fn(); } catch {}
	$("#crumb").hidden = true;
	current = r;
	view.className = r.name === "map" ? "view-map" : "";
	if (homeish(r.name)) homePage.render(r.name === "e" ? r.id : null);
	else if (r.name === "event") eventPage(r.id);
	else if (r.name === "campus") campusPage(r.id);
	else if (r.name === "campuses") campusesPage();
	else if (r.name === "saved") savedPage();
	else if (r.name === "go") goPage(r.id);
	else location.hash = "#/";
	refreshIcons();
	window.scrollTo(0, 0);
}

// =====================================================================
// Home
// =====================================================================
const homePage = {
	alive: false, map: null, cluster: null, markers: new Map(), meMarker: null,
	scoped() {
		const q = S.q.trim().toLowerCase();
		const base = S.events.filter((e) => sure(e) && (!q || `${e.title} ${e.location} ${e.org ?? ""} ${e.desc} ${shortOf(e.uni)}`.toLowerCase().includes(q)));
		this.fallbackUni = null;
		if (S.scope === "near" && S.me) {
			const near = base.filter((e) => !e.online && (distOf(e) ?? 1e9) <= NEAR_KM);
			if (near.length) return near;
			// Nothing within reach: show the closest campus that has free food, and say how far it is.
			const up = new Set(base.filter((e) => !status(e).ended).map((e) => e.uni));
			const u = nearestUnis(S.me, 70).find((x) => up.has(x.u.id));
			this.fallbackUni = u ?? null;
			return u ? base.filter((e) => e.uni === u.u.id) : [];
		}
		return base.filter((e) => !S.scope || S.scope === "near" || e.uni === S.scope);
	},
	// Rank what is worth going to now: the walk, the wait after arriving, and whether it is still on when you get there.
	recommend(list) {
		const now = Date.now();
		return list.map((e) => {
			const s = status(e);
			if (s.ended || e.online) return null;
			const start = Date.parse(e.start), end = e.end ? Date.parse(e.end) : start + 36e5;
			if (start > now + 7 * 864e5) return null; // the coming week; the wait below ranks sooner ones first
			const d = distOf(e), w = d == null ? null : walkMin(d);
			const travel = w ?? 25;
			if (s.live && (end - now) / 6e4 < travel + 10) return null; // over (or the food gone) before you'd get there
			const until = Math.max(0, (start - now) / 6e4);
			const wait = s.live ? 0 : Math.max(0, until - travel);
			const score = (w != null && w > 60 ? 60 + (w - 60) * 0.2 : travel) + wait * 0.2 + (e.allDay ? 90 : 0) - (perkOf(e) ? 6 : 0) - (e.where === "feed" ? 4 : 0);
			const why = [];
			if (w != null && w <= 60) why.push(`🚶 ${w} min walk`);
			else if (d != null) why.push(`📍 ${distText(d)} away`);
			if (s.live) why.push(`on now, ${minText((end - now) / 6e4)} left`);
			else if (until < 12 * 60) why.push(`starts ${s.text}`);
			else why.push(`${dayLabel(e, tzOf(e)).replace(/,.*/, "")} ${timeParts(e, tzOf(e)).t} ${timeParts(e, tzOf(e)).ap}`);
			if (w != null && !s.live && until > travel && until < 6 * 60) why.push(`leave by ${fmt(new Date(start - travel * 6e4).toISOString(), tzOf(e), { hour: "numeric", minute: "2-digit" })}`);
			if (perkOf(e)) why.push("“Free Food” ticked");
			return { e, score, why };
		}).filter(Boolean).sort((a, b) => a.score - b.score)
			// A series (the same event on several days) counts once: its best day.
			.filter((r, i, all) => all.findIndex((x) => x.e.title === r.e.title && x.e.uni === r.e.uni) === i);
	},
	list() {
		const cat = S.cat && FOODS.find((f) => f.key === S.cat);
		return this.scoped().filter((e) => inWindow(e, S.when, tzOf(e)) && (!cat || foodsOf(e).some((f) => f.key === cat.key)));
	},
	render(openId) {
		if (this.map) { try { this.map.remove(); } catch {} this.map = null; }
		this.alive = true;
		onLeave(() => { this.alive = false; this.map = null; });
		if (!S.loaded) {
			view.innerHTML = `<div class="wrap"><div class="hero"><div><div class="sk" style="height:250px"></div></div><div class="sk" style="height:300px"></div></div><div class="main"><div class="list">${'<div class="sk" style="height:120px"></div>'.repeat(4)}</div><div class="sk" style="height:470px"></div></div></div>`;
			return;
		}
		// The page is drawn once; the hero, picks, list and map are then refilled in place by update().
		view.innerHTML = `
			<div class="wrap">
				<section class="hero"><div id="heroText"></div><div id="spotWrap"></div></section>
				<div id="picksWrap"></div>
				<section class="main">
					<div class="listcol">
						<div class="listhead"><h2 id="listTitle"></h2>
							<div class="seg" id="when">${[["soon", "Soon"], ["today", "Today"], ["week", "This week"], ["all", "3 weeks"]].map(([v, l]) => `<button data-v="${v}" class="${S.when === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
						<div class="list" id="list"></div>
					</div>
					<div class="side">
						<div class="mapbox"><div class="map" id="homeMap"></div><div id="mapNote"></div><button class="locate" id="locate" title="Show where I am">${icon("locate-fixed")}</button><div id="peekWrap"></div></div>
						<div id="boardWrap">${this.board()}</div>
					</div>
				</section>
			</div>`;
		this.drawMap();
		this.update({ recenter: true });
		this.wire();
		if (openId) this.select(openId);
	},
	update({ recenter = false } = {}) {
		if (!$("#heroText")) return;
		const scoped = this.scoped();
		const near = S.scope === "near" && S.me;
		const around = near ? (this.fallbackUni ?? nearestUnis(S.me, 1)[0]) : null;
		const tz = near ? around?.u.tz : S.scope && S.scope !== "near" ? S.byUni[S.scope]?.tz : undefined;
		const now = Date.now();
		const onNow = scoped.filter((e) => { const s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5; return !e.allDay && s <= now + 3 * 36e5 && end >= now; });
		const next = scoped.filter((e) => !status(e).ended).sort((a, b) => a.start.localeCompare(b.start))[0];
		const recs = (this.recs = this.recommend(scoped));
		const walkable = recs.filter((r) => { const w = walkOf(r.e); return w != null && w <= 20 && Date.parse(r.e.start) < now + 3 * 36e5; });
		const first = recs[0]?.e;
		const when = (e) => `${/^(Today|Tomorrow)$/.test(dayLabel(e, tzOf(e))) ? dayLabel(e, tzOf(e)).toLowerCase() : `on ${dayLabel(e, tzOf(e)).replace(/,.*/, "")}`} at ${timeParts(e, tzOf(e)).t} ${timeParts(e, tzOf(e)).ap}`;
		const head = near && this.fallbackUni
			? `Hungry? The closest free food<span>is at ${esc(this.fallbackUni.u.short ?? this.fallbackUni.u.name)}, ${distText(this.fallbackUni.d)} away.</span>`
			: near && walkable.length
			? `Hungry? ${walkable.length} free meal${walkable.length === 1 ? "" : "s"}<span>within a 20-minute walk.</span>`
			: near && first
			? `Hungry? Your closest free meal<span>is ${walkOf(first) && walkOf(first) <= 60 ? `a ${walkOf(first)}-minute walk` : `${distText(distOf(first))} away`}, ${when(first).replace(/^on /, "")}.</span>`
			: onNow.length
			? `Hungry? ${onNow.length} free meal${onNow.length === 1 ? "" : "s"}<span>${onNow.length === 1 ? "is" : "are"} on right now.</span>`
			: next ? `Hungry? The next free meal<span>is ${when(next)}.</span>` : `Hungry?<span>Nothing listed here yet.</span>`;
		const week = scoped.filter((e) => inWindow(e, "week", tzOf(e)));
		const chips = FOODS.map((f) => ({ ...f, n: week.filter((e) => foodsOf(e).some((x) => x.key === f.key)).length })).filter((f) => f.n).sort((a, b) => b.n - a.n).slice(0, 7);
		$("#heroText").innerHTML = `
			<span class="pill kicker">${near ? `📍 Near you${around ? ` · around ${esc(around.u.short ?? around.u.name)}` : ""}` : `🔥 ${fmt(new Date().toISOString(), tz, { weekday: "long" })}`} · ${fmt(new Date().toISOString(), tz, { hour: "numeric", minute: "2-digit" })} ${tz ? "local" : "your time"}</span>
			<h1 class="headline">${head}</h1>
			<p class="sub">We read the event calendars of ${S.unis.length} top universities every 3 hours and keep the ones that feed you.</p>
			${this.locbar()}
			<div class="chips">
				<label class="chip scope-chip">${icon("map-pin")}<select id="scope" aria-label="Campus">${scopeOptions()}</select></label>
				${chips.map((c) => `<button class="chip ${S.cat === c.key ? "on" : ""}" data-cat="${c.key}"><span>${c.em}</span>${c.label}<span class="n">${c.n}</span></button>`).join("")}
			</div>`;
		$("#spotWrap").innerHTML = first ? this.spot(first, near ? recs[0].why : null) : next ? this.spot(this.pickSpot(scoped) ?? next) : "";
		$("#picksWrap").innerHTML = (near || S.scope) && recs.length > 1 ? `<section class="picks"><div class="listhead"><h2>${near ? "Picked for you" : `Picked at ${esc(shortOf(S.scope))}`}</h2><span class="aside-note">ranked by ${near ? "walk, wait, and whether it's still on when you arrive" : "how soon it starts"}</span></div>
			<div class="pickrow">${recs.slice(1, 4).map((r) => this.pick(r)).join("")}</div></section>` : "";
		$("#listTitle").textContent = near ? (this.fallbackUni ? `Coming up at ${this.fallbackUni.u.short ?? this.fallbackUni.u.name}` : "Coming up near you") : S.scope ? `Coming up at ${shortOf(S.scope)}` : "Coming up everywhere";
		this.drawList();
		if (recenter) this.recenter();
		refreshIcons();
	},
	recenter() {
		if (!this.map) return;
		const u = S.scope && S.scope !== "near" && S.byUni[S.scope];
		if (S.scope === "near" && S.me) this.map.setView([S.me.lat, S.me.lng], this.fallbackUni ? 12 : 14);
		else if (u?.lat) this.map.setView([u.lat, u.lng], 14);
		else this.map.setView([32, -40], 3);
		if (this.meMarker) { this.map.removeLayer(this.meMarker); this.meMarker = null; }
		if (S.me) this.meMarker = L.marker([S.me.lat, S.me.lng], { icon: meIcon(), zIndexOffset: 1000 }).addTo(this.map);
	},
	locbar() {
		if (S.me && S.scope === "near") return "";
		const why = S.scopeWhy === "timezone" && S.scope ? `Showing ${esc(shortOf(S.scope))} because your clock is on its time zone.` : "Share where you are to see what's close, with walking times.";
		return `<div class="locbar">${icon("locate")}<span>${why}</span><button class="btn sm primary" data-loc="gps">Use my location</button><button class="btn sm" data-loc="map">Pick on map</button></div>`;
	},
	pick(r) {
		const e = r.e, c = catOf(e);
		return `<button class="pick" data-open="${e.id}"><span class="tile" style="background:${c.soft}">${c.em}</span><span class="w"><b>${esc(e.title)}</b><small>${esc(shortOf(e.uni))}${e.location ? ` · ${esc(e.location)}` : ""}</small><span class="why">${r.why.slice(0, 3).map((x) => `<span class="tag t-plain">${esc(x)}</span>`).join("")}</span></span></button>`;
	},
	pickSpot(list) {
		const up = list.filter((e) => !status(e).ended && Date.parse(e.start) < Date.now() + 12 * 36e5);
		if (S.me) {
			const near = up.filter((e) => (distOf(e) ?? 99) < 5).sort((a, b) => a.start.localeCompare(b.start));
			if (near.length) return near[0];
		}
		return up.filter((e) => !e.allDay).sort((a, b) => a.start.localeCompare(b.start))[0];
	},
	spot(e, why) {
		const st = status(e), w = walkOf(e), c = catOf(e), tz = tzOf(e), tp = timeParts(e, tz);
		return `<article class="spot" data-open="${e.id}">
			<span class="pill next"><span class="dot"></span>${why ? `PICKED FOR YOU · ${st.live ? "ON NOW" : `STARTS ${st.text.toUpperCase()}`}` : st.live ? "HAPPENING NOW" : `NEXT UP · STARTS ${st.text.toUpperCase()}`}</span>
			<h2>${esc(e.title)}</h2>
			<div class="place">${esc(shortOf(e.uni))}${e.location ? ` · ${esc(e.location)}` : ""}${e.org ? ` · ${esc(e.org)}` : ""}</div>
			<div class="stats">
				<div class="stat"><b>${w ? `🚶 ${w} min` : `📍 ${esc(shortOf(e.uni))}`}</b><small>${w ? `${distText(distOf(e))} from you` : "campus"}</small></div>
				<div class="stat"><b>${c.em} ${c.label}</b><small>free food, confirmed</small></div>
				<div class="stat"><b>${tp.t}${tp.ap ? ` ${tp.ap}` : ""}</b><small>${e.end ? `to ${fmt(e.end, tz, { hour: "numeric", minute: "2-digit" })}` : dayLabel(e, tz)}</small></div>
			</div>
			<div class="buttons">
				<a class="spot-go" href="#/go/${e.id}">${icon("navigation")}Take me there</a>
				<button class="save ${isSaved(e.id) ? "on" : ""}" data-save="${e.id}">${icon("heart")}Save</button>
			</div>
			<div class="sticker"><div><b>FREE</b><small>really!</small></div></div>
		</article>`;
	},
	card(e) {
		const st = status(e), w = walkOf(e), c = catOf(e), tz = tzOf(e), tp = timeParts(e, tz);
		const foods = foodsOf(e).slice(0, 1);
		return `<button class="ev ${S.sel === e.id ? "sel" : ""}" data-open="${e.id}">
			<span class="tile" style="background:${c.soft}">${c.em}</span>
			<span>
				<span class="when"><b>${tp.t}${tp.ap ? ` ${tp.ap}` : ""}</b>${st.live ? `<span class="tag t-live">● LIVE</span>` : `<span>${st.text}</span>`}${S.scope ? "" : `<span>· ${esc(shortOf(e.uni))}</span>`}</span>
				<h4>${esc(e.title)}</h4>
				<span class="place">${e.online ? "💻 Online" : esc(e.location || "On campus")}${e.org ? ` · ${esc(e.org)}` : ""}</span>
				<span class="tags"><span class="tag t-mint">${icon("check")}${foods.length && foods[0].key !== "snacks" ? `${foods[0].label} provided` : "Free food"}</span>${w ? `<span class="tag t-sky">🚶 ${w} min</span>` : ""}</span>
			</span>
			<span class="heart ${isSaved(e.id) ? "on" : ""}" data-save="${e.id}" role="button" aria-label="Save">${icon("heart")}</span>
		</button>`;
	},
	drawList() {
		let list = this.list();
		// Nothing soon? Widen the window by itself (soon, then today, then this week), unless the person picked it.
		if (!list.length && !this.picked) {
			for (const w of ["today", "week", "all"].slice(["soon", "today", "week"].indexOf(S.when) + 1)) {
				S.when = w;
				list = this.list();
				if (list.length) { $$("#when button").forEach((b) => b.classList.toggle("on", b.dataset.v === w)); break; }
			}
		}
		if (S.me && S.when === "soon") list.sort((a, b) => (distOf(a) ?? 1e9) - (distOf(b) ?? 1e9));
		const box = $("#list");
		if (!list.length) {
			box.innerHTML = `<div class="empty"><div class="e">🍽️</div><b>No free food ${S.when === "soon" ? "in the next few hours" : "in this window"}</b>${S.when !== "all" ? `<button class="btn sm" data-widen>Show the next 3 weeks</button>` : "Try another campus."}</div>`;
		} else {
			const limit = this.limit ?? 40;
			let html = "", day = "";
			for (const e of list.slice(0, limit)) {
				const d = S.me && S.when === "soon" ? "" : dayLabel(e, tzOf(e));
				if (d && d !== day) { day = d; html += `<div class="day"><span>${esc(d)}</span></div>`; }
				html += this.card(e);
			}
			if (list.length > limit) html += `<button class="btn more" data-more>Show ${Math.min(40, list.length - limit)} more of ${list.length}</button>`;
			box.innerHTML = html;
		}
		refreshIcons();
		this.drawPins(list);
	},
	drawMap() {
		const map = (this.map = makeMap($("#homeMap")));
		this.cluster = L.markerClusterGroup({ maxClusterRadius: 44, showCoverageOnHover: false });
		map.addLayer(this.cluster);
		map.on("click", (ev) => {
			if (!this.picking) return;
			this.picking = false;
			setMe(ev.latlng.lat, ev.latlng.lng);
			setScope("near");
			toast("Got it: showing free food near here");
			this.update({ recenter: true });
		});
	},
	drawPins(list) {
		if (!this.map) return;
		this.cluster.clearLayers();
		this.markers.clear();
		const layers = [];
		for (const e of list) {
			if (!e.lat || e.online) continue;
			const m = L.marker([e.lat, e.lng], { icon: pinIcon(e, S.sel === e.id), riseOnHover: true });
			m.on("click", () => this.open(e.id));
			layers.push(m);
			this.markers.set(e.id, m);
		}
		this.cluster.addLayers(layers);
	},
	open(id) {
		if (narrow() && current?.name !== "map") { location.hash = `#/event/${id}`; return; }
		location.hash = current?.name === "map" ? `#/map` : `#/e/${id}`;
		if (current?.name === "map") this.select(id);
	},
	select(id) {
		const prev = S.sel;
		S.sel = id;
		$$(".ev.sel").forEach((n) => n.classList.remove("sel"));
		for (const pid of [prev, id]) {
			const m = this.markers.get(pid), e = S.events.find((x) => x.id === pid);
			if (m && e) m.setIcon(pinIcon(e, pid === id));
		}
		const crumb = $("#crumb"), peek = $("#peekWrap"), note = $("#mapNote");
		if (this.route) { this.map?.removeLayer(this.route); this.route = null; }
		if (!id) { crumb.hidden = true; peek.innerHTML = ""; note.innerHTML = ""; return; }
		const e = S.events.find((x) => x.id === id);
		if (!e) { location.hash = `#/event/${id}`; return; }
		$(`.ev[data-open="${id}"]`)?.classList.add("sel");
		$(`.ev[data-open="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		crumb.hidden = false;
		crumb.innerHTML = `${icon("mouse-pointer-click")}<a href="#/">Events</a><span class="sep">›</span><b>${esc(e.title)}</b><span class="note">opened here: the list and map stay where they were</span><button class="close" data-close>${icon("x")}Close</button>`;
		const w = walkOf(e), c = catOf(e), tp = timeParts(e, tzOf(e));
		peek.innerHTML = `<div class="peek" role="dialog" aria-label="${esc(e.title)}">
			<div class="head"><span class="tile" style="background:${c.soft}">${c.em}</span>
				<div class="names"><b>${esc(e.title)}</b><small>${tp.t}${tp.ap ? ` ${tp.ap}` : ""}${w ? ` · 🚶 ${w} min` : ` · ${esc(shortOf(e.uni))}`} · free food</small></div>
				<button class="x" data-close aria-label="Close">${icon("x")}</button></div>
			${!e.online && e.lat ? `<a class="btn primary" href="#/go/${e.id}">${icon("navigation")}Take me there</a>` : ""}
			<div class="row"><a class="btn" href="#/event/${e.id}">${icon("info")}More info</a><a class="btn" href="#/campus/${e.uni}">${icon("school")}More from ${esc(shortOf(e.uni))}</a></div>
		</div>`;
		if (S.me && e.lat && w) {
			note.innerHTML = `<div class="map-note"><b>🚶 ${w} min · ${distText(distOf(e))}</b><span class="ok">${(() => { const lv = Date.parse(e.start) - w * 6e4; return lv > Date.now() ? `Leave by ${fmt(new Date(lv).toISOString(), tzOf(e), { hour: "numeric", minute: "2-digit" })} to be there at the start` : "Go now: it has started"; })()}</span></div>`;
			this.route = L.polyline([[S.me.lat, S.me.lng], [e.lat, e.lng]], { color: "#ff5a3c", weight: 5, dashArray: "8 10" }).addTo(this.map);
		} else note.innerHTML = "";
		refreshIcons();
		const m = this.markers.get(id);
		if (m) this.cluster.zoomToShowLayer(m, () => this.map.panTo([e.lat, e.lng]));
		else if (e.lat) this.map.flyTo([e.lat, e.lng], 16);
	},
	board() {
		const now = Date.now(), c = {};
		for (const e of S.events) if (sure(e) && Date.parse(e.start) >= now - 36e5 && Date.parse(e.start) < now + 7 * 864e5) c[e.uni] = (c[e.uni] ?? 0) + 1;
		const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5);
		const max = top[0]?.[1] ?? 1, cols = ["var(--tomato)", "var(--sun)", "var(--mint)", "var(--grape)", "var(--sky)"], medals = ["🥇", "🥈", "🥉", "4", "5"];
		return `<div class="card board"><h3>🏆 Best-fed campuses this week<span class="aside">events with free food</span></h3>
			${top.map(([u, n], i) => `<a class="rank" href="#/campus/${u}"><span class="medal">${medals[i]}</span><b>${esc(shortOf(u))}</b><span class="track"><span class="bar" style="display:block;width:${Math.round((100 * n) / max)}%;background:${cols[i]}"></span></span><span class="n">${n}</span></a>`).join("")}</div>`;
	},
	wire() {
		view.onclick = (ev) => {
			const save = ev.target.closest("[data-save]");
			if (save) { ev.preventDefault(); ev.stopPropagation(); const e = S.events.find((x) => x.id === save.dataset.save); if (e) toggleSave(e); return; }
			if (ev.target.closest("a")) return;
			const cat = ev.target.closest("[data-cat]");
			if (cat) { S.cat = S.cat === cat.dataset.cat ? null : cat.dataset.cat; this.limit = 40; this.update(); return; }
			const loc = ev.target.closest("[data-loc]");
			if (loc) { loc.dataset.loc === "gps" ? this.locateMe() : this.pickOnMap(); return; }
			if (ev.target.closest(".scope-chip")) return;
			const w = ev.target.closest("#when button");
			if (w) { this.picked = true; S.when = w.dataset.v; store.setItem("when", S.when); $$("#when button").forEach((b) => b.classList.toggle("on", b === w)); this.limit = 40; this.drawList(); return; }
			if (ev.target.closest("[data-widen]")) { this.picked = true; S.when = "all"; $$("#when button").forEach((b) => b.classList.toggle("on", b.dataset.v === "all")); this.drawList(); return; }
			if (ev.target.closest("[data-more]")) { this.limit = (this.limit ?? 40) + 40; this.drawList(); return; }
			if (ev.target.closest("[data-close]")) { location.hash = "#/"; return; }
			if (ev.target.closest("#locate")) { this.locateMe(); return; }
			const open = ev.target.closest("[data-open]");
			if (open) this.open(open.dataset.open);
		};
		// The campus filter beside the food chips: refills the hero, picks, list and map in place.
		view.onchange = async (ev) => {
			if (ev.target.id !== "scope") return;
			const v = ev.target.value;
			if (v === "near" && !S.me && !(await locate())) { this.pickOnMap(); ev.target.value = S.scope; return; }
			setScope(v);
			if (location.hash.startsWith("#/e/")) history.replaceState(null, "", "#/");
			this.select(null);
			this.limit = 40;
			this.update({ recenter: true });
		};
		$("#crumb").onclick = (ev) => { if (ev.target.closest("[data-close]")) location.hash = "#/"; };
		onLeave(() => { view.onclick = null; view.onchange = null; $("#crumb").onclick = null; });
	},
	async locateMe() {
		if (await locate()) { setScope("near"); toast("Showing free food near you"); this.update({ recenter: true }); }
		else this.pickOnMap();
	},
	pickOnMap() {
		this.picking = true;
		if (narrow() && current?.name !== "map") location.hash = "#/map";
		toast("Tap the map where you are", 5000);
		$(".mapbox")?.scrollIntoView({ behavior: "smooth", block: "center" });
	},
};

// =====================================================================
// Event page
// =====================================================================
async function eventPage(id) {
	view.innerHTML = `<div class="wrap"><div class="detail"><div class="col"><div class="sk" style="height:220px"></div><div class="sk" style="height:300px"></div></div><div class="col"><div class="sk" style="height:420px"></div></div></div></div>`;
	let e;
	try { e = await getJson(`api/raw/${encodeURIComponent(id)}`); } catch { e = S.events.find((x) => x.id === id) ?? S.saved[id]; }
	if (current?.name !== "event" || current.id !== id) return;
	if (!e) { view.innerHTML = `<div class="wrap"><div class="empty"><div class="e">🫥</div><b>This event is no longer listed</b>It may have ended or been taken off its calendar. <a class="btn sm" href="#/">Back to events</a></div></div>`; return; }
	const u = uniOf(e), src = srcOf(e), plat = platformOf(src), st = src?.status, tz = tzOf(e), mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const s = status(e), w = walkOf(e), foods = foodsOf(e), f = e.food;
	const quote = (() => {
		const q = quoteOf(e);
		if (!f || q.length < 280) return q;
		const w0 = (f.words ?? []).find((x) => x !== "free food") ?? "";
		const i = Math.max(0, q.toLowerCase().indexOf(w0.toLowerCase()) - 120);
		return `${i ? "…" : ""}${q.slice(i, i + 300)}${i + 300 < q.length ? "…" : ""}`;
	})();
	const hist = st?.history ?? [];
	const maxEv = Math.max(1, ...hist.map((h) => h.events));
	const nextAt = st?.at ? st.at + 3 * 36e5 : null;
	const checks = [
		src && [isStudentFeed(src) ? `Listed by the organisers on ${esc(src.label ?? plat.name)}` : `Listed on ${esc(src.label ?? plat.name)}`, isStudentFeed(src) ? "Straight from the club's own page, not a re-post" : `${esc(u?.name ?? "")}'s own calendar`],
		f && (perkOf(e) ? ["“Free Food” perk is ticked", "The organisers tagged the event with food: the strongest signal there is"] : [`Says “${esc((f.words ?? [])[0] ?? "food")}” in its description`, f.level === "sure" ? "The words say food is provided, not for sale" : "Food is mentioned, but not said to be free", f.level !== "sure"]),
		e.online ? ["Online event", "There's no place to go to"] : e.where === "feed" ? ["Exact room on the map", "The calendar gave coordinates for it"] : e.where === "osm" ? ["Building found on the map", "Matched by name on OpenStreetMap; check the room"] : ["Only the campus is known", "The pin sits at the campus centre: check the room", true],
		st?.at && [`Still on the calendar at ${fmt(new Date(st.at).toISOString(), undefined, { hour: "numeric", minute: "2-digit" })}`, "Cancelled events drop off at the next check"],
	].filter(Boolean);
	const emos = (foods.length ? foods : [catOf(e)]).slice(0, 3).map((x) => x.em);
	view.innerHTML = `<div class="wrap">
		<div class="crumbs"><a class="back" href="#/${S.sel === e.id ? `e/${e.id}` : ""}">${icon("arrow-left")}Back to events</a>
			<a class="link" href="#/">Events</a><span class="sep">›</span><a class="link" href="#/campus/${e.uni}">${esc(u?.name ?? e.uni)}</a><span class="sep">›</span><span>${esc(e.title)}</span></div>
		<div class="detail">
			<div class="col">
				<div class="banner-art">${e.image ? `<img src="${esc(e.image)}" alt="">` : ""}
					${e.image ? "" : emos.map((x, i) => `<span class="emo" style="left:${60 + i * 160}px;top:${[50, 90, 36][i]}px;transform:rotate(${[12, -10, 6][i]}deg)">${x}</span>`).join("")}
					${s.ended ? `<span class="pill">Ended</span>` : `<span class="pill">● ${s.live ? "Happening now" : `Starts ${s.text}`}</span>`}
					${e.image ? `<span class="pill src">${icon("image")}Flyer from ${esc(src?.label ?? plat.name)}</span>` : ""}</div>
				<div><div class="host">${esc(e.org ?? src?.label ?? u?.name ?? "")}</div>
					<h1 class="title-xl">${esc(e.title)}</h1>
					<div class="actions" style="gap:8px">${f ? `<span class="pill ${f.level === "sure" ? "t-mint" : "t-sun"}">${icon("check")}${f.level === "sure" ? "Free food, confirmed" : "Food likely"}</span>` : ""}${foods.slice(0, 2).map((x) => `<span class="pill t-sun">${x.em} ${x.label}</span>`).join("")}${e.online ? `<span class="pill t-sky">💻 Online</span>` : ""}</div></div>
				<div class="card facts">
					<div class="fact"><span class="ib">${icon("calendar-clock")}</span><div><b>${fmt(e.start, tz, { weekday: "long", month: "long", day: "numeric" })} · ${range(e, tz)}</b>${tz && tz !== mine && !e.allDay ? `<small>${fmt(e.start, mine, { weekday: "short", hour: "numeric", minute: "2-digit" })} your time</small>` : ""}</div></div>
					<div class="fact"><span class="ib">${icon("map-pin")}</span><div><b>${e.online ? "Online" : esc(e.location || "Location not given")}</b><small>${e.where === "feed" ? "Pin from the calendar itself" : e.where === "osm" ? "Building found on the map" : e.online ? "" : "Exact building unknown: the pin is the campus centre"}${w ? ` · 🚶 ${w} min, ${distText(distOf(e))} from you` : ""}</small></div></div>
					${e.org ? `<div class="fact"><span class="ib">${icon("users")}</span><div><b>${esc(e.org)}</b><small>Host</small></div></div>` : ""}
				</div>
				${f ? `<div class="card evidence ${f.level === "sure" ? "" : "likely"}"><h3>${icon("sparkles")}Why we say there's ${f.level === "sure" ? "free food" : "probably food"}</h3>
					<blockquote>“${highlight(quote, (f.words ?? []).filter((x) => x !== "free food"))}”</blockquote>
					<div class="sig">${perkOf(e) ? `<span class="tag">${icon("badge-check")}“Free Food” perk ticked by organisers</span>` : ""}<span class="tag">Matched: ${esc((f.words ?? []).slice(0, 3).join(" · "))}</span></div></div>` : ""}
				<div class="actions">
					${!e.online && e.lat ? `<a class="btn primary" href="#/go/${e.id}">${icon("navigation")}Take me there${w ? ` · ${w} min` : ""}</a>` : ""}
					<a class="btn" href="api/ics/${e.id}">${icon("calendar-plus")}Add to calendar</a>
					${e.url ? `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">${icon("external-link")}Open on ${esc(src?.label?.split(/[(·]/)[0].trim() ?? plat.name)}</a>` : ""}
					<button class="btn" data-save="${e.id}" style="width:52px;padding:0">${icon("heart")}</button>
				</div>
				${e.desc ? `<div class="card"><h3>About</h3><div class="about">${esc(e.desc)}</div></div>` : ""}
			</div>
			<div class="col">
				<div class="card">
					<h3>Where this comes from<span class="aside">${st ? (st.ok ? `<span class="pill t-mint" style="padding:3px 10px"><span class="dot"></span>Live</span>` : `<span class="pill t-live" style="padding:3px 10px">Last check failed</span>`) : ""}</span></h3>
					<div class="feedrow"><span class="logo-sq" style="width:44px;height:44px;background:${plat.color}">${plat.letter}</span><div><b>${esc(src?.label ?? e.src)}</b><small>${esc(plat.desc)}</small></div></div>
					<div class="label">Scraped from</div>
					<a class="url" href="${esc(e.srcUrl ?? "#")}" target="_blank" rel="noopener">${icon("radio-tower")}${esc(shortUrl(e.srcUrl ?? ""))}</a>
					${e.url ? `<div class="label">This event on the source</div><a class="url" href="${esc(e.url)}" target="_blank" rel="noopener">${icon("link")}<span>${esc(shortUrl(e.url))}</span>${icon("arrow-up-right", "out")}</a>` : ""}
					<a class="campus-link" href="#/campus/${e.uni}">${icon("school")}<span>All of ${esc(shortOf(e.uni))}'s sources, and what we tried</span>${icon("chevron-right")}</a>
				</div>
				${st ? `<div class="card fresh"><h3>Checked ${ago(st.at)}<span class="aside">${nextAt ? `next check ${fmt(new Date(nextAt).toISOString(), undefined, { hour: "numeric", minute: "2-digit" })}` : ""}</span></h3>
					<div class="bars">${hist.map((h, i) => `<i class="${!h.ok ? "bad" : i === hist.length - 1 ? "last" : ""}" style="height:${h.ok ? 30 + (70 * h.events) / maxEv : 100}%" title="${new Date(h.at).toLocaleString()}: ${h.ok ? `${h.events} events` : "failed"}"></i>`).join("") || "<i class='last' style='height:100%'></i>"}</div>
					<div class="axis"><span>${hist.length > 1 ? ago(hist[0].at) : ""}</span><span>${Math.max(1, hist.length)} check${hist.length > 1 ? "s" : ""},${hist.every((h) => h.ok) ? "all OK" : `${hist.filter((h) => !h.ok).length} failed`} · ${st.events ?? 0} events in this feed</span><span>now</span></div></div>` : ""}
				<div class="card"><h3>What we checked</h3><div class="checks">${checks.map(([b, s2, warn]) => `<div class="check"><span class="tick ${warn ? "warn" : ""}">${icon(warn ? "alert-triangle" : "check")}</span><div><b>${b}</b><small>${s2}</small></div></div>`).join("")}</div></div>
				<div class="report"><span style="font-size:22px">🙋</span><div class="w"><b>Was there food?</b><small id="fbText">Tell others after you go</small></div><button data-fb="1">👍 Yes</button><button data-fb="0">👎 Ran out</button></div>
			</div>
		</div></div>`;
	$$(`[data-save="${e.id}"]`).forEach((b) => b.classList.toggle("on", isSaved(e.id)));
	refreshIcons();
	const fbText = $("#fbText");
	// One answer per visitor: yours is marked, and tapping the other one changes it.
	const showFb = (c) => {
		if (!c) return;
		if (c.yes + c.no) fbText.textContent = `${c.yes} said yes · ${c.no} said it ran out${c.mine ? ` · you said ${c.mine === "yes" ? "yes" : "it ran out"}` : ""}`;
		$$("[data-fb]").forEach((b) => { b.disabled = false; b.classList.toggle("on", (b.dataset.fb === "1") === (c.mine === "yes") && !!c.mine); });
	};
	getJson(`api/feedback?id=${e.id}`).then(showFb, () => {});
	$(".banner-art img")?.addEventListener("error", (ev) => ev.target.remove());
	view.onclick = async (ev) => {
		const sv = ev.target.closest("[data-save]");
		if (sv) { toggleSave(e); return; }
		const fb = ev.target.closest("[data-fb]");
		if (fb) {
			$$("[data-fb]").forEach((b) => (b.disabled = true));
			try { showFb(await getJson("api/feedback", { method: "POST", body: JSON.stringify({ id: e.id, yes: fb.dataset.fb === "1" }) })); toast("Thanks, that helps the next person"); }
			catch (err) { toast(err.message); $$("[data-fb]").forEach((b) => (b.disabled = false)); }
		}
	};
	onLeave(() => (view.onclick = null));
}

// =====================================================================
// Campus page
// =====================================================================
// The notes kept when each campus's feeds were found, minus the sentences only a programmer needs.
const plainNotes = (t = "") => t.split(/(?<=[.;])\s+/).filter((s) => s && !/lib\/|\.js\b|\(\)|fetcher|\bfields?\b|\bjson\b|array|[<{}]|param|per_page|endsAfter|scrape/i.test(s)).join(" ").trim();
async function campusPage(id) {
	const u = S.byUni[id];
	if (!u) { view.innerHTML = S.loaded ? `<div class="wrap"><div class="empty"><b>No such campus</b><a class="btn sm" href="#/campuses">All campuses</a></div></div>` : ""; return; }
	view.innerHTML = `<div class="chero"><div class="inner"><h1>${esc(u.name)}</h1></div></div><div class="wrap"><div class="cbody"><div class="col"><div class="sk" style="height:220px"></div></div><div class="col"><div class="sk" style="height:300px"></div></div></div></div>`;
	let all = [];
	try { all = (await getJson(`api/events?food=all&uni=${id}`)).events; } catch {}
	if (current?.name !== "campus" || current.id !== id) return;
	const now = Date.now(), wk = all.filter((e) => Date.parse(e.start) >= now - 36e5 && Date.parse(e.start) < now + 7 * 864e5);
	const food = wk.filter(sure);
	const feeds = [...u.sources].sort((a, b) => (b.status?.food ?? 0) - (a.status?.food ?? 0));
	const live = feeds.filter((f) => f.status?.ok).length;
	const last = Math.max(0, ...feeds.map((f) => f.status?.at ?? 0));
	const totalFood = feeds.reduce((a, f) => a + (f.status?.food ?? 0), 0);
	const tz = u.tz;
	// free food per day, from today
	const days = Array.from({ length: 7 }, (_, i) => { const t = now + i * 864e5; return { key: fmt(new Date(t).toISOString(), tz, { year: "numeric", month: "2-digit", day: "2-digit" }), label: fmt(new Date(t).toISOString(), tz, { weekday: "short" }), n: 0 }; });
	for (const e of food) { const k = fmt(e.start, tz, { year: "numeric", month: "2-digit", day: "2-digit" }); const d = days.find((x) => x.key === k); if (d) d.n++; }
	const maxDay = Math.max(1, ...days.map((d) => d.n));
	const tally = (key) => { const c = {}; for (const e of food) { const k = key(e); if (k) c[k] = (c[k] ?? 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5); };
	const hosts = tally((e) => (e.org ?? "").replace(/ - All-University| at [A-Z][\w ]+$/g, "").trim());
	const bldgs = tally((e) => (e.online ? "" : (e.location ?? "").split(/,| - | Room | Rm /)[0].trim())).slice(0, 4);
	const pins = { feed: 0, osm: 0, campus: 0 };
	for (const e of food) if (!e.online) pins[e.where === "feed" ? "feed" : e.where === "osm" ? "osm" : "campus"]++;
	const pinTotal = Math.max(1, pins.feed + pins.osm + pins.campus);
	const nextUp = food.filter((e) => !status(e).ended).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4);
	const entry = (f, top) => {
		const p = platformOf(f), st = f.status, hist = st?.history ?? [], max = Math.max(1, ...hist.map((h) => h.events));
		return `<div class="entry ${top ? "best" : ""}">
			<div class="head"><span class="logo-sq" style="width:46px;height:46px;background:${p.color}">${p.letter}</span>
				<div class="names"><b>${esc(f.label ?? p.name)}</b><small>${esc(p.desc)}${f.institute ? " · institute" : ""}</small></div>
				${top ? `<span class="pill" style="background:var(--grape);color:#fff">Most free food</span>` : ""}
				${st ? (st.ok ? `<span class="pill t-mint"><span class="dot"></span>Live</span>` : /robots/.test(st.error ?? "") ? `<span class="pill t-sun">Paused</span>` : `<span class="pill t-live">Failing</span>`) : `<span class="pill t-plain">Not checked yet</span>`}</div>
			<a class="url" href="${esc(f.url)}" target="_blank" rel="noopener">${icon("radio-tower")}<span>${esc(shortUrl(f.url))}</span>${icon("copy", "out")}</a>
			<div class="nums">
				<div class="num"><b>${st?.events ?? "–"}</b><small>events read</small></div>
				<div class="num"><b>${st?.food ?? "–"}</b><small>with free food</small></div>
				<div class="num"><b>${st?.ms ? `${(st.ms / 1000).toFixed(1)} s` : "–"}</b><small>to read</small></div>
				<div class="num"><b>${st?.at ? ago(st.at) : "–"}</b><small>last checked</small></div>
				${hist.length ? `<div class="spark"><div class="bars">${hist.map((h, i) => `<i class="${!h.ok ? "bad" : i === hist.length - 1 ? "last" : ""}" style="height:${h.ok ? 25 + (75 * h.events) / max : 100}%;background:${p.color}"></i>`).join("")}</div><small>${hist.length === 1 ? "first check" : `last ${hist.length} checks`}</small></div>` : ""}
			</div>
			${st && !st.ok ? (/robots/.test(st.error ?? "")
				? `<div class="note">${icon("pause-circle")}Paused: this site asks bots not to read this calendar, so we stopped. Events we already had stay up until they end.</div>`
				: `<div class="note bad">${icon("alert-triangle")}Last check failed: ${esc(st.error)}. We keep showing its last good events.</div>`) : ""}
		</div>`;
	};
	view.innerHTML = `
		<section class="chero"><div class="inner">
			<div class="row1"><a class="pill back" href="#/campuses">${icon("arrow-left")}All campuses</a><a class="pill follow" href="#/" data-scope="${id}">${icon("bell")}Show its free food</a></div>
			<div class="meta">${u.country === "US" ? "US" : u.country} #${u.rank} · ${esc(u.city ?? "")} · ${fmt(new Date().toISOString(), tz, { hour: "numeric", minute: "2-digit" })} local</div>
			<h1>${esc(u.name)}</h1>
			<div class="tagline">${feeds.length ? `Free food this week, read live from ${feeds.length} public calendar${feeds.length === 1 ? "" : "s"}` : "We haven't found an open calendar for this campus yet"}</div>
			<div class="stats">
				<div class="stat"><b>${food.length}</b><small>free-food events this week</small></div>
				<div class="stat"><b>${wk.length}</b><small>events read this week</small></div>
				<div class="stat"><b>${live} / ${feeds.length}</b><small>entry points live</small></div>
				<div class="stat"><b>${last ? ago(last).replace(" ago", "") : "–"}</b><small>since the last check</small></div>
			</div></div></section>
		<div class="wrap"><div class="cbody">
			<div class="col">
				<div><h2 class="sec-title">📡 Live scraping entry points</h2><p class="sec-sub">Where we read ${esc(u.short ?? u.name)}'s events, how often, and what came back the last time we looked. Every 3 hours, public calendars only.</p></div>
				${feeds.map((f, i) => entry(f, i === 0 && (f.status?.food ?? 0) > 0 && totalFood > 0 && feeds.length > 1)).join("") || `<div class="empty"><div class="e">🔎</div><b>No open calendar yet</b></div>`}
				${plainNotes(u.notes) ? `<h3 class="sec-sub" style="font-weight:800;color:var(--muted);margin-top:6px">What we tried</h3><div class="tried">${icon("circle-slash")}<div>${esc(plainNotes(u.notes))}</div></div>` : ""}
				<div class="suggest"><span style="font-size:20px">🔎</span><div class="w"><b>Know a calendar we're missing?</b><small>A department, a dorm, a club list: paste its link and we'll look at it</small></div>
					<form id="suggest"><input name="url" type="url" placeholder="https://… (an events page, iCal or RSS link)" required /><button class="btn sm dark">Add a source</button></form></div>
			</div>
			<div class="col">
				<div class="card"><h3>🍽️ Next up at ${esc(u.short ?? u.name)}<a class="aside" href="#/" data-scope="${id}" style="color:var(--tomato);font-weight:800">See all ${food.length} →</a></h3>
					${nextUp.map((e) => { const c = catOf(e); return `<a class="nrow" href="#/event/${e.id}"><span class="tile" style="background:${c.soft}">${c.em}</span><span class="w"><small>${dayLabel(e, tz).replace(/,.*/, "")} ${timeParts(e, tz).t} ${timeParts(e, tz).ap}</small><b>${esc(e.title)}</b></span>${icon("chevron-right")}</a>`; }).join("") || `<div class="empty" style="padding:12px">Nothing confirmed this week yet.</div>`}</div>
				<div class="card"><h3>Free food this week<span class="aside">events per day</span></h3>
					<div class="week">${days.map((d) => `<div class="d ${d.n === maxDay && d.n ? "max" : ""}"><b>${d.n}</b><i style="height:${Math.max(4, (110 * d.n) / maxDay)}px"></i><small>${d.label}</small></div>`).join("")}</div></div>
				${hosts.length ? `<div class="card"><h3>🎁 Most generous hosts</h3>${hosts.map(([n, c]) => `<div class="kv"><span>${esc(n)}</span><span class="tag t-tomato">${c} event${c === 1 ? "" : "s"}</span></div>`).join("")}</div>` : ""}
				${bldgs.length ? `<div class="card"><h3>🏛️ Where the food shows up</h3>${bldgs.map(([n, c]) => `<div class="hbar"><span>${esc(n)}</span><span class="track"><i style="width:${(100 * c) / bldgs[0][1]}%"></i></span><b>${c}</b></div>`).join("")}</div>` : ""}
				${food.length ? `<div class="card"><h3>📍 How exact the map is</h3><div class="stack"><i style="flex:${pins.feed};background:var(--mint)"></i><i style="flex:${pins.osm};background:var(--sky)"></i><i style="flex:${pins.campus};background:var(--line-strong)"></i></div>
					<div class="legend"><span><i style="background:var(--mint)"></i>Exact room, from the calendar ${pins.feed}</span><span><i style="background:var(--sky)"></i>Found on the map ${pins.osm}</span><span><i style="background:var(--line-strong)"></i>Campus centre ${pins.campus}</span></div></div>` : ""}
			</div>
		</div></div>`;
	refreshIcons();
	view.onclick = (ev) => {
		const sc = ev.target.closest("[data-scope]");
		if (sc) setScope(sc.dataset.scope);
	};
	$("#suggest").onsubmit = async (ev) => {
		ev.preventDefault();
		const url = new FormData(ev.target).get("url");
		try { await getJson("api/suggest", { method: "POST", body: JSON.stringify({ uni: id, url }) }); ev.target.reset(); toast("Thanks: we'll take a look at it"); } catch (err) { toast(err.message); }
	};
	onLeave(() => (view.onclick = null));
}

// =====================================================================
// Campuses and saved
// =====================================================================
function campusesPage() {
	const now = Date.now(), c = {};
	for (const e of S.events) if (sure(e) && Date.parse(e.start) >= now - 36e5 && Date.parse(e.start) < now + 7 * 864e5) c[e.uni] = (c[e.uni] ?? 0) + 1;
	const feeds = S.unis.flatMap((u) => u.sources), ok = feeds.filter((f) => f.status?.ok).length;
	let region = store.getItem("region") || "all";
	const draw = () => {
		const q = S.q.trim().toLowerCase();
		const list = S.unis.filter((u) => (region === "all" || (region === "US") === (u.country === "US")) && (!q || `${u.name} ${u.short} ${u.city}`.toLowerCase().includes(q)));
		$("#grid").innerHTML = list.map((u) => `<a class="ccard ${u.sources.length ? "" : "none"}" href="#/campus/${u.id}">
			<div class="r1"><span class="rk">${u.country === "US" ? "US" : u.country} #${u.rank}</span><span class="feeds">${u.sources.map((f) => `<span class="dot" style="background:${f.status ? (f.status.ok ? "var(--mint)" : /robots/.test(f.status.error ?? "") ? "var(--sun)" : "var(--live)") : "var(--faint)"}" title="${esc(f.label ?? "")}"></span>`).join("")}</span></div>
			<h4>${esc(u.name)}</h4><span class="city">${esc(u.city ?? "")}</span>
			${u.sources.length ? `<div class="big">${c[u.id] ?? 0}<small>with free food this week</small></div><span class="city">${u.sources.length} source${u.sources.length === 1 ? "" : "s"}: ${[...new Set(u.sources.map((f) => platformOf(f).name))].join(", ")}</span>` : `<span class="city">No open calendar found yet</span>`}
		</a>`).join("");
	};
	view.innerHTML = `<div class="wrap">
		<div class="page-head"><div><h1>Campuses</h1><p>${S.unis.filter((u) => u.sources.length).length} of ${S.unis.length} campuses read live · ${ok} of ${feeds.length} calendars working · checked ${S.at ? ago(S.at) : "never"}</p></div>
			<div class="seg" id="region">${[["all", "All"], ["US", "United States"], ["world", "Rest of the world"]].map(([v, l]) => `<button data-v="${v}" class="${region === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
		<div class="grid" id="grid"></div></div>`;
	draw();
	$("#region").onclick = (ev) => { const b = ev.target.closest("button"); if (!b) return; region = b.dataset.v; store.setItem("region", region); $$("#region button").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
	campusesPage.redraw = draw;
	onLeave(() => (campusesPage.redraw = null));
}
function savedPage() {
	const list = Object.values(S.saved).sort((a, b) => a.start.localeCompare(b.start));
	const upcoming = list.filter((e) => !status(e).ended), past = list.filter((e) => status(e).ended);
	view.innerHTML = `<div class="wrap" style="max-width:760px">
		<div class="page-head"><div><h1>Saved</h1><p>Events you saved with ♥, kept in this browser.</p></div></div>
		<div class="list" style="padding-bottom:40px">${upcoming.map((e) => homePage.card(e)).join("") || `<div class="empty"><div class="e">💛</div><b>Nothing saved yet</b>Tap the heart on any event to keep it here.</div>`}
		${past.length ? `<div class="day"><span>Already over</span></div>${past.map((e) => homePage.card(e)).join("")}` : ""}</div></div>`;
	view.onclick = (ev) => {
		const sv = ev.target.closest("[data-save]");
		if (sv) { ev.stopPropagation(); toggleSave(S.saved[sv.dataset.save] ?? { id: sv.dataset.save }); savedPage(); refreshIcons(); return; }
		const o = ev.target.closest("[data-open]");
		if (o) location.hash = `#/event/${o.dataset.open}`;
	};
	onLeave(() => (view.onclick = null));
}

// =====================================================================
// Take me there
// =====================================================================
async function goPage(id) {
	let e = S.events.find((x) => x.id === id);
	if (!e) try { e = await getJson(`api/raw/${encodeURIComponent(id)}`); } catch {}
	if (!e || !e.lat) { view.innerHTML = `<div class="wrap"><div class="empty"><b>No place to go to for this event</b><a class="btn sm" href="#/event/${esc(id)}">Back to the event</a></div></div>`; return; }
	const src = srcOf(e), tz = tzOf(e), c = catOf(e);
	$("#crumb").hidden = false;
	$("#crumb").innerHTML = `${icon("navigation")}<a href="#/">Events</a><span class="sep">›</span><a href="#/event/${e.id}">${esc(e.title)}</a><span class="sep">›</span><b>Take me there</b>`;
	view.innerHTML = `<div class="wrap"><div class="go">
		<div class="map" id="goMap"></div>
		<div class="panel" id="goPanel"><div class="eta"><div><b>…</b><small>Finding a route</small></div></div></div>
		<div class="evcard"><div class="head"><span class="tile" style="background:${c.soft}">${c.em}</span><div><b>${esc(e.title)}</b><small>${range(e, tz)} · free ${c.label.toLowerCase()}</small></div></div>
			<div class="ok"><span class="dot"></span>Still on ${esc(src?.label?.split(/[(·]/)[0].trim() ?? "its calendar")} · checked ${src?.status?.at ? ago(src.status.at) : "recently"}</div>
			<div class="ping">${icon("refresh-cw")}The calendar is read again every 3 hours</div></div>
		<div class="bar">${[["foot", "footprints", "Walk"], ["bike", "bike", "Bike"], ["car", "car", "Drive"]].map(([m, ic, l]) => `<button data-mode="${m}" class="${S.mode === m ? "on" : ""}">${icon(ic)}${l}</button>`).join("")}<span class="div"></span><a class="btn sm dark end" href="#/event/${e.id}">${icon("x")}End</a></div>
		<div id="goHint"></div>
	</div></div>`;
	refreshIcons();
	const map = makeMap($("#goMap"));
	const dest = L.marker([e.lat, e.lng], { icon: pinIcon(e, true), zIndexOffset: 900 }).addTo(map).bindTooltip(esc(e.location || e.title), { permanent: true, direction: "bottom", offset: [0, 26] });
	let meM = null, line = null, casing = null, lastRoute = 0, lastPos = null, firstDist = null;
	const draw = async () => {
		if (!S.me) return;
		if (meM) meM.setLatLng([S.me.lat, S.me.lng]); else meM = L.marker([S.me.lat, S.me.lng], { icon: meIcon(), zIndexOffset: 1000 }).addTo(map);
		lastRoute = Date.now();
		lastPos = { ...S.me };
		const straight = km(S.me, e);
		const profile = { foot: "routed-foot/route/v1/foot", bike: "routed-bike/route/v1/bike", car: "routed-car/route/v1/driving" }[S.mode];
		let r = null;
		if (straight < 80) try { r = (await getJson(`https://routing.openstreetmap.de/${profile}/${S.me.lng},${S.me.lat};${e.lng},${e.lat}?overview=full&geometries=geojson&steps=true`)).routes?.[0]; } catch {}
		if (line) map.removeLayer(line); if (casing) map.removeLayer(casing);
		const coords = r ? r.geometry.coordinates.map(([x, y]) => [y, x]) : [[S.me.lat, S.me.lng], [e.lat, e.lng]];
		casing = L.polyline(coords, { color: "#ffffff", weight: 12, opacity: 0.95 }).addTo(map);
		line = L.polyline(coords, { color: "#ff5a3c", weight: 7, dashArray: r ? null : "8 10" }).addTo(map);
		map.fitBounds(line.getBounds(), { paddingTopLeft: narrow() ? [20, 20] : [420, 80], paddingBottomRight: narrow() ? [20, 280] : [360, 100] });
		const dist = r ? r.distance / 1000 : straight * 1.3;
		firstDist ??= dist;
		const mins = S.mode === "foot" ? (dist / 4.8) * 60 : r ? r.duration / 60 : (dist / (S.mode === "bike" ? 15 : 30)) * 60;
		const arrive = Date.now() + mins * 6e4, start = Date.parse(e.start), early = (start - arrive) / 6e4;
		const steps = (r?.legs?.[0]?.steps ?? []).filter((s) => s.distance > 0 || s.maneuver.type === "arrive");
		const stepIcon = (m) => m.type === "arrive" ? "flag" : m.type === "depart" ? "navigation" : /uturn/.test(m.modifier) ? "undo-2" : /sharp left|^left/.test(m.modifier) ? "corner-up-left" : /sharp right|^right/.test(m.modifier) ? "corner-up-right" : /slight left/.test(m.modifier) ? "arrow-up-left" : /slight right/.test(m.modifier) ? "arrow-up-right" : "arrow-up";
		const stepText = (s) => {
			const m = s.maneuver, name = s.name || "the path";
			if (m.type === "depart") return `Head ${["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(((m.bearing_after ?? 0) % 360) / 45) % 8]} on ${name}`;
			if (m.type === "arrive") return `${esc(e.location || "You're there")}${m.modifier && /left|right/.test(m.modifier) ? ` is on your ${m.modifier.includes("left") ? "left" : "right"}` : ""}`;
			if (m.type === "roundabout" || m.type === "rotary") return `At the roundabout, take ${name}`;
			return `${m.modifier === "straight" ? "Continue" : `Turn ${m.modifier ?? ""}`} onto ${name}`.replace(/\s+/g, " ");
		};
		const far = straight >= 80;
		$("#goPanel").innerHTML = `
			<div class="eta"><div><b>${far ? distText(straight) : minText(mins)}</b><small>${far ? "too far to go now" : `${distText(dist)} · arrive ${fmt(new Date(arrive).toISOString(), tz, { hour: "numeric", minute: "2-digit" })}`}</small></div>
				${far ? "" : early > 12 * 60 ? `<span class="pill t-plain">${icon("calendar")}${dayLabel(e, tz)} ${timeParts(e, tz).t} ${timeParts(e, tz).ap}</span>` : early >= 0 ? `<span class="pill t-mint">${icon("clock")}${minText(early)} early</span>` : Date.parse(e.end ?? e.start) > arrive ? `<span class="pill t-sun">${icon("clock")}${minText(-early)} after it starts</span>` : `<span class="pill t-live">It will be over</span>`}</div>
			<div class="prog"><i style="width:${Math.max(4, Math.min(100, 100 - (dist / Math.max(dist, firstDist)) * 100))}%"></i></div>
			<div class="steps">${steps.slice(0, 7).map((s, i) => `<div class="step ${i === 0 ? "on" : ""}"><span class="ib">${icon(stepIcon(s.maneuver))}</span><div><b>${stepText(s)}</b><small>${s.maneuver.type === "arrive" ? "you've arrived" : distText(s.distance / 1000)}${i === 0 ? " · now" : ""}</small></div></div>`).join("") || `<div class="step"><span class="ib">${icon("map")}</span><div><b>No street route found</b><small>Showing a straight line; open a maps app for directions</small></div></div>`}</div>
			<div class="row" style="display:flex;gap:8px"><a class="btn sm" style="flex:1" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${S.me.lat},${S.me.lng}&destination=${e.lat},${e.lng}&travelmode=${{ foot: "walking", bike: "bicycling", car: "driving" }[S.mode]}">Google Maps ${icon("arrow-up-right")}</a><a class="btn sm" style="flex:1" target="_blank" rel="noopener" href="https://maps.apple.com/?saddr=${S.me.lat},${S.me.lng}&daddr=${e.lat},${e.lng}&dirflg=${{ foot: "w", bike: "w", car: "d" }[S.mode]}">Apple Maps ${icon("arrow-up-right")}</a></div>`;
		refreshIcons();
	};
	const hint = (on) => ($("#goHint").innerHTML = on ? `<div class="hint">Tap the map where you're starting from</div>` : "");
	map.on("click", (ev) => { if (!S.me || hint.on) { setMe(ev.latlng.lat, ev.latlng.lng); hint.on = false; hint(false); draw(); } });
	$(".go .bar").onclick = (ev) => { const b = ev.target.closest("[data-mode]"); if (!b) return; S.mode = b.dataset.mode; $$(".go .bar [data-mode]").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
	map.setView([e.lat, e.lng], 16);
	if (await locate()) draw();
	else if (S.me) draw();
	else { hint.on = true; hint(true); }
	// Follow the person as they walk: redraw when they have moved 40 m, at most every 15 s.
	if (navigator.geolocation) {
		const wid = navigator.geolocation.watchPosition((p) => {
			setMe(p.coords.latitude, p.coords.longitude);
			if (meM) meM.setLatLng([S.me.lat, S.me.lng]);
			if (!lastPos || (km(lastPos, S.me) > 0.04 && Date.now() - lastRoute > 15000)) draw();
		}, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
		onLeave(() => navigator.geolocation.clearWatch(wid));
	}
	onLeave(() => { $("#crumb").hidden = true; });
}

// ---------- header wiring
$("#where").addEventListener("click", (ev) => {
	ev.preventDefault();
	setScope("near");
	if (["", "e", "map"].includes(current?.name ?? "") && homePage.alive) {
		if (location.hash.startsWith("#/e/")) history.replaceState(null, "", "#/");
		homePage.select(null);
		homePage.update({ recenter: true });
		window.scrollTo({ top: 0, behavior: "smooth" });
	} else location.hash = "#/";
});
let qt;
$("#q").addEventListener("input", (ev) => {
	clearTimeout(qt);
	qt = setTimeout(() => {
		S.q = ev.target.value;
		if (current?.name === "campuses") return campusesPage.redraw?.();
		if (!["", "e", "map"].includes(current?.name ?? "")) { location.hash = "#/"; return; }
		homePage.limit = 40;
		homePage.update();
	}, 160);
});
document.addEventListener("keydown", (ev) => {
	if (ev.key === "/" && document.activeElement !== $("#q") && !/input|textarea|select/i.test(document.activeElement?.tagName)) { ev.preventDefault(); $("#q").focus(); }
	if (ev.key === "Escape" && current?.name === "e") location.hash = "#/";
});
window.addEventListener("hashchange", route);

// ---------- start: near you when the browser already lets us know where, else the campus in this time zone
async function startScope() {
	if (store.getItem("scope") !== null) {
		if (S.scope === "near" && !S.me) setScope(guessScope(), { why: "timezone", save: false });
		return;
	}
	let granted = false;
	try { granted = (await navigator.permissions?.query({ name: "geolocation" }))?.state === "granted"; } catch {}
	if ((granted && (await locate())) || S.me) setScope("near", { save: false });
	else setScope(guessScope(), { why: "timezone", save: false });
}
refreshIcons();
route();
await loadBase();
await startScope();
homePage.alive = false;
route();
poll();
setInterval(() => { health(); }, 60e3);
