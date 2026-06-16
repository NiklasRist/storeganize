/**
 * TTLock ↔ Storeganise Worker – Blueprint
 *
 * Flows:
 *  - POST /webhook/storeganise  → Move-In / Move-Out / Overdue
 *  - POST /access-code/rotate   → Code-Rotation (Admin)
 *  - GET  /admin/logs           → Fehler-Logs (Admin)
 *  - DELETE /admin/logs/old     → manuelles Log-Cleanup (Admin)
 *  - GET  /health               → Health-Check
 *
 * Source of Truth:
 *  - Storeganise Custom Fields: lockId, keyboardPwdId pro Unit
 *  - TTLock Cloud: alle Passcodes
 *  - D1: nur Fehler-Logs
 */

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;

	// Secrets (per `wrangler secret put`)
	TTLOCK_CLIENT_ID: string;
	TTLOCK_CLIENT_SECRET: string;
	TTLOCK_ACCESS_TOKEN: string;   // TTLock OAuth Access Token
	STOREGANISE_API_KEY: string;
	STOREGANISE_WEBHOOK_SECRET: string;
	ADMIN_SECRET: string;
}

interface StoreganiseUnit {
	id: string;
	customFields?: {
		ttlockLockId?: string;       // Custom Field: TTLock Lock-ID
		ttlockKeyboardPwdId?: string; // Custom Field: aktuelle keyboardPwdId
	};
}

interface StoreganiseJob {
	id: string;
	unitId: string;
	unitRentalId: string;
	customerId?: string;
}

// ─── Konstanten ──────────────────────────────────────────────────────────────

const TTLOCK_BASE = "https://euapi.ttlock.com/v3";
const STOREGANISE_BASE = "https://api.storeganise.com/api/v1";
// Passcode-Typ: 2 = permanent (bleibt bis manuell gelöscht)
const TTLOCK_ADD_TYPE = 2;
// Lösch-Typ: 2 = via Gateway (kein Bluetooth nötig)
const TTLOCK_DELETE_TYPE = 2;
// Log-Aufbewahrung in Tagen
const LOG_RETENTION_DAYS = 90;

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		// Health-Check (kein Auth nötig)
		if (method === "GET" && url.pathname === "/health") {
			return json({ ok: true, service: "storeganise-ttlock-worker" });
		}

		// Webhook von Storeganise
		if (method === "POST" && url.pathname === "/webhook/storeganise") {
			return handleStoreganiseWebhook(request, env);
		}

		// Admin-Endpunkte – alle brauchen X-Admin-Secret Header
		if (!isAdminAuthed(request, env)) {
			return json({ error: "Unauthorized" }, 401);
		}

		if (method === "POST" && url.pathname === "/access-code/rotate") {
			return handleRotate(request, env);
		}
		if (method === "GET" && url.pathname === "/admin/logs") {
			return handleGetLogs(request, env);
		}
		if (method === "DELETE" && url.pathname === "/admin/logs/old") {
			return handleDeleteOldLogs(env);
		}

		// Alles andere → Admin-Frontend (statische Assets)
		return env.ASSETS.fetch(request);
	},

	// Cron Trigger – läuft täglich und räumt alte Logs weg
	async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
		await deleteOldLogs(env);
	},
} satisfies ExportedHandler<Env>;

// ─── Auth ────────────────────────────────────────────────────────────────────

function isAdminAuthed(request: Request, env: Env): boolean {
	return request.headers.get("X-Admin-Secret") === env.ADMIN_SECRET;
}

