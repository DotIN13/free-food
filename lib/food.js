// Decide whether an event offers free food, and say why.
// "sure": the text says food is provided / free / served.
// "likely": it names food (pizza, refreshments, a reception) without saying it is free.

const FOOD = [
	"free food", "free lunch", "free dinner", "free breakfast", "free pizza", "free snacks", "free boba", "free coffee",
	"free drinks", "free ice cream", "free tacos", "free donuts", "free bagels", "free cookies", "free meal",
	"pizza", "lunch", "dinner", "breakfast", "brunch", "snacks?", "refreshments?", "light bites", "appetizers?",
	"hors d'?oeuvres", "catered", "catering", "boba", "bubble tea", "donuts?", "doughnuts?", "bagels?", "cookies",
	"ice cream", "tacos?", "burritos?", "sandwiches", "dumplings", "sushi", "bbq", "barbecue", "cupcakes?", "cake",
	"coffee and", "tea and", "wine and cheese", "reception", "happy hour", "potluck", "food", "meal", "nibbles",
	"canap[eé]s", "drinks", "cookout", "s'mores", "smoothies", "pancakes", "waffles", "popcorn", "treats",
	// German / French / Chinese / Japanese
	"verpflegung", "imbiss", "apéro", "apero", "brezeln", "kaffee und kuchen", "buffet", "collation", "goûter",
	"petit[- ]déjeuner", "déjeuner", "rafraîchissements", "茶点", "茶歇", "午餐", "晚餐", "早餐", "餐饮", "披萨", "零食",
	"小食", "自助餐", "軽食", "懇親会", "ランチ", "お弁当", "弁当", "茶話会",
];
const PROVIDED = [
	"provided", "will be served", "served", "complimentary", "on us", "free of charge", "included", "available",
	"offered", "courtesy of", "sponsored by", "free", "kostenlos", "gratuit", "offert", "inclus", "提供", "免费", "無料",
];
const BAD = [
	"food drive", "food bank", "food pantry", "food insecurity", "food security", "food systems?", "food justice",
	"food policy", "food science", "food waste", "food safety", "food allergy", "eating disorder", "for purchase",
	"available to purchase", "available for purchase", "for sale", "bring your own", "bring a lunch",
	"bring your lunch", "brown bag", "byo", "food trucks?", "lunch (?:will|is) not (?:be )?provided",
	"no food", "\\$\\d", "tickets? required", "fundraiser", "bake sale", "lunch break", "lunch hour",
];
const SURE = [
	"free (?:food|lunch|dinner|breakfast|pizza|snacks|boba|coffee|drinks|ice cream|tacos|donuts|bagels|cookies|meal|refreshments|bites|treats)",
	"(?:food|lunch|dinner|breakfast|pizza|snacks|refreshments|drinks|meal|light bites|appetizers|boba|coffee|treats|catering)\\s+(?:and\\s+\\w+\\s+)?(?:will be |is |are |to be )?(?:provided|served|offered|available|included)",
	"(?:provide|serve|serving|offering|providing)\\s+(?:free\\s+)?(?:food|lunch|dinner|breakfast|pizza|snacks|refreshments|drinks|boba|meal)",
	"complimentary\\s+\\w+", "(?:lunch|dinner|food|pizza) (?:is )?on us", "refreshments", "reception to follow",
	"followed by (?:a )?reception", "wine and cheese", "提供(?:午餐|晚餐|茶点|茶歇|餐饮|简餐)", "免费(?:午餐|披萨|零食|茶点)",
	"軽食(?:あり|を用意)", "verpflegung (?:wird )?(?:gestellt|inklusive)", "apéro offert",
];

const rx = (list) => new RegExp(`(?<![\\p{L}])(?:${list.join("|")})(?![\\p{L}])`, "giu");
const FOOD_RX = rx(FOOD), BAD_RX = rx(BAD), SURE_RX = rx(SURE);

export function foodOf(e) {
	if (e.benefits?.some((b) => /free food/i.test(b))) return { level: "sure", why: `Free Food perk listed by the organisers. ${(e.desc ?? "").replace(/\s+/g, " ").slice(0, 140)}${(e.desc ?? "").length > 140 ? "…" : ""}`, words: ["free food"] };
	const text = `${e.title}\n${e.desc ?? ""}`;
	const sure = [...text.matchAll(SURE_RX)].map((m) => m[0]);
	const food = [...text.matchAll(FOOD_RX)].map((m) => m[0]);
	const bad = [...text.matchAll(BAD_RX)].map((m) => m[0]);
	if (!sure.length && !food.length) return null;
	// A talk *about* food, or food you buy, is not free food unless something says it is provided.
	if (bad.length && !sure.length) return null;
	const words = [...new Set([...sure, ...food].map((w) => w.toLowerCase()))];
	// Food at an event you pay to enter is not free food: say "likely" at most.
	const paid = /(?:admission|tickets?|cost|price|fee)s?[^.\n]{0,45}\$\s?[1-9]|\$\s?\d+(?:\.\d\d)?\s*(?:per|\/)\s*(?:person|ticket)|\bgeneral admission\b/i.test(text);
	const level = sure.length && !paid ? "sure" : "likely";
	// The weakest words alone ("food", "drinks", "lunch") on a talk title are too thin to show.
	const inTitle = [...e.title.matchAll(FOOD_RX)].length > 0;
	if (level === "likely" && !inTitle && words.every((w) => /^(food|meal|drinks|lunch|dinner|breakfast|cake|treats)$/.test(w)) && !/provided|served|free/i.test(text)) {
		return { level: "maybe", why: snippet(text, food[0]), words };
	}
	return { level, why: snippet(text, (sure[0] ?? food[0])), words };
}

function snippet(text, word) {
	const flat = text.replace(/\s+/g, " ");
	const i = flat.toLowerCase().indexOf(word.toLowerCase());
	if (i < 0) return flat.slice(0, 160);
	const a = Math.max(0, flat.lastIndexOf(" ", Math.max(0, i - 70)));
	const b = Math.min(flat.length, i + word.length + 90);
	return (a > 0 ? "…" : "") + flat.slice(a, b).trim() + (b < flat.length ? "…" : "");
}
