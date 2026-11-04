/**
 * Mistral subscription provider for OMP.
 *
 * Registers the provider `mistral-subscription`, which authenticates through
 * Mistral's browser sign-in (the flow Mistral Vibe's CLI uses on
 * console.mistral.ai) and then calls Mistral's chat endpoint with the API key
 * that flow returns. Usage is billed against the Mistral plan attached to the
 * signed-in account (Pro or higher) rather than a separate pay-as-you-go key.
 *
 * The model list is discovered at runtime from the account's own
 * `GET /v1/models` response, so every chat model the plan serves is usable,
 * including models Mistral hosts for Z.ai and DeepSeek. Mistral lists each
 * underlying model under several alias ids that share one
 * `billing_model_name` (e.g. `mistral-medium-latest`, `mistral-medium-3.5`,
 * `mistral-vibe-cli-latest`); those rows are collapsed to one canonical
 * entry so the model picker is not flooded with duplicates.
 *
 * Port of https://github.com/5omeOtherGuy/pi-mistral-subscription to OMP's
 * extension API. `api: "openai-completions"`, because OMP has no
 * `mistral-conversations` transport and its built-in `mistral` provider uses
 * the same wire contract, with a baseUrl carrying the `/v1` suffix that
 * contract needs.
 *
 * Costs are not declared per model: OMP fills them from its bundled catalog
 * by model id, so the reported spend is the public list price where the id is
 * known and zero otherwise. The subscription plan covers these calls, so no
 * invoice matches the figure.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHash, randomBytes } from "node:crypto";

const PROVIDER_ID = "mistral-subscription";
const BASE_URL = "https://api.mistral.ai/v1";

const BROWSER_AUTH_BASE_URL = "https://console.mistral.ai";
const BROWSER_AUTH_API_BASE_URL = "https://console.mistral.ai/api";
const SIGN_IN_PATH = "/vibe/sign-in";
const POLL_INTERVAL_MS = 3000;
const API_KEY_EXPIRES_MS = 10 * 365 * 24 * 60 * 60 * 1000;

type SignInProcess = {
	processId: string;
	signInUrl: string;
	pollUrl: string;
	expiresAt: number;
};

type PollResult = {
	status: "pending" | "completed" | "expired" | "denied" | "error";
	exchangeToken?: string;
	message?: string;
};

type LoginCallbacks = {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	onPrompt?: (prompt: { message: string; placeholder?: string; secret?: boolean }) => Promise<string>;
	signal?: AbortSignal;
};

/** Narrow a decoded JSON body at the network boundary, once per response. */
function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${message}: malformed JSON response`);
	}
	return value as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function requiredString(record: Record<string, unknown>, field: string, message: string): string {
	const value = record[field];
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`${message}: response is missing "${field}"`);
}

/** Reject any URL the sign-in server returns outside its own origin. */
function assertUrlUnder(value: string, baseUrl: string, message: string): string {
	const url = new URL(value);
	const base = new URL(baseUrl);
	if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, ""))) {
		throw new Error(`${message}: unexpected URL ${value}`);
	}
	return value;
}

async function readJson(response: Response, message: string): Promise<unknown> {
	if (!response.ok) throw new Error(`${message}: HTTP ${response.status}`);
	try {
		return await response.json();
	} catch (error) {
		throw new Error(`${message}: malformed JSON response`, { cause: error });
	}
}

async function startSignIn(codeChallenge: string): Promise<SignInProcess> {
	const message = "Failed to start Mistral browser sign-in";
	const response = await fetch(`${BROWSER_AUTH_API_BASE_URL}${SIGN_IN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code_challenge: codeChallenge, code_challenge_method: "S256" }),
	});
	const payload = asRecord(await readJson(response, message), message);

	const expiresAt = Date.parse(requiredString(payload, "expires_at", message));
	if (!Number.isFinite(expiresAt)) throw new Error(`${message}: invalid expires_at`);

	return {
		processId: requiredString(payload, "process_id", message),
		signInUrl: assertUrlUnder(requiredString(payload, "sign_in_url", message), BROWSER_AUTH_BASE_URL, message),
		pollUrl: assertUrlUnder(requiredString(payload, "poll_url", message), BROWSER_AUTH_API_BASE_URL, message),
		expiresAt,
	};
}

