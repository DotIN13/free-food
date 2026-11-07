// Small helpers shared by every view: words, times, distances, food and platforms.

export const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const icon = (name, cls = "") => `<i data-lucide="${name}" class="${cls}"></i>`;
export const fmt = (iso, tz, opts) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(new Date(iso));
export const ago = (t) => {
	const m = Math.round((Date.now() - t) / 6e4);
	return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
export const km = (a, b) => {
	const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};
export const distText = (d) => (d < 1 ? `${Math.round((d * 1000) / 10) * 10} m` : d < 100 ? `${d.toFixed(1)} km` : `${Math.round(d).toLocaleString()} km`);
// Walking time over streets: straight-line distance times 1.3, at 4.8 km/h.
export const walkMin = (d) => Math.max(1, Math.round(((d * 1.3) / 4.8) * 60));
export const minText = (m) => {
	const r = Math.round(m);
	if (r < 60) return `${r} min`;
	if (r >= 600) return `${Math.round(r / 60)} h`;
	return r % 60 ? `${Math.floor(r / 60)} h ${r % 60} min` : `${r / 60} h`;
};

// ---------- food
export const FOODS = [
	{ key: "pizza", re: /pizza|披萨/, em: "🍕", label: "Pizza", soft: "var(--sun-soft)" },
	{ key: "boba", re: /boba|bubble tea/, em: "🧋", label: "Boba", soft: "var(--grape-soft)" },
	{ key: "tacos", re: /taco|burrito/, em: "🌮", label: "Tacos", soft: "var(--sun-soft)" },
	{ key: "sweets", re: /donut|doughnut|bagel|cookie|cake|cupcake|ice cream|kuchen|s'mores|waffle|pancake/, em: "🍩", label: "Sweets", soft: "var(--tomato-soft)" },
	{ key: "breakfast", re: /breakfast|brunch|petit[- ]déjeuner|早餐/, em: "🥞", label: "Breakfast", soft: "var(--sun-soft)" },
	{ key: "lunch", re: /lunch|午餐|ランチ|弁当|sandwich/, em: "🥪", label: "Lunch", soft: "var(--sun-soft)" },
	{ key: "dinner", re: /dinner|晚餐|supper|meal|potluck|bbq|barbecue|cookout/, em: "🍽️", label: "Dinner", soft: "var(--mint-soft)" },
	{ key: "coffee", re: /coffee|kaffee|\btea\b|茶/, em: "☕", label: "Coffee", soft: "var(--sky-soft)" },
	{ key: "reception", re: /reception|wine|cheese|apéro|apero|happy hour|hors|canap|appetizer|light bites/, em: "🥂", label: "Receptions", soft: "var(--mint-soft)" },
	{ key: "snacks", re: /snack|popcorn|treats|nibbles|零食|小食|軽食|refreshment|catered|catering|buffet|茶点|茶歇|verpflegung|imbiss/, em: "🍿", label: "Snacks", soft: "var(--grape-soft)" },
	{ key: "culture", re: /borek|boreg|dumpling|samosa|sushi|curry|empanada|kebab|dim sum|bao|biryani|tamale|arepa|pierogi|baklava|mochi/, em: "🥟", label: "World food", soft: "var(--tomato-soft)" },
];
const GENERIC = { key: "food", em: "🍱", label: "Free food", soft: "var(--tomato-soft)" };
// What the food is, from the words that flagged it plus the title and description ("Free Food" alone says nothing about which).
const foodText = (e) => `${(e.food?.words ?? []).filter((w) => !/^free food$|^food$/.test(w)).join(" ")} ${e.title} ${e.desc ?? ""} ${(e.food?.why ?? "").replace(/^Free Food perk listed by the organisers\.?/, "")}`.toLowerCase();
export const foodsOf = (e) => FOODS.filter((f) => f.re.test(foodText(e)));
export const catOf = (e) => foodsOf(e)[0] ?? (e.food ? GENERIC : { key: "event", em: "📅", label: "Event", soft: "var(--bg)" });
export function highlight(text, words) {
	let out = esc(text);
	for (const w of [...(words ?? [])].sort((a, b) => b.length - a.length).slice(0, 6)) {
		out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
	}
	return out;
}
// The words of the description the food was found in: the perk note is dropped, the description kept.
export const quoteOf = (e) => (e.desc || e.food?.why || "").replace(/\s+/g, " ").trim();
export const perkOf = (e) => /^Free Food perk/.test(e.food?.why ?? "");

// ---------- platforms: what kind of calendar a feed is
export function platformOf(src) {
	const u = src?.url ?? "", k = src?.kind ?? src?.type ?? "";
	if (/campusgroups|\/rss_events|\/ical\/[a-z]+\/ical_/.test(u)) return { name: "CampusGroups", desc: "CampusGroups student-org calendar", letter: "C", color: "#ff5a3c" };
	if (k === "engage") return { name: "Engage", desc: "Anthology Engage · public events API", letter: "E", color: "#7c5cff" };
	if (k === "localist") return { name: "Localist", desc: "Localist calendar · events API", letter: "L", color: "#16b77a" };
	if (k === "livewhale") return { name: "LiveWhale", desc: "LiveWhale calendar · JSON feed", letter: "W", color: "#2f80ff" };
	if (/trumba/.test(u)) return { name: "Trumba", desc: "Trumba calendar · iCal feed", letter: "T", color: "#e9a400" };
	if (k === "tribe") return { name: "WordPress", desc: "The Events Calendar · REST API", letter: "P", color: "#3c6e8f" };
	if (k === "ical") return { name: "iCal", desc: "Calendar file (iCal)", letter: "i", color: "#0f9d8a" };
	if (k === "rss") return { name: "RSS", desc: "RSS feed", letter: "R", color: "#f08a24" };
	return { name: "University API", desc: "The university's own events API · JSON", letter: "U", color: "#5b6b82" };
}
export const shortUrl = (u = "") => u.replace(/^https?:\/\//, "").replace(/^www\./, "");
export const isStudentFeed = (src) => /student|org|club|engage|campusgroups|union|connect|link|sphere|sync|life|zotspot|shoreline|aggielife|huskylink|win\.wisc/i.test(`${src?.label} ${src?.url}`);

// ---------- time
export function timeParts(e, tz) {
	if (e.allDay) return { t: "All day", ap: "" };
	const s = fmt(e.start, tz, { hour: "numeric", minute: "2-digit" });
	const m = s.match(/^(.*?)\s?([AP]M)$/);
	return m ? { t: m[1], ap: m[2] } : { t: s, ap: "" };
}
export function range(e, tz) {
	if (e.allDay) return "All day";
	const a = fmt(e.start, tz, { hour: "numeric", minute: "2-digit" });
	const b = e.end ? fmt(e.end, tz, { hour: "numeric", minute: "2-digit" }) : "";
	return b && b !== a ? `${a} – ${b}` : a;
}
export function status(e) {
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (e.allDay) return { live: s <= now && end >= now, text: "all day" };
	if (s <= now && end >= now) return { live: true, text: "on now" };
	const m = Math.round((s - now) / 6e4);
	if (m < 0) return { live: false, text: "ended", ended: true };
	if (m < 60) return { live: false, text: `in ${m} min`, soon: true };
	if (m < 24 * 60) return { live: false, text: `in ${Math.round(m / 60)} h` };
	return { live: false, text: `in ${Math.round(m / 1440)} d` };
}
const dayStr = (t, tz) => fmt(new Date(t).toISOString(), tz, { year: "numeric", month: "2-digit", day: "2-digit" });
export function dayLabel(e, tz) {
	const s = Date.parse(e.start);
	if (dayStr(s, tz) === dayStr(Date.now(), tz)) return "Today";
	if (dayStr(s, tz) === dayStr(Date.now() + 864e5, tz)) return "Tomorrow";
	return fmt(e.start, tz, { weekday: "long", month: "short", day: "numeric" });
}
export function inWindow(e, when, tz) {
	const now = Date.now(), s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 36e5;
	if (end < now) return false;
	if (when === "soon") return s <= now + 6 * 36e5 && !e.allDay;
	if (when === "today") return dayStr(s, tz) === dayStr(now, tz) || s < now;
	if (when === "week") return s <= now + 7 * 864e5;
	return true;
}
