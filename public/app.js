// Free Food Hub: the list, the detail panel, the map, the route and the sources.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = (() => { try { return window.localStorage; } catch { return { getItem: () => null, setItem() {} }; } })();
const narrow = () => matchMedia("(max-width: 820px)").matches;
const icon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;

const S = {
	when: store.getItem("when") || "week",
	food: store.getItem("food") || "sure",
	region: store.getItem("region") || "all",
	uni: store.getItem("uni") || "",
	q: "",
	me: JSON.parse(store.getItem("me") || "null"),
	sortNear: false,
	sel: null,
	mode: "foot",
	events: [], unis: [], byUni: {}, counts: {}, at: 0, total: 0,
	loaded: false, error: null, status: null,
};

// ---------- map
const map = L.map("map", { zoomControl: false, worldCopyJump: true, attributionControl: true }).setView([32, -40], 3);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
	maxZoom: 19,
	attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · routes © <a href="https://routing.openstreetmap.de">FOSSGIS</a>',
}).addTo(map);
const cluster = L.markerClusterGroup({ maxClusterRadius: 44, showCoverageOnHover: false, spiderfyDistanceMultiplier: 1.4 });
map.addLayer(cluster);
const campusLayer = L.layerGroup().addTo(map);
const markers = new Map();
let routeLine = null, meMarker = null, pickingStart = false;

