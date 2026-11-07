// free.food: the list, the map and the route.
const $ = (s) => document.querySelector(s);
const store = (() => { try { return window.localStorage; } catch { return { getItem: () => null, setItem() {} }; } })();

const S = {
	when: store.getItem("when") || "week",
	food: store.getItem("food") || "sure",
	region: store.getItem("region") || "all",
	uni: store.getItem("uni") || "",
	q: "",
	me: JSON.parse(store.getItem("me") || "null"), // { lat, lng, label }
	sel: null,
	events: [], unis: [], byUni: {}, counts: {}, at: 0, total: 0,
	mode: "foot",
};

// ---------- map
const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([30, -40], 3);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
	maxZoom: 19, className: "dark-tiles",
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · routes by <a href="https://routing.openstreetmap.de">FOSSGIS</a>',
}).addTo(map);
const cluster = L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false });
map.addLayer(cluster);
const campusLayer = L.layerGroup().addTo(map);
let routeLine = null, meMarker = null, pickingStart = false;
const markers = new Map();

const pinIcon = (e) => L.divIcon({
	className: "", iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
	html: `<div class="pin ${e.food?.level ?? "none"} ${e.where === "campus" ? "approx" : ""}"><span>${e.food ? emoji(e) : "•"}</span></div>`,
});
function emoji(e) {
	const w = (e.food?.words ?? []).join(" ") + " " + e.title.toLowerCase();
	return /pizza|披萨/.test(w) ? "🍕" : /boba|bubble tea/.test(w) ? "🧋" : /coffee|tea|kaffee/.test(w) ? "☕" : /donut|doughnut|bagel|cookie|cake|cupcake|kuchen/.test(w) ? "🍩" : /taco|burrito/.test(w) ? "🌮" : /ice cream/.test(w) ? "🍦" : /wine|cheese|reception|apéro|happy hour/.test(w) ? "🥂" : /breakfast|brunch|pancake|waffle/.test(w) ? "🥞" : /sushi|dumpling/.test(w) ? "🍣" : "🍱";
}

// ---------- time
const tzOf = (e) => S.byUni[e.uni]?.tz;
const fmt = (iso, tz, opts) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(iso));
function whenText(e) {
	const tz = tzOf(e);
	if (e.allDay) return "All day";
	const a = fmt(e.start, tz, { hour: "numeric", minute: "2-digit" });
	const b = e.end ? fmt(e.end, tz, { hour: "numeric", minute: "2-digit" }) : "";
	return b && b !== a ? `${a}–${b}` : a;
}
function relText(e) {
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (e.allDay) return "";
	if (s <= now && end >= now) return `<span class="live">HAPPENING NOW</span>`;
	const m = Math.round((s - now) / 6e4);
	if (m < 0) return "";
	if (m < 60) return `<span class="soon">in ${m} min</span>`;
	if (m < 12 * 60) return `<span class="soon">in ${Math.round(m / 60)}h</span>`;
	return "";
}
function dayKey(e) {
	return fmt(e.start, tzOf(e), { weekday: "long", month: "short", day: "numeric" });
}
function inWindow(e) {
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (end < now) return false;
	const tz = tzOf(e);
	const dayOf = (t) => fmt(new Date(t).toISOString(), tz, { year: "numeric", month: "2-digit", day: "2-digit" });
	switch (S.when) {
		case "now": return s <= now + 6 * 36e5 && !e.allDay;
		case "today": return dayOf(s) === dayOf(now);
		case "tomorrow": return dayOf(s) === dayOf(now + 864e5);
		case "week": return s <= now + 7 * 864e5;
		default: return true;
	}
}

// ---------- distance
const km = (a, b) => {
	const R = 6371, r = Math.PI / 180;
	const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};
const distText = (d) => (d < 1 ? `${Math.round(d * 1000)} m` : d < 100 ? `${d.toFixed(1)} km` : `${Math.round(d).toLocaleString()} km`);

// ---------- data
async function loadUnis() {
	S.unis = await (await fetch("api/universities")).json();
	S.byUni = Object.fromEntries(S.unis.map((u) => [u.id, u]));
	fillUniSelect();
	drawCampuses();
	renderSources();
}
async function loadEvents() {
	const mode = S.food === "all" ? "all" : "food";
	const r = await (await fetch(`api/events?food=${mode}`)).json();
	S.events = r.events; S.counts = r.counts; S.at = r.at; S.total = r.all;
	fillUniSelect();
	render();
	renderSources();
}

