export interface Env {
	ASSETS: Fetcher;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health-Check
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Alles andere → Frontend
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