async function pollSignIn(pollUrl: string): Promise<PollResult> {
	const message = "Mistral sign-in status unavailable";
	const response = await fetch(assertUrlUnder(pollUrl, BROWSER_AUTH_API_BASE_URL, message));
	if (response.status === 410) return { status: "expired" };
	const payload = asRecord(await readJson(response, message), message);

	const status = payload.status;
	if (status !== "pending" && status !== "completed" && status !== "expired" && status !== "denied" && status !== "error") {
		throw new Error("Mistral sign-in returned an unknown state");
	}
	const exchangeToken = payload.exchange_token;
	const detail = payload.message;
	return {
		status,
		exchangeToken: typeof exchangeToken === "string" && exchangeToken.length > 0 ? exchangeToken : undefined,
		message: typeof detail === "string" && detail.length > 0 ? detail : undefined,
	};
}

async function waitForSignIn(attempt: SignInProcess, callbacks: LoginCallbacks): Promise<string> {
	while (Date.now() < attempt.expiresAt) {
		if (callbacks.signal?.aborted) throw new Error("Mistral sign-in cancelled");
		const result = await pollSignIn(attempt.pollUrl);
		switch (result.status) {
			case "pending": {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, POLL_INTERVAL_MS);
				await promise;
				break;
			}
			case "completed":
				if (result.exchangeToken) return result.exchangeToken;
				throw new Error("Mistral sign-in completed without an exchange token");
			case "expired":
				throw new Error("Mistral sign-in expired, run /login again");
			case "denied":
				throw new Error("Mistral sign-in was denied");
			case "error":
				throw new Error(result.message ?? "Mistral sign-in failed");
		}
	}
	throw new Error("Mistral sign-in timed out");
}