function visible() {
	const q = S.q.trim().toLowerCase();
	let list = S.events.filter((e) => {
		const u = S.byUni[e.uni];
		if (S.food === "sure" && e.food?.level !== "sure") return false;
		if (S.region === "US" && u?.country !== "US") return false;
		if (S.region === "world" && u?.country === "US") return false;
		if (S.uni && e.uni !== S.uni) return false;
		if (q && !`${e.title} ${e.location} ${e.org ?? ""} ${e.desc} ${u?.short ?? ""}`.toLowerCase().includes(q)) return false;
		return inWindow(e);
	});
	if (S.me) {
		for (const e of list) e._d = e.lat ? km(S.me, e) : Infinity;
		if (S.sortNear) list.sort((a, b) => a._d - b._d || a.start.localeCompare(b.start));
	}
	return list;
}

// ---------- render
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function highlight(text, words) {
	let out = esc(text);
	for (const w of [...(words ?? [])].sort((a, b) => b.length - a.length).slice(0, 6)) {
		const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
		out = out.replace(re, "<mark>$1</mark>");
	}
	return out;
}
function gmaps(e) {
	const dest = e.where !== "campus" && e.lat ? `${e.lat},${e.lng}` : `${e.location || ""} ${S.byUni[e.uni]?.name ?? ""}`.trim();
	return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}${S.me ? `&origin=${S.me.lat},${S.me.lng}` : ""}&travelmode=walking`;
}

function render() {
	const list = visible();
	const box = $("#list");
	$("#count").textContent = `${list.length} event${list.length === 1 ? "" : "s"}${S.food !== "all" ? " with food" : ""}`;
	if (!list.length) {
		box.innerHTML = `<div class="empty"><b>${S.events.length ? "Nothing in this window" : "Scraping the first batch…"}</b>${S.events.length ? "Try a wider time window, or include likely food." : "The first scrape of every university takes a few minutes."}</div>`;
	} else {
		let day = "", html = "";
		for (const e of list.slice(0, 600)) {
			const k = S.sortNear ? "" : dayKey(e);
			if (k !== day) { day = k; html += `<div class="day">${esc(k)}</div>`; }
			html += item(e);
		}
		box.innerHTML = html;
	}
	drawMarkers(list);
	$("#stat").textContent = S.at ? `${S.total.toLocaleString()} events · ${Object.values(S.counts).reduce((a, b) => a + b, 0)} with food · scraped ${ago(S.at)}` : "";
}

function item(e) {
	const u = S.byUni[e.uni];
	const f = e.food;
	return `<article class="ev ${S.sel === e.id ? "sel" : ""}" data-id="${e.id}">
		<div class="meta"><span class="badge ${e.institute ? "inst" : ""}" title="${esc(u?.name ?? e.uni)}${e.institute ? " · " + esc(e.src) : ""}">${esc(u?.short ?? e.uni)}</span>
			<span class="when">${whenText(e)}</span>${relText(e)}
			${S.me && e._d < Infinity ? `<span class="dist">${e.where === "campus" ? "~" : ""}${distText(e._d)}</span>` : ""}
			${e.online ? `<span>💻 online</span>` : ""}</div>
		<h3>${esc(e.title)}</h3>
		${e.location ? `<div class="loc">📍 ${esc(e.location)}${e.org ? ` · ${esc(e.org)}` : ""}</div>` : e.org ? `<div class="loc">${esc(e.org)}</div>` : ""}
		${f ? `<div class="why ${f.level}">${emoji(e)} ${highlight(f.why, f.words)}</div>` : ""}
		<div class="actions">
			${e.lat && !e.online ? `<button class="go" data-act="route">🚶 Route</button>` : ""}
			${!e.online ? `<a href="${gmaps(e)}" target="_blank" rel="noopener">↗ Google Maps</a>` : ""}
			<a href="api/ics/${e.id}">📅 Add</a>
			${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">Details</a>` : ""}
		</div>
	</article>`;
}

function drawMarkers(list) {
	cluster.clearLayers();
	markers.clear();
	for (const e of list) {
		if (!e.lat || e.online) continue;
		const m = L.marker([e.lat, e.lng], { icon: pinIcon(e) });
		m.bindPopup(() => `<b>${esc(e.title)}</b><div class="pm">${esc(S.byUni[e.uni]?.short ?? "")} · ${dayKey(e)} · ${whenText(e)}</div><div class="pm">📍 ${esc(e.location || "campus")}${e.where === "campus" ? " (pin at campus centre)" : ""}</div>${e.food ? `<div class="pm">${emoji(e)} ${esc(e.food.why.slice(0, 120))}</div>` : ""}<div class="pm"><a href="#" data-route="${e.id}">🚶 Route here</a> · <a href="${gmaps(e)}" target="_blank">Google Maps</a></div>`, { minWidth: 240, maxWidth: 300 });
		m.on("click", () => select(e.id, { fromMap: true }));
		cluster.addLayer(m);
		markers.set(e.id, m);
	}
}

function drawCampuses() {
	campusLayer.clearLayers();
	for (const u of S.unis) {
		if (!u.lat) continue;
		L.circleMarker([u.lat, u.lng], { radius: 4, color: "#5cc8ff", weight: 1, fillOpacity: 0.5 })
			.bindTooltip(`${u.short ?? u.name}`, { direction: "top" })
			.on("click", () => { setUni(u.id); })
			.addTo(campusLayer);
	}
}

function fillUniSelect() {
	const sel = $("#uni");
	const groups = { US: [], world: [] };
	for (const u of S.unis) groups[u.country === "US" ? "US" : "world"].push(u);
	const opt = (u) => `<option value="${u.id}" ${S.uni === u.id ? "selected" : ""}>${esc(u.short ?? u.name)}${S.counts[u.id] ? ` · ${S.counts[u.id]} 🍕` : ""}${u.sources.length ? "" : " (no feed)"}</option>`;
	sel.innerHTML = `<option value="">Every university (${S.unis.length})</option><optgroup label="United States">${groups.US.map(opt).join("")}</optgroup><optgroup label="Rest of the world">${groups.world.map(opt).join("")}</optgroup>`;
}

function renderSources() {
	const live = S.unis.filter((u) => u.sources.some((s) => s.status?.ok)).length;
	const feeds = S.unis.reduce((a, u) => a + u.sources.length, 0);
	let html = `<div class="src-head">${S.unis.length} universities · ${feeds} feeds · ${live} universities scraped live. Feeds are open calendars (Localist, iCal, RSS, student-org platforms); events are flagged when their text says food is provided.</div>`;
	for (const u of S.unis) {
		html += `<div class="src"><div class="row"><span class="name" data-uni="${u.id}">${u.rank ? `<span style="color:var(--faint);font-family:var(--mono)">${u.country === "US" ? "US" : u.country}#${u.rank}</span> ` : ""}${esc(u.name)}</span><span class="n">${S.counts[u.id] ? `${S.counts[u.id]} 🍕` : ""}</span></div>
			<div class="feeds">${u.sources.length ? u.sources.map((s) => `<span class="${s.status ? (s.status.ok ? "ok" : "bad") : "none"}" title="${esc(s.url)}${s.status?.error ? " · " + esc(s.status.error) : ""}">${s.status ? (s.status.ok ? "●" : "✕") : "○"} ${esc(s.label ?? s.type)}${s.status?.ok ? ` (${s.status.events})` : ""}</span>`).join("") : `<span class="none">no open feed found${u.notes ? ": " + esc(u.notes.slice(0, 120)) : ""}</span>`}</div></div>`;
	}
	$("#sources").innerHTML = html;
}

const ago = (t) => {
	const m = Math.round((Date.now() - t) / 6e4);
	return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)} days ago`;
};

