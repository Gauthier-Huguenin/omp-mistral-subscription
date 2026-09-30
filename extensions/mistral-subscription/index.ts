/**
 * Mistral subscription provider for OMP.
 *
 * Registers the provider `mistral-subscription`, which authenticates through
 * Mistral's browser sign-in (the flow Mistral Vibe's CLI uses on
 * console.mistral.ai) and then calls Mistral's chat endpoint with the API key
 * that flow returns. Usage is billed against the Mistral plan attached to the
 * signed-in account (Pro or higher) rather than a separate pay-as-you-go key.
 *
 * Port of https://github.com/5omeOtherGuy/pi-mistral-subscription to OMP's
 * extension API. Two differences: `api: "openai-completions"`, because OMP has
 * no `mistral-conversations` transport and its built-in `mistral` provider uses
 * the same wire contract, and a baseUrl carrying the `/v1` suffix that contract
 * needs.
 *
 * Model costs are Mistral's public list prices (USD per million tokens) for the
 * same models, so OMP reports a notional spend. The subscription plan covers
 * these calls, so no invoice matches the figure.
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
// Mistral accepts reasoning_effort values "none" and "high" only.
const MISTRAL_THINKING = {
	mode: "effort",
	efforts: ["low", "medium", "high", "xhigh"],
	effortMap: { low: "none", medium: "high", high: "high", xhigh: "high" },
};

export default function mistralSubscription(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		api: "openai-completions",
		authHeader: true,
		oauth: mistralOAuth,
		models: [
			{
				id: "mistral-medium-2604",
				name: "Mistral Medium 3.5 (subscription)",
				reasoning: true,
				thinking: MISTRAL_THINKING,
				input: TEXT_AND_IMAGE_INPUT,
				cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
			},
			{
				id: "mistral-small-latest",
				name: "Mistral Small 4 (subscription)",
				reasoning: true,
				thinking: MISTRAL_THINKING,
				input: TEXT_AND_IMAGE_INPUT,
				cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
				contextWindow: 256000,
				maxTokens: 32768,
			},
			{
				id: "mistral-large-latest",
				name: "Mistral Large 3 (subscription)",
				reasoning: false,
				input: TEXT_AND_IMAGE_INPUT,
				cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
			},
			{
				id: "devstral-medium-latest",
				name: "Devstral 2 (subscription)",
				reasoning: false,
				input: TEXT_INPUT,
				cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
			},
			{
				id: "ministral-14b-2512",
				name: "Ministral 3 14B (subscription)",
				reasoning: false,
				input: TEXT_AND_IMAGE_INPUT,
				cost: { input: 0.2, output: 0.2, cacheRead: 0.02, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
			},
			{
				id: "ministral-8b-2512",
				name: "Ministral 3 8B (subscription)",
				reasoning: false,
				input: TEXT_AND_IMAGE_INPUT,
				cost: { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 32768,
			},
			{
				id: "ministral-3b-2512",
				name: "Ministral 3 3B (subscription)",
				reasoning: false,
				input: TEXT_AND_IMAGE_INPUT,
				cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 32768,
			},
			// Z.ai models hosted by Mistral (owned_by mistralai, billing_model_name
			// zai-glm-*). No thinking surface is declared: Mistral exposes no
			// documented reasoning_effort control for them. zai-glm-5-2 is not
			// listed: deprecated since 2026-09-29, removed 2026-10-31, superseded
			// by GLM 5.3.
			{
				id: "zai-glm-5-3",
				name: "Z.ai GLM 5.3 via Mistral (subscription)",
				reasoning: true,
				input: TEXT_INPUT,
				cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 32768,
			},
		],
	});

	pi.registerCommand("mistral-subscription-status", {
		description: "Show how the Mistral subscription provider is configured",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`${PROVIDER_ID}: browser sign-in on console.mistral.ai, models served from ${BASE_URL} over openai-completions.`,
				"info",
			);
		},
	});
}
