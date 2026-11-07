// The campus's time zone, from its state or country, so times read as they do on the poster.
const STATE = {
	CA: "America/Los_Angeles", WA: "America/Los_Angeles", OR: "America/Los_Angeles",
	TX: "America/Chicago", IL: "America/Chicago", WI: "America/Chicago", MO: "America/Chicago", TN: "America/Chicago", MN: "America/Chicago", LA: "America/Chicago",
	IN: "America/Indiana/Indianapolis", CO: "America/Denver", UT: "America/Denver", AZ: "America/Phoenix",
};
const COUNTRY = {
	GB: "Europe/London", CH: "Europe/Zurich", SG: "Asia/Singapore", CN: "Asia/Shanghai", AU: "Australia/Sydney", HK: "Asia/Hong_Kong",
	CA: "America/Toronto", DE: "Europe/Berlin", JP: "Asia/Tokyo", FR: "Europe/Paris", KR: "Asia/Seoul", NL: "Europe/Amsterdam",
};
export function tzOf(u) {
	if (u.tz) return u.tz;
	if (u.country === "US") return STATE[u.city?.match(/,\s*([A-Z]{2})\b/)?.[1]] ?? "America/New_York";
	if (u.country === "AU" && /melbourne/i.test(`${u.city} ${u.name}`)) return "Australia/Melbourne";
	if (u.country === "CA" && /vancouver|british columbia/i.test(`${u.city} ${u.name}`)) return "America/Vancouver";
	return COUNTRY[u.country] ?? undefined;
}