async function exchangeForApiKey(processId: string, exchangeToken: string, codeVerifier: string): Promise<string> {
	const message = "Failed to exchange Mistral sign-in for an API key";
	const response = await fetch(`${BROWSER_AUTH_API_BASE_URL}${SIGN_IN_PATH}/${processId}/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
	});
	const payload = asRecord(await readJson(response, message), message);
	return requiredString(payload, "api_key", message);
}

const mistralOAuth = {
	name: "Mistral subscription (console.mistral.ai sign-in)",
	async login(callbacks: LoginCallbacks) {
		const codeVerifier = randomBytes(64).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
		const attempt = await startSignIn(codeChallenge);
		callbacks.onAuth({
			url: attempt.signInUrl,
			instructions: "Sign in with your Mistral Pro (or higher) account, then return here.",
		});
		callbacks.onProgress?.("Waiting for Mistral sign-in to complete...");
		const exchangeToken = await waitForSignIn(attempt, callbacks);
		callbacks.onProgress?.("Exchanging sign-in for a Mistral API key...");
		const apiKey = await exchangeForApiKey(attempt.processId, exchangeToken, codeVerifier);
		return { access: apiKey, refresh: "mistral-browser-sign-in", expires: Date.now() + API_KEY_EXPIRES_MS };
	},
	async refreshToken(credentials: { access: string; refresh: string; expires: number }) {
		return { ...credentials, expires: Date.now() + API_KEY_EXPIRES_MS };
	},
	getApiKey(credentials: { access: string }) {
		return credentials.access;
	},
};

const TEXT_AND_IMAGE_INPUT = ["text", "image"];
const TEXT_INPUT = ["text"];

type ThinkingSpec = {
	mode: "effort";
	efforts: string[];
	effortMap?: Record<string, string>;
};

// Mistral's own models accept reasoning_effort "none" and "high" only
// (verified against api.mistral.ai on 2026-11-04); map OMP's four levels onto
// that pair.
const MISTRAL_EFFORT: ThinkingSpec = {
	mode: "effort",
	efforts: ["low", "medium", "high", "xhigh"],
	effortMap: { low: "none", medium: "high", high: "high", xhigh: "high" },
};

// Accepted reasoning_effort values per model, verified against api.mistral.ai
// on 2026-11-04. Reasoning models absent from the table fall back to
// MISTRAL_EFFORT; shortcut: hosted third-party models may reject that
// none/high pair until the table is updated.
const THINKING_BY_MODEL: Record<string, ThinkingSpec> = {
	"mistral-large-4": { mode: "effort", efforts: ["low", "medium", "high"] },
	"zai-glm-5-3": { mode: "effort", efforts: ["low", "high", "max"] },
	"zai-glm-5-3-flash": { mode: "effort", efforts: ["low", "high", "max"] },
	"zai-glm-5-2": { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
	"deepseek-v4-1-flash-1017": { mode: "effort", efforts: ["low", "high", "xhigh", "max"] },
};

// Mistral's chat API never accepts reasoning_content in message history
// (extra_forbidden 422), and emits assistant thinking as content parts.
// OMP's bundled catalog pins this behavior to the provider id "mistral"
// (providers/mistral.kdl:3); it does not match a custom provider id, so the
// same wire compat is declared here for every discovered row.
const MISTRAL_WIRE = {
	supportsPromptCacheKey: true,
	requiresReasoningContentForToolCalls: false,
	requiresReasoningContentForAllAssistantTurns: false,
	mistralReasoningContentParts: true,
};

type DiscoveredModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinking?: ThinkingSpec;
	input: string[];
	contextWindow: number;
	supportsTools: boolean;
	compat: {
		supportsPromptCacheKey: boolean;
		requiresReasoningContentForToolCalls: boolean;
		requiresReasoningContentForAllAssistantTurns: boolean;
		mistralReasoningContentParts: boolean;
	};
};

function prettify(id: string): string {
	return id
		.replaceAll("-", " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.replace(/\bDeepseek\b/, "DeepSeek")
		.replace(/\bGlm\b/g, "GLM")
		.replace(/\bZai\b/g, "Z.ai");
}

/** Prefer dated ids (mistral-medium-2604) over aliases (mistral-medium-latest). */
function canonicalRank(id: string, billing: string): number {
	if (/\d{4}$/.test(id)) return 0;
	return id === billing ? 1 : 2;
}

function toModelRow(raw: Record<string, unknown>): DiscoveredModel {
	const id = raw.id as string;
	const capabilities = asObject(raw.capabilities) ?? {};
	const contextWindow =
		typeof raw.max_context_length === "number" && raw.max_context_length > 0 ? raw.max_context_length : 131072;
	const reasoning = capabilities.reasoning === true;
	// maxTokens is left unset on purpose: OMP fills it from its bundled catalog
	// by model id, and falls back to a conservative 16384 for unknown ids.
	return {
		id,
		name: prettify(id),
		reasoning,
		...reasoning ? { thinking: THINKING_BY_MODEL[id] ?? MISTRAL_EFFORT } : {},
		input: capabilities.vision === true ? TEXT_AND_IMAGE_INPUT : TEXT_INPUT,
		contextWindow,
		supportsTools: capabilities.function_calling !== false,
		compat: MISTRAL_WIRE,
	};
}

/**
 * List every chat model the signed-in account can use. Called by OMP with the
 * OAuth credential's access token; the result is cached for 24 h.
 */
async function fetchMistralModels(apiKey?: string): Promise<DiscoveredModel[]> {
	if (!apiKey) return [];
	const message = "Mistral model list unavailable";
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
	});
	const payload = asRecord(await readJson(response, message), message);
	if (!Array.isArray(payload.data)) throw new Error(`${message}: malformed JSON response`);

	// Collapse alias rows (one billing_model_name, many ids) to one entry, and
	// skip rows that cannot serve chat completions (embeddings, OCR, TTS...).
	const canonical = new Map<string, Record<string, unknown>>();
	for (const entry of payload.data) {
		const raw = asObject(entry);
		if (!raw || typeof raw.id !== "string" || raw.id.length === 0) continue;
		if ((asObject(raw.capabilities)?.completion_chat ?? false) !== true) continue;
		const billing =
			typeof raw.billing_model_name === "string" && raw.billing_model_name.length > 0
				? raw.billing_model_name
				: raw.id;
		const winner = canonical.get(billing);
		if (!winner || canonicalRank(raw.id, billing) < canonicalRank(winner.id as string, billing)) {
			canonical.set(billing, raw);
		}
	}
	return [...canonical.values()].map(toModelRow);
}

export default function mistralSubscription(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		api: "openai-completions",
		authHeader: true,
		oauth: mistralOAuth,
		fetchDynamicModels: fetchMistralModels,
	});

	pi.registerCommand("mistral-subscription-status", {
		description: "Show how the Mistral subscription provider is configured",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`${PROVIDER_ID}: browser sign-in on console.mistral.ai, models discovered live from ${BASE_URL}/models over openai-completions.`,
				"info",
			);
		},
	});
}
