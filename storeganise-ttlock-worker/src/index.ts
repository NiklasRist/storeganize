export interface Env {
	ASSETS: Fetcher;
	DB: D1Database;
	ADMIN_SECRET: string;
	STOREGANISE_WEBHOOK_SECRET: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health-Check
		if (url.pathname === "/health") {
			return json({ ok: true });
		}

		// Webhook von Storeganise
		if (request.method === "POST" && url.pathname === "/webhook/storeganise") {
			return handleWebhook(request, env);
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

// ─── Webhook ─────────────────────────────────────────────────────────────────

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const rawBody = await request.text();

	// Signatur prüfen
	if (!await verifySignature(rawBody, request.headers.get("sg-signature") ?? "", env)) {
		return json({ error: "Invalid signature" }, 401);
	}

	let payload: { type: string; data: { jobId?: string } };
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	// Vorerst nur loggen was reinkommt
	console.log("Webhook received:", payload.type, payload.data);

	return json({ ok: true, received: payload.type });
}

async function verifySignature(body: string, signature: string, env: Env): Promise<boolean> {
	if (!signature) return false;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(env.STOREGANISE_WEBHOOK_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
	return expected === signature;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
