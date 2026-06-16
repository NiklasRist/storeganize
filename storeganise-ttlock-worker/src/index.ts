export interface Env {
	ASSETS: Fetcher;
	DB: D1Database;
	ADMIN_SECRET: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health-Check
		if (url.pathname === "/health") {
			return json({ ok: true });
		}

		// Admin-Endpunkte – brauchen X-Admin-Secret Header
		if (url.pathname.startsWith("/admin/")) {
			if (request.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
				return json({ error: "Unauthorized" }, 401);
			}

			if (url.pathname === "/admin/logs") {
				const { results } = await env.DB
					.prepare("SELECT * FROM error_logs ORDER BY createdAt DESC LIMIT 50")
					.all();
				return json({ logs: results });
			}
		}

		// Alles andere → Frontend
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