// ---------- selection and route
function select(id, { fromMap = false } = {}) {
	S.sel = id;
	document.querySelectorAll(".ev.sel").forEach((n) => n.classList.remove("sel"));
	const node = document.querySelector(`.ev[data-id="${id}"]`);
	node?.classList.add("sel");
	if (fromMap) node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	const m = markers.get(id);
	if (m && !fromMap) cluster.zoomToShowLayer(m, () => m.openPopup());
}

async function route(e) {
	if (!S.me) {
		await locate(true);
		if (!S.me) {
			pickingStart = e.id;
			hint("Tap the map where you are starting from");
			if (matchMedia("(max-width: 760px)").matches) tab("map");
			return;
		}
	}
	if (matchMedia("(max-width: 760px)").matches) tab("map");
	const profile = { foot: "routed-foot/route/v1/foot", bike: "routed-bike/route/v1/bike", car: "routed-car/route/v1/driving" }[S.mode];
	const box = $("#route");
	box.hidden = false;
	const straight = km(S.me, e);
	box.innerHTML = `<button class="x" data-act="close">×</button><div>Routing to <b>${esc(e.title.slice(0, 60))}</b>…</div>`;
	if (straight > 60) return showRoute(e, null, straight);
	try {
		const r = await (await fetch(`https://routing.openstreetmap.de/${profile}/${S.me.lng},${S.me.lat};${e.lng},${e.lat}?overview=full&geometries=geojson`)).json();
		showRoute(e, r.routes?.[0], straight);
	} catch {
		showRoute(e, null, straight);
	}
}