// ---------- helpers
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tzOf = (e) => S.byUni[e.uni]?.tz;
const fmt = (iso, tz, opts) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(iso));
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const uniColor = (id) => `hsl(${hue(id)} 62% 50%)`;
const uniName = (e) => S.byUni[e.uni]?.short ?? S.byUni[e.uni]?.name ?? e.uni;
const ago = (t) => {
	const m = Math.round((Date.now() - t) / 6e4);
	return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const km = (a, b) => {
	const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};
const distText = (d) => (d < 1 ? `${Math.round(d * 1000 / 10) * 10} m` : d < 100 ? `${d.toFixed(1)} km` : `${Math.round(d).toLocaleString()} km`);

const FOODS = [
	[/pizza|披萨/, "🍕", "Pizza"], [/boba|bubble tea/, "🧋", "Boba"], [/taco|burrito/, "🌮", "Tacos"], [/ice cream/, "🍦", "Ice cream"],
	[/donut|doughnut/, "🍩", "Donuts"], [/bagel/, "🥯", "Bagels"], [/cookie/, "🍪", "Cookies"], [/cake|cupcake|kuchen/, "🧁", "Cake"],
	[/breakfast|brunch|pancake|waffle|petit[- ]déjeuner|早餐/, "🥞", "Breakfast"], [/lunch|午餐|ランチ|弁当/, "🥪", "Lunch"],
	[/dinner|晚餐|supper/, "🍽️", "Dinner"], [/coffee|kaffee|tea\b|茶/, "☕", "Coffee & tea"], [/wine|cheese|apéro|apero|happy hour/, "🍷", "Drinks"],
	[/reception|hors|canap|appetizer|light bites/, "🥂", "Reception"], [/sushi|dumpling/, "🍣", "Sushi"], [/bbq|barbecue|cookout/, "🍖", "BBQ"],
	[/snack|popcorn|treats|nibbles|零食|小食|軽食/, "🍿", "Snacks"], [/refreshment|catered|catering|buffet|茶点|茶歇|verpflegung|imbiss/, "🍱", "Refreshments"],
];
function foodsOf(e) {
	const text = `${(e.food?.words ?? []).join(" ")} ${e.title}`.toLowerCase();
	const out = [];
	for (const [re, em, label] of FOODS) if (re.test(text) && out.length < 3) out.push({ em, label });
	if (!out.length && e.food) out.push({ em: "🍱", label: "Food" });
	return out;
}
const emojiOf = (e) => foodsOf(e)[0]?.em ?? "📅";

function timeParts(e) {
	const tz = tzOf(e);
	if (e.allDay) return { main: "All", sub: "day" };
	const t = fmt(e.start, tz, { hour: "numeric", minute: "2-digit" });
	const m = t.match(/^(.*?)\s?([AaPp]\.?[Mm]\.?)$/);
	return m ? { main: m[1], sub: m[2].replace(/\./g, "") } : { main: t, sub: "" };
}
function range(e) {
	const tz = tzOf(e);
	if (e.allDay) return "All day";
	const a = fmt(e.start, tz, { hour: "numeric", minute: "2-digit" });
	const b = e.end ? fmt(e.end, tz, { hour: "numeric", minute: "2-digit" }) : "";
	return b && b !== a ? `${a} – ${b}` : a;
}
function relOf(e) {
	if (e.allDay) return "";
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (s <= now && end >= now) return `<span class="live">LIVE</span>`;
	const m = Math.round((s - now) / 6e4);
	if (m >= 0 && m < 60) return `<span class="rel">in ${m} min</span>`;
	if (m >= 60 && m < 10 * 60) return `<span class="rel">in ${Math.round(m / 60)} h</span>`;
	return "";
}
function nowBadge(e) {
	if (e.allDay) return "";
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (s <= now && end >= now) return `<span class="now live">● Happening now</span>`;
	const m = Math.round((s - now) / 6e4);
	return m >= 0 && m < 12 * 60 ? `<span class="now">Starts in ${m < 60 ? `${m} min` : `${Math.round(m / 60)} h`}</span>` : "";
}
const dayKey = (e) => fmt(e.start, tzOf(e), { weekday: "long", month: "long", day: "numeric" });
function dayLabel(e) {
	const tz = tzOf(e), d = (t) => fmt(new Date(t).toISOString(), tz, { year: "numeric", month: "2-digit", day: "2-digit" });
	const s = Date.parse(e.start);
	if (d(s) === d(Date.now())) return "Today";
	if (d(s) === d(Date.now() + 864e5)) return "Tomorrow";
	return fmt(e.start, tz, { weekday: "long" });
}

function inWindow(e, when = S.when) {
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (end < now) return false;
	const tz = tzOf(e), day = (t) => fmt(new Date(t).toISOString(), tz, { year: "numeric", month: "2-digit", day: "2-digit" });
	switch (when) {
		case "now": return s <= now + 6 * 36e5 && !e.allDay;
		case "today": return day(s) === day(now) || (s < now && end > now);
		case "tomorrow": return day(s) === day(now + 864e5);
		case "week": return s <= now + 7 * 864e5;
		default: return true;
	}
}
function matches(e) {
	const u = S.byUni[e.uni];
	if (S.food === "sure" && e.food?.level !== "sure") return false;
	if (S.region === "US" && u?.country !== "US") return false;
	if (S.region === "world" && u?.country === "US") return false;
	if (S.uni && e.uni !== S.uni) return false;
	const q = S.q.trim().toLowerCase();
	if (q && !`${e.title} ${e.location} ${e.org ?? ""} ${e.desc} ${u?.short ?? ""} ${u?.name ?? ""}`.toLowerCase().includes(q)) return false;
	return true;
}
function visible() {
	const list = S.events.filter((e) => matches(e) && inWindow(e));
	if (S.me) for (const e of list) e._d = e.lat && !e.online ? km(S.me, e) : Infinity;
	if (S.sortNear && S.me) list.sort((a, b) => a._d - b._d || a.start.localeCompare(b.start));
	return list;
}
const gmaps = (e) => {
	const dest = e.where !== "campus" && e.lat ? `${e.lat},${e.lng}` : `${e.location || ""} ${S.byUni[e.uni]?.name ?? ""}`.trim();
	return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}${S.me ? `&origin=${S.me.lat},${S.me.lng}` : ""}&travelmode=walking`;
};
const apple = (e) => `https://maps.apple.com/?daddr=${e.lat},${e.lng}${S.me ? `&saddr=${S.me.lat},${S.me.lng}` : ""}&dirflg=w`;
function highlight(text, words) {
	let out = esc(text);
	for (const w of [...(words ?? [])].sort((a, b) => b.length - a.length).slice(0, 6)) {
		out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
	}
	return out;
}

// ---------- data
async function getJson(url, opts) {
	const r = await fetch(url, opts);
	if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
	return r.json();
}
async function loadUnis() {
	S.unis = await getJson("api/universities");
	S.byUni = Object.fromEntries(S.unis.map((u) => [u.id, u]));
	fillUniSelect();
	drawCampuses();
}
async function loadEvents() {
	const r = await getJson(`api/events?food=${S.food === "all" ? "all" : "food"}`);
	Object.assign(S, { events: r.events, counts: r.counts, at: r.at, total: r.all, loaded: true, error: null });
}
async function loadAll() {
	try {
		await loadUnis();
		await loadEvents();
		$("#banner").hidden = true;
	} catch (err) {
		S.error = err;
		const b = $("#banner");
		b.hidden = false;
		b.innerHTML = `Couldn't reach the server (${esc(err.message)}). Showing what was loaded before. <button class="btn" id="retry" style="height:30px;margin-left:8px">Try again</button>`;
		$("#retry").onclick = loadAll;
	}
	fillUniSelect();
	render();
	health();
	if (!$("#sources").hidden) renderSources();
}

// ---------- render
function render() {
	renderQuick();
	const list = visible();
	const box = $("#list");
	const n = list.length;
	$("#count").textContent = !S.loaded ? "Loading…" : `${n.toLocaleString()} ${n === 1 ? "event" : "events"}${S.food === "all" ? "" : " with free food"}${S.sortNear ? ", nearest first" : ""}`;
	if (!S.loaded) {
		box.innerHTML = Array.from({ length: 5 }, () => `<div class="sk"></div>`).join("");
	} else if (!list.length) {
		const wider = S.when !== "all";
		box.innerHTML = `<div class="empty"><div class="big">🍽️</div><b>No ${S.food === "all" ? "events" : "free food"} here${S.q ? ` for “${esc(S.q)}”` : ""}</b>${wider ? "Try a longer time range or include likely food." : "Try another university, or clear the search."}<br>${wider ? `<button class="btn" data-widen>Show the next 3 weeks</button>` : ""}</div>`;
	} else {
		const groups = new Map();
		for (const e of list.slice(0, 500)) {
			const k = S.sortNear ? "Nearest first" : dayKey(e);
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(e);
		}
		let html = "";
		for (const [k, evs] of groups) {
			html += `<div class="day"><span>${S.sortNear ? k : `${dayLabel(evs[0])} · ${esc(k.split(", ").slice(1).join(", ") || k)}`}</span><span>${evs.length}</span></div>`;
			html += evs.map(card).join("");
		}
		if (list.length > 500) html += `<div class="empty">Showing the first 500. Pick a university or search to narrow it down.</div>`;
		box.innerHTML = html;
	}
	drawMarkers(list);
}

function card(e) {
	const t = timeParts(e);
	const f = e.food;
	const foods = foodsOf(e);
	return `<article class="ev ${S.sel === e.id ? "sel" : ""}" data-id="${e.id}" tabindex="0">
		<div class="when"><b>${esc(t.main)}</b><small>${esc(t.sub)}</small>${relOf(e)}</div>
		<div class="body">
			<div class="uni"><i style="background:${uniColor(e.uni)}"></i><span>${esc(uniName(e))}${e.org ? `<span class="sep"> · </span>${esc(e.org)}` : ""}</span></div>
			<h3>${esc(e.title)}</h3>
			${e.online ? `<div class="loc">💻 <span>Online</span></div>` : e.location ? `<div class="loc">${icon("pin")}<span>${esc(e.location)}</span></div>` : ""}
			<div class="foodrow">
				${f ? `<span class="tag ${f.level}">${f.level === "sure" ? icon("check") : ""}${f.level === "sure" ? "Free food" : "Likely food"}</span>` : ""}
				${foods.filter(() => f).slice(0, 2).map((x) => `<span class="tag">${x.em} ${x.label}</span>`).join("")}
				${S.me && e._d < Infinity ? `<span class="tag dist">${e.where === "campus" ? "≈ " : ""}${distText(e._d)}</span>` : ""}
			</div>
			${f ? `<div class="quote">${highlight(f.why, f.words)}</div>` : ""}
		</div>
	</article>`;
}

function renderQuick() {
	const base = S.events.filter(matches);
	const n = (w) => base.filter((e) => inWindow(e, w)).length;
	$("#nNow").textContent = S.loaded ? n("now").toLocaleString() : "–";
	$("#nToday").textContent = S.loaded ? n("today").toLocaleString() : "–";
	$("#nWeek").textContent = S.loaded ? n("week").toLocaleString() : "–";
	$$("#quick button").forEach((b) => b.classList.toggle("on", b.dataset.when === S.when));
	$$("#when button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.when));
	$$("#food button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.food));
	$("#region").value = S.region;
}

function fillUniSelect() {
	const sel = $("#uni");
	const shown = S.unis.filter((u) => S.region === "all" || (S.region === "US") === (u.country === "US"));
	const opt = (u) => `<option value="${u.id}" ${S.uni === u.id ? "selected" : ""}>${esc(u.short ?? u.name)}${S.counts[u.id] ? `  ·  ${S.counts[u.id]}` : u.sources.length ? "" : "  ·  no feed"}</option>`;
	const us = shown.filter((u) => u.country === "US"), world = shown.filter((u) => u.country !== "US");
	sel.innerHTML = `<option value="">Every university (${shown.length})</option>${us.length ? `<optgroup label="United States">${us.map(opt).join("")}</optgroup>` : ""}${world.length ? `<optgroup label="Rest of the world">${world.map(opt).join("")}</optgroup>` : ""}`;
	if (S.uni && !shown.some((u) => u.id === S.uni)) S.uni = "";
	sel.value = S.uni;
}

// ---------- detail
function openDetail(id) {
	const e = S.events.find((x) => x.id === id);
	if (!e) return;
	select(id);
	const u = S.byUni[e.uni];
	const tz = tzOf(e);
	const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const yours = tz && tz !== mine && !e.allDay ? `<small>${fmt(e.start, mine, { weekday: "short", hour: "numeric", minute: "2-digit" })} your time</small>` : "";
	const f = e.food;
	const d = $("#detail");
	d.innerHTML = `
		<div class="top"><button class="back" data-close>${icon("back")}Back to events</button>${nowBadge(e)}</div>
		<div class="scroll">
			${e.image ? `<img class="img" src="${esc(e.image)}" alt="" onerror="this.remove()">` : ""}
			<div class="uni"><i style="background:${uniColor(e.uni)}"></i><span>${esc(u?.name ?? e.uni)}${e.institute ? ` · ${esc(e.src)}` : ""}</span></div>
			<h2>${esc(e.title)}</h2>
			<div class="facts">
				<div class="fact">${icon("clock")}<div>${esc(fmt(e.start, tz, { weekday: "long", month: "long", day: "numeric" }))}, ${esc(range(e))}${yours}</div></div>
				<div class="fact">${icon("pin")}<div>${e.online ? "Online" : esc(e.location || "Location not given")}${e.address && e.address !== e.location ? `<small>${esc(e.address)}</small>` : ""}${!e.online && e.where === "campus" ? `<small>Exact building unknown: the map pin is the campus centre</small>` : ""}${S.me && e._d < Infinity ? `<small>${distText(e._d)} from you</small>` : ""}</div></div>
				${e.org ? `<div class="fact">${icon("info")}<div>Hosted by ${esc(e.org)}</div></div>` : ""}
			</div>
			${f ? `<div class="evidence ${f.level}"><h4>${f.level === "sure" ? `${icon("check")}Free food confirmed` : "Food likely"} · ${foodsOf(e).map((x) => `${x.em} ${x.label}`).join(", ")}</h4><p>${highlight(f.why, f.words)}</p></div>` : ""}
			<div class="actions">
				${!e.online && e.lat ? `<button class="btn primary" data-route>${icon("nav")}Get directions</button>` : ""}
				<a class="btn" href="api/ics/${e.id}">${icon("cal")}Add to calendar</a>
				${e.url ? `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">${icon("ext")}Event page</a>` : `<a class="btn" href="${gmaps(e)}" target="_blank" rel="noopener">${icon("ext")}Google Maps</a>`}
			</div>
			${e.desc ? `<div class="desc"><h4>About</h4>${esc(e.desc)}${e.desc.length >= 590 ? "…" : ""}</div>` : ""}
			<div class="provenance">From ${esc(e.src)}, checked ${ago(S.at)}. Food is detected from the event's own words: check the event page before you go.</div>
		</div>`;
	d.hidden = false;
	d.dataset.id = id;
	$(".scroll", d).scrollTop = 0;
}
const closeDetail = () => { $("#detail").hidden = true; };

// ---------- map drawing
const pinIcon = (e) => L.divIcon({
	className: "", iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -30],
	html: `<div class="pin ${e.food?.level ?? ""} ${e.where === "campus" ? "approx" : ""} ${S.sel === e.id ? "sel" : ""}"><span>${emojiOf(e)}</span></div>`,
});
function drawMarkers(list) {
	cluster.clearLayers();
	markers.clear();
	const layers = [];
	for (const e of list) {
		if (!e.lat || e.online) continue;
		const m = L.marker([e.lat, e.lng], { icon: pinIcon(e), riseOnHover: true });
		m.bindPopup(() => `<div class="pop"><b>${esc(e.title)}</b><div class="m">${esc(uniName(e))} · ${dayLabel(e)} ${range(e)}</div><div class="m">${esc(e.location || "On campus")}</div><div class="go"><button class="primary" data-pop-route="${e.id}">Directions</button><button data-pop-detail="${e.id}">Details</button></div></div>`, { minWidth: 240, maxWidth: 300 });
		m.on("click", () => select(e.id, { fromMap: true }));
		layers.push(m);
		markers.set(e.id, m);
	}
	cluster.addLayers(layers);
}
function drawCampuses() {
	campusLayer.clearLayers();
	for (const u of S.unis) {
		if (!u.lat) continue;
		L.circleMarker([u.lat, u.lng], { radius: 5, color: uniColor(u.id), weight: 2, fillColor: "#fff", fillOpacity: 1 })
			.bindTooltip(u.short ?? u.name, { direction: "top", className: "campus", opacity: 1 })
			.on("click", () => setUni(u.id, true))
			.addTo(campusLayer);
	}
}
function select(id, { fromMap = false } = {}) {
	const prev = S.sel;
	S.sel = id;
	$$(".ev.sel").forEach((n) => n.classList.remove("sel"));
	const node = $(`.ev[data-id="${id}"]`);
	node?.classList.add("sel");
	if (fromMap) node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	for (const pid of [prev, id]) {
		const m = markers.get(pid);
		const e = S.events.find((x) => x.id === pid);
		if (m && e) m.setIcon(pinIcon(e));
	}
	const m = markers.get(id);
	if (m && !fromMap && !narrow()) cluster.zoomToShowLayer(m, () => m.openPopup());
}

// ---------- route
async function route(e) {
	if (!e) return;
	if (narrow()) tab("map");
	if (!S.me) {
		const ok = await locate(true);
		if (!ok) {
			pickingStart = e.id;
			toast("Tap the map where you're starting from");
			return;
		}
	}
	const sheet = $("#route");
	sheet.hidden = false;
	sheet.dataset.id = e.id;
	sheet.innerHTML = `<div class="head"><div><div class="to">To ${esc(e.title)}</div><div class="big">Finding a route…</div></div><button class="x" data-close aria-label="Close">${icon("x")}</button></div>`;
	const straight = km(S.me, e);
	if (straight > 60) return showRoute(e, null, straight);
	const profile = { foot: "routed-foot/route/v1/foot", bike: "routed-bike/route/v1/bike", car: "routed-car/route/v1/driving" }[S.mode];
	try {
		const r = await getJson(`https://routing.openstreetmap.de/${profile}/${S.me.lng},${S.me.lat};${e.lng},${e.lat}?overview=full&geometries=geojson`);
		showRoute(e, r.routes?.[0], straight);
	} catch {
		showRoute(e, null, straight);
	}
}
function showRoute(e, r, straight) {
	if (routeLine) map.removeLayer(routeLine);
	const speed = { foot: 4.8, bike: 15, car: 30 }[S.mode];
	let mins, dist;
	if (r) {
		routeLine = L.layerGroup([
			L.geoJSON(r.geometry, { style: { color: "#ffffff", weight: 9, opacity: 0.9 } }),
			L.geoJSON(r.geometry, { style: { color: getComputedStyle(document.documentElement).getPropertyValue("--you").trim() || "#2f6fed", weight: 5 } }),
		]).addTo(map);
		dist = r.distance / 1000;
		mins = S.mode === "foot" ? (dist / speed) * 60 : r.duration / 60;
	} else {
		routeLine = L.polyline([[S.me.lat, S.me.lng], [e.lat, e.lng]], { color: "#2f6fed", weight: 3, dashArray: "6 8" }).addTo(map);
		dist = straight;
		mins = (dist / speed) * 60 * 1.3;
	}
	map.fitBounds(L.latLngBounds([[S.me.lat, S.me.lng], [e.lat, e.lng]]), { padding: narrow() ? [40, 40] : [80, 80], paddingBottomRight: [0, 200] });
	const until = (Date.parse(e.start) - Date.now()) / 6e4, slack = until - mins;
	const leaveAt = new Date(Date.parse(e.start) - mins * 6e4).toISOString();
	const far = straight > 60;
	const verdict = far ? "Too far to go today: open it in a maps app for travel options"
		: slack > 180 ? `Leave by ${fmt(leaveAt, tzOf(e), { weekday: "short", hour: "numeric", minute: "2-digit" })} to be there at the start`
		: slack > 0 ? `Leave in ${Math.round(slack)} min to be there at the start`
		: until > -45 ? "It has started: go now, the food goes first" : "";
	const t = mins < 90 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} h`;
	$("#route").innerHTML = `
		<div class="head"><div style="min-width:0"><div class="to">To ${esc(e.title)}</div>
			<div class="big">${far ? distText(straight) : t}<small>${far ? "away" : `${distText(dist)}${r ? "" : " · straight line"}`}</small></div>
			${verdict ? `<div class="verdict ${slack < 0 && !far ? "late" : ""}">${verdict}</div>` : ""}</div>
			<button class="x" data-close aria-label="Close">${icon("x")}</button></div>
		<div class="modes seg">
			<button data-mode="foot" class="${S.mode === "foot" ? "on" : ""}">${icon("walk")}Walk</button>
			<button data-mode="bike" class="${S.mode === "bike" ? "on" : ""}">${icon("bike")}Bike</button>
			<button data-mode="car" class="${S.mode === "car" ? "on" : ""}">${icon("car")}Drive</button>
		</div>
		<div class="open"><a class="btn" href="${gmaps(e)}" target="_blank" rel="noopener">Google Maps</a><a class="btn" href="${apple(e)}" target="_blank" rel="noopener">Apple Maps</a></div>`;
}
function closeRoute() {
	$("#route").hidden = true;
	if (routeLine) map.removeLayer(routeLine);
	routeLine = null;
}

// ---------- location
function setMe(lat, lng) {
	S.me = { lat, lng };
	store.setItem("me", JSON.stringify(S.me));
	if (meMarker) map.removeLayer(meMarker);
	meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), draggable: true, zIndexOffset: 1000 })
		.bindTooltip("You · drag to move", { direction: "top" }).addTo(map);
	meMarker.on("dragend", () => { const p = meMarker.getLatLng(); setMe(p.lat, p.lng); render(); });
	$("#locateBtn").classList.add("on");
}
function locate(quiet) {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(false);
		navigator.geolocation.getCurrentPosition(
			(p) => { setMe(p.coords.latitude, p.coords.longitude); resolve(true); },
			() => { if (!quiet) toast("Location is off: tap the map to set where you are"); resolve(false); },
			{ timeout: 8000, maximumAge: 300000 },
		);
	});
}
function toast(text, ms = 5000) {
	const t = $("#toast");
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toast.t);
	toast.t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- health and sources
function health() {
	const dot = $("#healthDot"), text = $("#healthText");
	const feeds = S.unis.flatMap((u) => u.sources);
	const ok = feeds.filter((s) => s.status?.ok).length;
	if (S.status?.running) {
		dot.className = "dot busy";
		text.innerHTML = `Updating ${S.status.done}/${S.status.total}<span class="long"> feeds</span>`;
		return;
	}
	if (S.error) { dot.className = "dot warn"; text.textContent = "Offline"; return; }
	if (!S.at) { dot.className = "dot"; text.textContent = "Connecting…"; return; }
	const stale = Date.now() - S.at > 6 * 36e5;
	dot.className = `dot ${stale || ok < feeds.length * 0.8 ? "warn" : "ok"}`;
	text.innerHTML = `${stale ? "Last update" : "Live"} · ${ago(S.at)}<span class="long"> · ${ok}/${feeds.length} feeds</span>`;
}
let srcFilter = "all";
function renderSources() {
	const feeds = S.unis.flatMap((u) => u.sources);
	const ok = feeds.filter((s) => s.status?.ok).length;
	const live = S.unis.filter((u) => u.sources.some((s) => s.status?.ok)).length;
	$("#srcSummary").textContent = `${live} of ${S.unis.length} universities live · ${ok} of ${feeds.length} feeds working · checked ${S.at ? ago(S.at) : "never"}`;
	const shown = S.unis.filter((u) => srcFilter === "all" || (srcFilter === "none" ? !u.sources.length : u.sources.some((s) => s.status && !s.status.ok)));
	$("#srcList").innerHTML = shown.map((u) => `
		<div class="src">
			<div class="r1"><button class="nm" data-uni="${u.id}"><span class="rk">${u.country === "US" ? "US" : u.country} #${u.rank}</span>${esc(u.name)}</button><span class="n">${S.counts[u.id] ? `${S.counts[u.id]} with food` : ""}</span></div>
			${u.sources.length ? `<div class="feeds">${u.sources.map((s) => {
				const st = s.status;
				return `<div class="feed ${st && !st.ok ? "bad" : ""}" title="${esc(s.url)}"><span class="dot ${st ? (st.ok ? "ok" : "warn") : ""}"></span><span class="lb">${esc(s.label ?? s.type)}</span><span class="st">${st ? (st.ok ? `${st.events} events` : `failed: ${esc(st.error)}`) : "not checked yet"}</span></div>`;
			}).join("")}</div>` : `<div class="none">No open calendar found${u.notes ? `. ${esc(u.notes.slice(0, 140))}${u.notes.length > 140 ? "…" : ""}` : ""}</div>`}
		</div>`).join("") || `<div class="empty"><b>Nothing to show</b>Every source in this group is working.</div>`;
}
function openSources() {
	renderSources();
	$("#sources").hidden = false;
	$("#scrim").hidden = false;
}
function closeSources() {
	$("#sources").hidden = true;
	$("#scrim").hidden = true;
	if (narrow()) $$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.v === $("#layout").dataset.tab));
}

// ---------- navigation
function tab(v) {
	if (v === "sources") {
		$$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
		return openSources();
	}
	$("#layout").dataset.tab = v;
	$$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
	if (v === "map") setTimeout(() => map.invalidateSize(), 30);
}
function setUni(id, fly) {
	S.uni = id;
	store.setItem("uni", id);
	$("#uni").value = id;
	const u = S.byUni[id];
	if (u?.lat && fly) map.flyTo([u.lat, u.lng], 15, { duration: 0.8 });
	else if (u?.lat) map.setView([u.lat, u.lng], 14);
	closeDetail();
	render();
}
function setWhen(v) {
	S.when = v;
	store.setItem("when", v);
	render();
}

// ---------- wiring
$("#quick").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setWhen(b.dataset.when); });
$("#when").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setWhen(b.dataset.v); });
$("#food").addEventListener("click", async (ev) => {
	const b = ev.target.closest("button");
	if (!b) return;
	const was = S.food;
	S.food = b.dataset.v;
	store.setItem("food", S.food);
	if ((was === "all") !== (S.food === "all")) {
		S.loaded = false;
		render();
		await loadEvents().catch((e) => (S.error = e));
	}
	render();
});
$("#region").addEventListener("change", (ev) => { S.region = ev.target.value; store.setItem("region", S.region); fillUniSelect(); render(); });
$("#uni").addEventListener("change", (ev) => setUni(ev.target.value, true));
let qt;
$("#q").addEventListener("input", (ev) => { clearTimeout(qt); qt = setTimeout(() => { S.q = ev.target.value; render(); }, 120); });
$("#near").addEventListener("click", async () => {
	if (S.sortNear) { S.sortNear = false; $("#near").classList.remove("on"); return render(); }
	if (!S.me && !(await locate(false))) { pickingStart = true; if (narrow()) tab("map"); toast("Tap the map to set where you are"); return; }
	S.sortNear = true;
	$("#near").classList.add("on");
	render();
});
$("#locateBtn").addEventListener("click", async () => {
	if (await locate(false)) map.flyTo([S.me.lat, S.me.lng], 16);
	else if (S.me) map.flyTo([S.me.lat, S.me.lng], 16);
	else { pickingStart = true; toast("Tap the map to set where you are"); }
});
$("#list").addEventListener("click", (ev) => {
	if (ev.target.closest("[data-widen]")) return setWhen("all");
	const c = ev.target.closest(".ev");
	if (c) openDetail(c.dataset.id);
});
$("#list").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.classList.contains("ev")) openDetail(ev.target.dataset.id); });
$("#detail").addEventListener("click", (ev) => {
	if (ev.target.closest("[data-close]")) return closeDetail();
	if (ev.target.closest("[data-route]")) route(S.events.find((x) => x.id === $("#detail").dataset.id));
});
$("#route").addEventListener("click", (ev) => {
	if (ev.target.closest("[data-close]")) return closeRoute();
	const m = ev.target.closest("[data-mode]");
	if (m) { S.mode = m.dataset.mode; route(S.events.find((x) => x.id === $("#route").dataset.id)); }
});
map.on("popupopen", (ev) => {
	const el = ev.popup.getElement();
	el.querySelector("[data-pop-route]")?.addEventListener("click", (c) => route(S.events.find((x) => x.id === c.currentTarget.dataset.popRoute)));
	el.querySelector("[data-pop-detail]")?.addEventListener("click", (c) => { const id = c.currentTarget.dataset.popDetail; if (narrow()) tab("list"); openDetail(id); });
});
map.on("click", (ev) => {
	if (!pickingStart) return;
	const target = pickingStart;
	pickingStart = false;
	$("#toast").hidden = true;
	setMe(ev.latlng.lat, ev.latlng.lng);
	render();
	if (typeof target === "string") route(S.events.find((x) => x.id === target));
});
$$(".tabbar button").forEach((b) => b.addEventListener("click", () => tab(b.dataset.v)));
$("#healthBtn").addEventListener("click", openSources);
$("#srcClose").addEventListener("click", closeSources);
$("#scrim").addEventListener("click", closeSources);
$("#srcFilter").addEventListener("click", (ev) => {
	const b = ev.target.closest("button");
	if (!b) return;
	srcFilter = b.dataset.v;
	$$("#srcFilter button").forEach((x) => x.classList.toggle("on", x === b));
	renderSources();
});
$("#srcList").addEventListener("click", (ev) => { const n = ev.target.closest("[data-uni]"); if (n) { closeSources(); tab("list"); setUni(n.dataset.uni, true); } });
$("#refresh").addEventListener("click", async () => {
	await fetch("api/refresh", { method: "POST" }).catch(() => {});
	toast("Checking every feed again. This takes a few minutes.");
	poll();
});
document.addEventListener("keydown", (ev) => {
	if (ev.key === "/" && document.activeElement !== $("#q")) { ev.preventDefault(); $("#q").focus(); }
	if (ev.key === "Escape") {
		if (!$("#sources").hidden) closeSources();
		else if (!$("#route").hidden) closeRoute();
		else if (!$("#detail").hidden) closeDetail();
	}
});

async function poll() {
	try {
		S.status = await getJson("api/status");
	} catch { S.status = null; }
	const btn = $("#refresh");
	btn.classList.toggle("spin", !!S.status?.running);
	btn.disabled = !!S.status?.running;
	health();
	if (S.status?.running) setTimeout(poll, 2500);
	else if (S.status && S.status.at !== S.at) await loadAll();
}

// ---------- start
renderQuick();
render();
if (S.me) setMe(S.me.lat, S.me.lng);
await loadAll();
if (S.uni && S.byUni[S.uni]?.lat) map.setView([S.byUni[S.uni].lat, S.byUni[S.uni].lng], 14);
poll();
setInterval(() => { render(); health(); }, 60e3);