async function verifyStoreganiseWebhook(
	request: Request,
	rawBody: string,
	env: Env
): Promise<boolean> {
	// Storeganise signiert mit HMAC-SHA256 base64 über den raw body
	const signature = request.headers.get("sg-signature");
	if (!signature) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(env.STOREGANISE_WEBHOOK_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
	const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
	return expected === signature;
}

// ─── Webhook Handler ─────────────────────────────────────────────────────────

async function handleStoreganiseWebhook(request: Request, env: Env): Promise<Response> {
	const rawBody = await request.text();

	// Signatur prüfen
	if (!await verifyStoreganiseWebhook(request, rawBody, env)) {
		return json({ error: "Invalid signature" }, 401);
	}

	let payload: { id: string; type: string; data: { jobId?: string } };
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	const { type, data } = payload;

	// Idempotenz: gleicher Webhook kann mehrfach kommen
	// Storeganise schickt bei Fehler bis zu 3x – wir prüfen ob wir den Job kennen
	if (data.jobId) {
		const alreadyProcessed = await wasJobProcessed(env, data.jobId);
		if (alreadyProcessed) {
			return json({ ok: true, note: "already processed" });
		}
	}

	try {
		switch (type) {
			case "job.unit_moveIn.completed":
				await handleMoveIn(env, data.jobId!);
				break;

			case "job.unit_moveOut.completed":
				await handleMoveOut(env, data.jobId!);
				break;

			case "unitRental.markOverdue":
				// Bei Überfälligkeit: Code löschen wie Move-Out
				await handleMoveOut(env, data.jobId!);
				break;

			case "unitRental.unmarkOverdue":
				// Bei Entsperrung: neuen Code erstellen wie Move-In
				await handleMoveIn(env, data.jobId!);
				break;

			default:
				// Unbekannte Events stillschweigend ignorieren
				return json({ ok: true, note: "event ignored" });
		}

		return json({ ok: true });
	} catch (err) {
		// Nur Fehler loggen
		await logError(env, {
			source: "storeganise_webhook",
			action: type,
			jobId: data.jobId,
			error: String(err),
		});
		// 200 zurückgeben damit Storeganise nicht endlos retryt
		// Der Fehler ist intern geloggt, Admin sieht ihn im Dashboard
		return json({ ok: true, note: "logged error" });
	}
}

// ─── Move-In Flow ────────────────────────────────────────────────────────────

async function handleMoveIn(env: Env, jobId: string): Promise<void> {
	// 1. Job-Details von Storeganise laden
	const job = await getStoreganiseJob(env, jobId);

	// 2. Unit laden → lockId aus Custom Field
	const unit = await getStoreganiseUnit(env, job.unitId);
	const lockId = unit.customFields?.ttlockLockId;
	if (!lockId) throw new Error(`No lockId configured for unit ${job.unitId}`);

	// 3. Falls schon ein Code existiert: erst löschen (Idempotenz)
	const existingPwdId = unit.customFields?.ttlockKeyboardPwdId;
	if (existingPwdId) {
		await ttlockDeletePasscode(env, Number(lockId), Number(existingPwdId));
	}

	// 4. Neuen Code generieren (6-stellig)
	const newCode = generatePasscode();

	// 5. Code bei TTLock erstellen
	const { keyboardPwdId } = await ttlockCreatePasscode(env, {
		lockId: Number(lockId),
		keyboardPwd: newCode,
		keyboardPwdName: `rental-${job.unitRentalId}`,
	});

	// 6. keyboardPwdId in Storeganise Custom Field speichern
	await updateStoreganiseUnitCustomFields(env, job.unitId, {
		ttlockKeyboardPwdId: String(keyboardPwdId),
	});

	// Kein Log bei Erfolg – Storeganise und TTLock sind die Source of Truth
}

// ─── Move-Out Flow ───────────────────────────────────────────────────────────

async function handleMoveOut(env: Env, jobId: string): Promise<void> {
	const job = await getStoreganiseJob(env, jobId);
	const unit = await getStoreganiseUnit(env, job.unitId);

	const lockId = unit.customFields?.ttlockLockId;
	const keyboardPwdId = unit.customFields?.ttlockKeyboardPwdId;

	if (!lockId || !keyboardPwdId) {
		// Kein Code vorhanden – nichts zu tun
		return;
	}

	// Code bei TTLock löschen
	await ttlockDeletePasscode(env, Number(lockId), Number(keyboardPwdId));

	// Custom Field leeren – kein aktiver Code mehr
	await updateStoreganiseUnitCustomFields(env, job.unitId, {
		ttlockKeyboardPwdId: "",
	});
}

// ─── Code Rotation ───────────────────────────────────────────────────────────

async function handleRotate(request: Request, env: Env): Promise<Response> {
	const body = await request.json<{ unitRentalId: string; reason?: string }>();
	if (!body.unitRentalId) return json({ error: "unitRentalId required" }, 400);

	// Unit über unitRentalId finden
	const unit = await findUnitByRentalId(env, body.unitRentalId);
	const lockId = unit.customFields?.ttlockLockId;
	const keyboardPwdId = unit.customFields?.ttlockKeyboardPwdId;

	if (!lockId) return json({ error: "No lockId for this unit" }, 400);

	// 1. Alten Code löschen (falls vorhanden)
	if (keyboardPwdId) {
		try {
			await ttlockDeletePasscode(env, Number(lockId), Number(keyboardPwdId));
		} catch (err) {
			// Delete fehlgeschlagen → kein neuer Code
			await logError(env, {
				source: "rotate",
				action: "delete_passcode",
				unitRentalId: body.unitRentalId,
				error: String(err),
			});
			return json({ error: "Failed to delete old code – no new code created" }, 500);
		}
	}

	// 2. Neuen Code erstellen
	const newCode = generatePasscode();
	let newKeyboardPwdId: number;
	try {
		const result = await ttlockCreatePasscode(env, {
			lockId: Number(lockId),
			keyboardPwd: newCode,
			keyboardPwdName: `rental-${body.unitRentalId}-rotated`,
		});
		newKeyboardPwdId = result.keyboardPwdId;
	} catch (err) {
		// Alter Code weg, neuer nicht erstellt – kritischer Fehler loggen
		await logError(env, {
			source: "rotate",
			action: "create_passcode",
			unitRentalId: body.unitRentalId,
			error: `OLD CODE DELETED, NEW CODE FAILED: ${err}`,
		});
		return json({ error: "Old code deleted but new code creation failed – check logs" }, 500);
	}

	// 3. Neue keyboardPwdId speichern
	await updateStoreganiseUnitCustomFields(env, unit.id, {
		ttlockKeyboardPwdId: String(newKeyboardPwdId),
	});

	// Neuen Code einmalig zurückgeben (wird nicht gespeichert)
	return json({
		ok: true,
		newCode,       // ← einmalig im Response, danach nirgendwo mehr
		maskedCode: maskCode(newCode),
	});
}

// ─── Admin: Logs ─────────────────────────────────────────────────────────────

async function handleGetLogs(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const limit = Number(url.searchParams.get("limit") ?? 50);
	const unitRentalId = url.searchParams.get("unitRentalId");
	const action = url.searchParams.get("action");

	let query = "SELECT * FROM error_logs WHERE 1=1";
	const params: (string | number)[] = [];

	if (unitRentalId) { query += " AND unitRentalId = ?"; params.push(unitRentalId); }
	if (action) { query += " AND action = ?"; params.push(action); }
	query += " ORDER BY createdAt DESC LIMIT ?";
	params.push(limit);

	const { results } = await env.DB.prepare(query).bind(...params).all();
	return json({ logs: results });
}

async function handleDeleteOldLogs(env: Env): Promise<Response> {
	const deleted = await deleteOldLogs(env);
	return json({ ok: true, deleted });
}

async function deleteOldLogs(env: Env): Promise<number> {
	const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	const result = await env.DB
		.prepare("DELETE FROM error_logs WHERE createdAt < ?")
		.bind(cutoff)
		.run();
	return result.meta.changes ?? 0;
}

// ─── Idempotenz ──────────────────────────────────────────────────────────────

async function wasJobProcessed(env: Env, jobId: string): Promise<boolean> {
	const row = await env.DB
		.prepare("SELECT id FROM processed_jobs WHERE jobId = ?")
		.bind(jobId)
		.first();
	if (row) return true;

	// Jetzt als verarbeitet markieren
	await env.DB
		.prepare("INSERT INTO processed_jobs (jobId, processedAt) VALUES (?, ?)")
		.bind(jobId, Date.now())
		.run();
	return false;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

async function logError(env: Env, data: {
	source: string;
	action: string;
	jobId?: string;
	unitRentalId?: string;
	error: string;
}): Promise<void> {
	await env.DB
		.prepare(`
      INSERT INTO error_logs (source, action, jobId, unitRentalId, error, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
		.bind(
			data.source,
			data.action,
			data.jobId ?? null,
			data.unitRentalId ?? null,
			data.error,
			Date.now()
		)
		.run();
}

// ─── TTLock API ──────────────────────────────────────────────────────────────

async function ttlockCreatePasscode(
	env: Env,
	params: { lockId: number; keyboardPwd: string; keyboardPwdName: string }
): Promise<{ keyboardPwdId: number; keyboardPwd: string }> {
	const body = new URLSearchParams({
		clientId: env.TTLOCK_CLIENT_ID,
		accessToken: env.TTLOCK_ACCESS_TOKEN,
		lockId: String(params.lockId),
		keyboardPwd: params.keyboardPwd,
		keyboardPwdName: params.keyboardPwdName,
		addType: String(TTLOCK_ADD_TYPE),
		date: String(Date.now()),
	});

	const res = await fetch(`${TTLOCK_BASE}/keyboardPwd/add`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	const data = await res.json<{ errcode: number; errmsg: string; keyboardPwdId: number }>();
	if (data.errcode !== 0) {
		throw new Error(`TTLock createPasscode failed: ${data.errmsg} (${data.errcode})`);
	}

	return { keyboardPwdId: data.keyboardPwdId, keyboardPwd: params.keyboardPwd };
}

async function ttlockDeletePasscode(
	env: Env,
	lockId: number,
	keyboardPwdId: number
): Promise<void> {
	const body = new URLSearchParams({
		clientId: env.TTLOCK_CLIENT_ID,
		accessToken: env.TTLOCK_ACCESS_TOKEN,
		lockId: String(lockId),
		keyboardPwdId: String(keyboardPwdId),
		deleteType: String(TTLOCK_DELETE_TYPE),
		date: String(Date.now()),
	});

	const res = await fetch(`${TTLOCK_BASE}/keyboardPwd/delete`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	const data = await res.json<{ errcode: number; errmsg: string }>();
	if (data.errcode !== 0) {
		throw new Error(`TTLock deletePasscode failed: ${data.errmsg} (${data.errcode})`);
	}
}

// ─── Storeganise API ─────────────────────────────────────────────────────────

async function getStoreganiseJob(env: Env, jobId: string): Promise<StoreganiseJob> {
	const res = await fetch(`${STOREGANISE_BASE}/admin/jobs/${jobId}`, {
		headers: { "X-API-Key": env.STOREGANISE_API_KEY },
	});
	if (!res.ok) throw new Error(`Storeganise getJob failed: ${res.status}`);
	return res.json<StoreganiseJob>();
}

async function getStoreganiseUnit(env: Env, unitId: string): Promise<StoreganiseUnit> {
	const res = await fetch(`${STOREGANISE_BASE}/admin/units/${unitId}`, {
		headers: { "X-API-Key": env.STOREGANISE_API_KEY },
	});
	if (!res.ok) throw new Error(`Storeganise getUnit failed: ${res.status}`);
	return res.json<StoreganiseUnit>();
}

async function findUnitByRentalId(env: Env, unitRentalId: string): Promise<StoreganiseUnit> {
	const res = await fetch(`${STOREGANISE_BASE}/admin/unitRentals/${unitRentalId}`, {
		headers: { "X-API-Key": env.STOREGANISE_API_KEY },
	});
	if (!res.ok) throw new Error(`Storeganise getUnitRental failed: ${res.status}`);
	const rental = await res.json<{ unitId: string }>();
	return getStoreganiseUnit(env, rental.unitId);
}

async function updateStoreganiseUnitCustomFields(
	env: Env,
	unitId: string,
	fields: Record<string, string>
): Promise<void> {
	const res = await fetch(`${STOREGANISE_BASE}/admin/units/${unitId}`, {
		method: "PATCH",
		headers: {
			"X-API-Key": env.STOREGANISE_API_KEY,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ customFields: fields }),
	});
	if (!res.ok) throw new Error(`Storeganise updateUnit failed: ${res.status}`);
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function generatePasscode(): string {
	// 6-stellig, kryptografisch zufällig
	const array = new Uint32Array(1);
	crypto.getRandomValues(array);
	return String(array[0] % 900000 + 100000); // 100000–999999
}

function maskCode(code: string): string {
	return "****" + code.slice(-2);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
