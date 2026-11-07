// A server with no packages to install: Node's own http module, a folder of pages, and a JSON file.
// Decks gives it PORT and sends it the requests for /app/<name>/ with that prefix taken off.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const DATA = new URL("./data.json", import.meta.url);
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const load = async () => JSON.parse(await readFile(DATA, "utf8").catch(() => "[]"));

createServer(async (req, res) => {
	const url = new URL(req.url, "http://app");
	if (url.pathname === "/api/items" && req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify(await load()));
	}
	if (url.pathname === "/api/items" && req.method === "POST") {
		let body = "";
		for await (const chunk of req) body += chunk;
		const items = await load();
		items.push({ text: String(JSON.parse(body || "{}").text ?? "").slice(0, 200), at: Date.now() });
		await writeFile(DATA, JSON.stringify(items, null, "\t"));
		res.writeHead(201, { "content-type": "application/json" });
		return res.end(JSON.stringify(items));
	}
	const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
	try {
		const bytes = await readFile(join(PUBLIC, path));
		res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
		res.end(bytes);
	} catch {
		res.writeHead(404).end("Not found");
	}
}).listen(PORT, "127.0.0.1", () => console.log(`listening on ${PORT}`));