function showRoute(e, r, straight) {
	if (routeLine) map.removeLayer(routeLine);
	routeLine = null;
	const box = $("#route");
	const speed = { foot: 4.8, bike: 15, car: 30 }[S.mode];
	let mins, dist;
	if (r) {
		routeLine = L.geoJSON(r.geometry, { style: { color: "#b8f53d", weight: 5, opacity: 0.9 } }).addTo(map);
		map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
		dist = r.distance / 1000;
		mins = S.mode === "foot" ? (dist / speed) * 60 : r.duration / 60;
	} else {
		routeLine = L.polyline([[S.me.lat, S.me.lng], [e.lat, e.lng]], { color: "#b8f53d", weight: 3, dashArray: "6 8" }).addTo(map);
		map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
		dist = straight;
		mins = (dist / speed) * 60 * 1.3;
	}
	const until = Math.round((Date.parse(e.start) - Date.now()) / 6e4);
	const slack = until - mins;
	const leaveAt = new Date(Date.parse(e.start) - mins * 6e4).toISOString();
	const verdict = slack > 180 ? `leave by ${fmt(leaveAt, tzOf(e), { weekday: "short", hour: "numeric", minute: "2-digit" })} to be there at the start`
		: slack > 0 ? `leave in ${Math.round(slack)} min to be there at the start`
		: until > -45 ? "it has already started: go now, the food goes first" : "";
	const t = mins < 90 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} h`;
	box.innerHTML = `<button class="x" data-act="close">×</button>
		<div class="big">${straight > 60 ? distText(straight) + " away" : `${t} · ${distText(dist)}`}</div>
		<div style="color:var(--muted);font-size:13px">${straight > 60 ? "Too far to walk. Here is the way there." : r ? "" : "Straight line (no route found) · "}${verdict ? verdict : ""}</div>
		<div class="modes">
			<button data-mode="foot" class="${S.mode === "foot" ? "on" : ""}">🚶 Walk</button>
			<button data-mode="bike" class="${S.mode === "bike" ? "on" : ""}">🚲 Bike</button>
			<button data-mode="car" class="${S.mode === "car" ? "on" : ""}">🚗 Drive</button>
			<a href="${gmaps(e)}" target="_blank" rel="noopener">↗ Google Maps</a>
			<a href="https://maps.apple.com/?daddr=${e.lat},${e.lng}&saddr=${S.me.lat},${S.me.lng}&dirflg=w" target="_blank" rel="noopener"> Maps</a>
		</div>`;
	box.dataset.id = e.id;
}

function setMe(lat, lng, label) {
	S.me = { lat, lng, label };
	store.setItem("me", JSON.stringify(S.me));
	if (meMarker) map.removeLayer(meMarker);
	meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), draggable: true, zIndexOffset: 1000 })
		.bindTooltip("You (drag to move)").addTo(map);
	meMarker.on("dragend", () => { const p = meMarker.getLatLng(); setMe(p.lat, p.lng, "pin"); render(); });
	$("#near").classList.add("on");
}

function locate(quiet) {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(false);
		navigator.geolocation.getCurrentPosition(
			(p) => { setMe(p.coords.latitude, p.coords.longitude, "gps"); resolve(true); },
			() => { if (!quiet) hint("Location is off here: tap the map to set where you are"); resolve(false); },
			{ timeout: 8000, maximumAge: 300000 },
		);
	});
}

function hint(text) {
	const h = $("#hint");
	h.textContent = text;
	h.hidden = false;
	clearTimeout(hint.t);
	hint.t = setTimeout(() => (h.hidden = true), 6000);
}

function tab(v) {
	document.querySelector("main").dataset.tab = v;
	document.querySelectorAll(".tabs-mobile button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
	const sources = v === "sources";
	$("#list").hidden = sources; $("#sources").hidden = !sources;
	$("#showList").classList.toggle("on", !sources); $("#showSources").classList.toggle("on", sources);
	if (v === "map") setTimeout(() => map.invalidateSize(), 50);
}

function setUni(id) {
	S.uni = id;
	store.setItem("uni", id);
	$("#uni").value = id;
	const u = S.byUni[id];
	if (u?.lat) map.flyTo([u.lat, u.lng], 15, { duration: 0.8 });
	tab("list");
	render();
}

// ---------- wiring
for (const [id, key] of [["#when", "when"], ["#food", "food"], ["#region", "region"]]) {
	const seg = $(id);
	seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === S[key]));
	seg.addEventListener("click", (ev) => {
		const b = ev.target.closest("button");
		if (!b) return;
		const was = S[key];
		S[key] = b.dataset.v;
		store.setItem(key, S[key]);
		seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
		if (key === "food" && (was === "all") !== (S.food === "all")) loadEvents();
		else render();
	});
}
$("#uni").addEventListener("change", (e) => setUni(e.target.value));
let qt;
$("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; render(); }, 120); });
$("#near").addEventListener("click", async () => {
	if (S.sortNear) { S.sortNear = false; $("#near").classList.remove("on"); return render(); }
	const ok = S.me || (await locate(false));
	if (!ok) { pickingStart = true; hint("Location is off here: tap the map to set where you are"); tab("map"); return; }
	S.sortNear = true;
	$("#near").classList.add("on");
	map.flyTo([S.me.lat, S.me.lng], 15);
	render();
});
$("#list").addEventListener("click", (ev) => {
	const card = ev.target.closest(".ev");
	if (!card) return;
	const e = S.events.find((x) => x.id === card.dataset.id);
	if (ev.target.closest('[data-act="route"]')) { select(e.id); route(e); return; }
	if (ev.target.closest("a")) return;
	select(e.id);
	if (matchMedia("(max-width: 760px)").matches && e.lat) tab("map"), setTimeout(() => select(e.id), 120);
});
$("#sources").addEventListener("click", (ev) => { const n = ev.target.closest("[data-uni]"); if (n) setUni(n.dataset.uni); });
$("#route").addEventListener("click", (ev) => {
	if (ev.target.closest('[data-act="close"]')) { $("#route").hidden = true; if (routeLine) map.removeLayer(routeLine); return; }
	const m = ev.target.closest("[data-mode]");
	if (m) { S.mode = m.dataset.mode; route(S.events.find((x) => x.id === $("#route").dataset.id)); }
});
map.on("popupopen", (ev) => {
	ev.popup.getElement().querySelector("[data-route]")?.addEventListener("click", (c) => { c.preventDefault(); route(S.events.find((x) => x.id === c.target.dataset.route)); });
});
map.on("click", (ev) => {
	if (!pickingStart) return;
	const target = pickingStart;
	pickingStart = false;
	$("#hint").hidden = true;
	setMe(ev.latlng.lat, ev.latlng.lng, "pin");
	render();
	if (typeof target === "string") route(S.events.find((x) => x.id === target));
});
document.querySelectorAll(".tabs-mobile button").forEach((b) => b.addEventListener("click", () => tab(b.dataset.v)));
$("#showList").addEventListener("click", () => tab("list"));
$("#showSources").addEventListener("click", () => tab("sources"));
$("#refresh").addEventListener("click", async () => { await fetch("api/refresh", { method: "POST" }); poll(); });

async function poll() {
	const s = await (await fetch("api/status")).json();
	const btn = $("#refresh");
	if (s.running) {
		btn.textContent = `Scraping ${s.done}/${s.total}`;
		btn.disabled = true;
		setTimeout(poll, 2500);
	} else {
		btn.textContent = "↻ Scrape";
		btn.disabled = false;
		if (s.at !== S.at) { await loadUnis(); await loadEvents(); }
	}
}

tab("list");
if (S.me) setMe(S.me.lat, S.me.lng, S.me.label);
await loadUnis();
await loadEvents();
if (S.uni && S.byUni[S.uni]?.lat) map.setView([S.byUni[S.uni].lat, S.byUni[S.uni].lng], 15);
poll();
setInterval(() => render(), 60e3); // "in 12 min" stays true
