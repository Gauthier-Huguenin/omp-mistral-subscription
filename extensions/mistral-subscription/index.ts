/**
 * Mistral subscription provider for OMP.
 *
 * This mirrors how Mistral Vibe (https://github.com/mistralai/mistral-vibe)
 * authenticates and sends model requests:
 *
 *  - Sign-in: `POST https://console.mistral.ai/api/vibe/sign-in` with a PKCE
 *    S256 challenge, then poll the returned URL and exchange the one-time
 *    token for an API key. The key is tied to the Mistral plan on the
 *    signed-in account (Vibe Code / Pro), not a separate pay-as-you-go key.
 *  - Chat: `POST https://api.mistral.ai/v1/chat/completions` with
 *    `Authorization: Bearer <key>`, Vibe's client User-Agent, and the
 *    `mistral-vibe-cli-*` model IDs. Vibe's default wire model is
 *    `mistral-vibe-cli-latest`.
 *  - Mistral wire details: reasoning arrives as typed `thinking` content
 *    parts, tool-call IDs are 9 alphanumerics, and `prompt_cache_key` drives
 *    cache affinity. The `compat` block below enables the first and third;
 *    the URL-based `mistral` host rules in OMP supply the rest.
 *
 *  - Pricing: Mistral's published per-token list prices (fetched from the
 *    pricing page, with static fallbacks) so model and cost displays are not
 *    zero just because the account pays a plan.
 *  - Usage: the console cookie feeds `/usage` two monthly meters, Vibe Code
 *    usage and Included API usage. Set it with `/mistral set-cookie` or
 *    `MISTRAL_COOKIE`; the cookie needs `csrftoken` and an `ory_session_*`.
 *  - Billing bucket: `/mistral budget vibe|api` (persisted in
 *    ~/.omp/agent/mistral-subscription-budget.txt, env MISTRAL_BUDGET_MODE)
 *    chooses whether requests carry metadata.call_source=vibe_code (billed to
 *    the Vibe Code quota) or omit it (billed to the plan's Included API budget).
 *
 *
 * The model roster is discovered from `/v1/models` after login; a small
 * static fallback makes the provider usable before the first refresh.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { FetchImpl, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_ID = "mistral-subscription";
const API_BASE = "https://api.mistral.ai/v1";
const CONSOLE_BASE = "https://console.mistral.ai";
const CONSOLE_API = `${CONSOLE_BASE}/api`;
const SIGN_IN_PATH = "/vibe/sign-in";
const PRICING_URL = "https://docs.mistral.ai/inference/pricing.md";
const SUBSCRIPTION_URL = "https://admin.mistral.ai/subscription";
const COOKIE_PATH = join(homedir(), ".omp", "agent", "mistral-subscription-cookie.txt");
const BUDGET_PATH = join(homedir(), ".omp", "agent", "mistral-subscription-budget.txt");

/** Which plan bucket requests bill against: "vibe" (Vibe Code quota) or "api" (Included API). */
type BudgetMode = "vibe" | "api";


/** Matches `get_user_agent("mistral")` in Mistral Vibe. */
const USER_AGENT = "mistral-client-python/Mistral-Vibe/3.1.2";

const POLL_INTERVAL_MS = 3_000;
const POLL_FAILURE_LIMIT = 3;
const REQUEST_TIMEOUT_MS = 30_000;
/** A Vibe browser-sign-in key has no published expiry; do not force re-login. */
const KEY_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_TOKENS = 32_768;
const MISTRAL_THINKING: NonNullable<ProviderModelConfig["thinking"]> = {
	mode: "effort",
	efforts: ["minimal", "low", "medium", "high", "xhigh"],
};

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

const FREE_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MEDIUM_COST: ModelCost = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 };
const SMALL_COST: ModelCost = { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 };
const LARGE_COST: ModelCost = { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 };
const CODESTRAL_COST: ModelCost = { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 };
const MINISTRAL_14B_COST: ModelCost = { input: 0.2, output: 0.2, cacheRead: 0.02, cacheWrite: 0 };
const MINISTRAL_8B_COST: ModelCost = { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 };
const MINISTRAL_3B_COST: ModelCost = { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0 };
const GLM_53_COST: ModelCost = { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 };
const GLM_53_FLASH_COST: ModelCost = { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 };
const DEEPSEEK_FLASH_COST: ModelCost = { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 };

/**
 * Reference prices from Vibe's model card and Mistral's pricing page. The
 * account pays a plan, so these are list prices rather than marginal cost;
 * live values parsed from the pricing page replace them when available.
 */
const STATIC_PRICING: Record<string, ModelCost> = {
	"mistral-medium-latest": MEDIUM_COST,
	"mistral-medium": MEDIUM_COST,
	"mistral-medium-3.5": MEDIUM_COST,
	"mistral-medium-3-5": MEDIUM_COST,
	"mistral-medium-3": MEDIUM_COST,
	"mistral-medium-2604": MEDIUM_COST,
	"magistral-medium-latest": MEDIUM_COST,
	"mistral-vibe-cli-latest": MEDIUM_COST,
	"mistral-vibe-cli-with-tools": MEDIUM_COST,
	"mistral-vibe-cli-fast": SMALL_COST,
	"mistral-small-2603": SMALL_COST,
	"mistral-small-latest": SMALL_COST,
	"magistral-small-latest": SMALL_COST,
	"mistral-large-4": LARGE_COST,
	"mistral-large-4-0": LARGE_COST,
	"mistral-large-4-0-a": LARGE_COST,
	"mistral-large-latest": LARGE_COST,
	"codestral-2508": CODESTRAL_COST,
	"codestral-latest": CODESTRAL_COST,
	"mistral-code-latest": CODESTRAL_COST,
	"mistral-code-fim-latest": CODESTRAL_COST,
	"ministral-14b-2512": MINISTRAL_14B_COST,
	"ministral-14b-latest": MINISTRAL_14B_COST,
	"ministral-8b-2512": MINISTRAL_8B_COST,
	"ministral-8b-latest": MINISTRAL_8B_COST,
	"ministral-3b-2512": MINISTRAL_3B_COST,
	"ministral-3b-latest": MINISTRAL_3B_COST,
	"zai-glm-5-3": GLM_53_COST,
	"zai-glm-5-3-flash": GLM_53_FLASH_COST,
	"zai-glm-5": GLM_53_COST,
	"zai-glm-latest": GLM_53_COST,
	"deepseek-v4-1-flash-1017": DEEPSEEK_FLASH_COST,
	"voxtral-small-2507": { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
	"voxtral-small-latest": { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
};

function familyPrice(id: string): ModelCost | undefined {
	if (id.startsWith("mistral-vibe-cli-fast") || id.startsWith("mistral-small")) return SMALL_COST;
	if (id.startsWith("mistral-vibe-cli") || id.startsWith("mistral-medium")) return MEDIUM_COST;
	if (id.startsWith("mistral-large")) return LARGE_COST;
	if (id.startsWith("codestral") || id.startsWith("mistral-code")) return CODESTRAL_COST;
	if (id.startsWith("ministral-14b")) return MINISTRAL_14B_COST;
	if (id.startsWith("ministral-8b")) return MINISTRAL_8B_COST;
	if (id.startsWith("ministral-3b")) return MINISTRAL_3B_COST;
	if (id.startsWith("zai-glm-5-3-flash")) return GLM_53_FLASH_COST;
	if (id.startsWith("zai-glm-5-3") || id.startsWith("zai-glm-latest")) return GLM_53_COST;
	if (id.startsWith("deepseek-v4-1-flash")) return DEEPSEEK_FLASH_COST;
	return undefined;
}

function priceFor(id: string, billingModel: string | undefined, live: Record<string, ModelCost>): ModelCost {
	const liveCost = live[id] ?? (billingModel ? live[billingModel] : undefined);
	const staticCost =
		STATIC_PRICING[id] ??
		(billingModel ? STATIC_PRICING[billingModel] : undefined) ??
		familyPrice(id) ??
		FREE_COST;
	if (!liveCost) return staticCost;
	return {
		input: liveCost.input,
		output: liveCost.output,
		// The pricing page omits cached-input for some models; keep the known rate.
		cacheRead: liveCost.cacheRead > 0 ? liveCost.cacheRead : staticCost.cacheRead,
		cacheWrite: 0,
	};
}

type BudgetAllowance = {
	usedPercent: number;
	total: number;
	currency: string;
	resetAt: number | null;
};

type ConsoleCookie = { cookie: string; csrfToken: string };

type SignInProcess = {
	processId: string;
	signInUrl: string;
	pollUrl: string;
	expiresAt: number;
};

type SignInPoll = {
	status: "pending" | "completed" | "expired" | "denied" | "error";
	exchangeToken?: string;
	message?: string;
};

type OAuthCredentials = {
	access: string;
	refresh: string;
	expires: number;
};

type OAuthCallbacks = {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
};

type MistralModel = {
	id?: unknown;
	name?: unknown;
	max_context_length?: unknown;
	deprecation?: unknown;
	billing_model_name?: unknown;
	capabilities?: {
		completion_chat?: unknown;
		reasoning?: unknown;
		vision?: unknown;
	} | null;
};

function asRecord(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context}: malformed JSON response`);
	}
	return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`${context}: response is missing "${key}"`);
}

async function readJson(response: Response, context: string): Promise<unknown> {
	if (!response.ok) throw new Error(`${context}: HTTP ${response.status}`);
	try {
		return await response.json();
	} catch (error) {
		throw new Error(`${context}: malformed JSON response`, { cause: error });
	}
}

/** Keep every returned URL on the console origin that issued it. */
function assertUnder(value: string, base: string, context: string): string {
	const url = new URL(value);
	const origin = new URL(base);
	if (url.origin !== origin.origin || !url.pathname.startsWith(origin.pathname.replace(/\/$/, ""))) {
		throw new Error(`${context}: unexpected URL ${value}`);
	}
	return value;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(64).toString("base64url");
	const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
	return { verifier, challenge };
}

async function startSignIn(challenge: string, signal?: AbortSignal): Promise<SignInProcess> {
	const context = "Failed to start Mistral browser sign-in";
	const response = await fetch(`${CONSOLE_API}${SIGN_IN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const payload = asRecord(await readJson(response, context), context);
	const expiresAt = Date.parse(requiredString(payload, "expires_at", context));
	if (!Number.isFinite(expiresAt)) throw new Error(`${context}: invalid expires_at`);
	return {
		processId: requiredString(payload, "process_id", context),
		signInUrl: assertUnder(requiredString(payload, "sign_in_url", context), CONSOLE_BASE, context),
		pollUrl: assertUnder(requiredString(payload, "poll_url", context), CONSOLE_API, context),
		expiresAt,
	};
}

async function pollSignIn(process: SignInProcess, signal?: AbortSignal): Promise<SignInPoll> {
	const context = "Mistral sign-in status unavailable";
	const response = await fetch(assertUnder(process.pollUrl, CONSOLE_API, context), {
		signal: requestSignal(signal),
	});
	if (response.status === 410) return { status: "expired" };
	const payload = asRecord(await readJson(response, context), context);
	const status = payload.status;
	if (status !== "pending" && status !== "completed" && status !== "expired" && status !== "denied" && status !== "error") {
		throw new Error(`${context}: unknown state`);
	}
	const exchangeToken = payload.exchange_token;
	const message = payload.message;
	return {
		status,
		exchangeToken: typeof exchangeToken === "string" && exchangeToken.length > 0 ? exchangeToken : undefined,
		message: typeof message === "string" && message.length > 0 ? message : undefined,
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(signal.reason ?? new Error("Mistral sign-in cancelled"));
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal?.reason ?? new Error("Mistral sign-in cancelled"));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

async function waitForSignIn(process: SignInProcess, callbacks: OAuthCallbacks): Promise<string> {
	let failures = 0;
	while (Date.now() < process.expiresAt) {
		let result: SignInPoll;
		try {
			result = await pollSignIn(process, callbacks.signal);
			failures = 0;
		} catch (error) {
			if (callbacks.signal?.aborted) throw error;
			if (++failures >= POLL_FAILURE_LIMIT) throw error;
			await sleep(POLL_INTERVAL_MS, callbacks.signal);
			continue;
		}

		switch (result.status) {
			case "pending":
				await sleep(POLL_INTERVAL_MS, callbacks.signal);
				break;
			case "completed":
				if (result.exchangeToken) return result.exchangeToken;
				throw new Error("Mistral sign-in completed without an exchange token");
			case "expired":
				throw new Error("Mistral sign-in expired; run /login again");
			case "denied":
				throw new Error("Mistral sign-in was denied");
			case "error":
				throw new Error(result.message ?? "Mistral sign-in failed");
		}
	}
	throw new Error("Mistral sign-in timed out");
}

async function exchangeForApiKey(
	process: SignInProcess,
	exchangeToken: string,
	codeVerifier: string,
	signal?: AbortSignal,
): Promise<string> {
	const context = "Failed to exchange Mistral sign-in for an API key";
	const response = await fetch(`${CONSOLE_API}${SIGN_IN_PATH}/${encodeURIComponent(process.processId)}/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
		signal: requestSignal(signal),
	});
	const payload = asRecord(await readJson(response, context), context);
	return requiredString(payload, "api_key", context);
}

function modelEntry(
	id: string,
	name: string,
	options: {
		reasoning: boolean;
		image: boolean;
		contextWindow: number;
		maxTokens?: number;
	},
	cost: ModelCost = STATIC_PRICING[id] ?? familyPrice(id) ?? FREE_COST,
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: options.reasoning,
		...(options.reasoning ? { thinking: MISTRAL_THINKING } : {}),
		input: options.image ? ["text", "image"] : ["text"],
		cost,
		contextWindow: options.contextWindow,
		maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

/**
 * Static fallback roster: the wire IDs Mistral Vibe itself uses, plus the
 * current medium/large entries. Live `/v1/models` discovery replaces these
 * rows once a credential is available.
 */
const FALLBACK_MODELS: ProviderModelConfig[] = [
	modelEntry("mistral-vibe-cli-latest", "Mistral Vibe CLI (subscription)", {
		reasoning: true,
		image: true,
		contextWindow: 262_144,
	}),
	modelEntry("mistral-vibe-cli-with-tools", "Mistral Vibe CLI with tools (subscription)", {
		reasoning: true,
		image: true,
		contextWindow: 262_144,
	}),
	modelEntry("mistral-vibe-cli-fast", "Mistral Vibe CLI Fast (subscription)", {
		reasoning: true,
		image: true,
		contextWindow: 262_144,
	}),
	modelEntry("mistral-medium-3.5", "Mistral Medium 3.5 (subscription)", {
		reasoning: true,
		image: true,
		contextWindow: 262_144,
	}),
	modelEntry("mistral-large-4", "Mistral Large 4 (subscription)", {
		reasoning: true,
		image: true,
		contextWindow: 1_048_576,
	}),
	modelEntry("mistral-small-latest", "Mistral Small (subscription)", {
		reasoning: true,
		image: true,
		contextWindow: 262_144,
	}),
	modelEntry("codestral-latest", "Codestral (subscription)", {
		reasoning: false,
		image: false,
		contextWindow: 256_000,
	}),
];

/** Keep Vibe's own wire IDs at the top of the picker, then Mistral's majors. */
function modelRank(id: string): number {
	if (id.startsWith("mistral-vibe-cli")) return 0;
	if (id.startsWith("mistral-large")) return 1;
	if (id.startsWith("mistral-medium")) return 2;
	if (id.startsWith("mistral-small") || id.startsWith("devstral") || id.startsWith("codestral")) return 3;
	return 4;
}

/** `/v1/models` reports aliases under their canonical name; keep Vibe's IDs distinct. */
const VIBE_MODEL_NAMES: Record<string, string> = {
	"mistral-vibe-cli-latest": "Mistral Vibe CLI (subscription)",
	"mistral-vibe-cli-with-tools": "Mistral Vibe CLI with tools (subscription)",
	"mistral-vibe-cli-fast": "Mistral Vibe CLI Fast (subscription)",
};

async function fetchModelList(apiKey: string): Promise<MistralModel[]> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE}/models`, {
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return [];
	} catch {
		return [];
	}
	try {
		const payload = asRecord(await response.json(), "Mistral model discovery");
		return Array.isArray(payload.data) ? (payload.data as MistralModel[]) : [];
	} catch {
		return [];
	}
}

function parsePricingMarkdown(text: string): Record<string, ModelCost> {
	const prices: Record<string, ModelCost> = {};
	const price = (cell: string, label: string): number | undefined => {
		const matched = cell.match(new RegExp(`${label} \\$([\\d.]+) \\/M Tokens`));
		return matched ? Number(matched[1]) : undefined;
	};
	for (const line of text.split("\n")) {
		if (!line.trim().startsWith("|")) continue;
		const columns = line.split("|").map((column) => column.trim());
		if (columns.length < 4) continue;
		const id = columns[2].match(/^`([^`]+)`$/)?.[1];
		if (!id) continue;
		const input = price(columns[3], "Input");
		const output = price(columns[3], "Output");
		if (input === undefined || output === undefined) continue;
		prices[id] = { input, output, cacheRead: price(columns[3], "Cached input") ?? 0, cacheWrite: 0 };
	}
	return prices;
}

async function fetchPricing(): Promise<Record<string, ModelCost>> {
	try {
		const response = await fetch(PRICING_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!response.ok) return {};
		return parsePricingMarkdown(await response.text());
	} catch {
		return {};
	}
}

async function discoverModels(apiKey: string | undefined): Promise<readonly ProviderModelConfig[]> {
	if (!apiKey) return [];
	const [data, livePricing] = await Promise.all([fetchModelList(apiKey), fetchPricing()]);

	const models: ProviderModelConfig[] = [];
	for (const raw of data) {
		if (typeof raw?.id !== "string" || raw.deprecation) continue;
		const capabilities = raw.capabilities;
		if (capabilities?.completion_chat !== true) continue;
		const reasoning = capabilities.reasoning === true;
		const image = capabilities.vision === true;
		const contextWindow =
			typeof raw.max_context_length === "number" && raw.max_context_length > 0
				? raw.max_context_length
				: 131_072;
		const name =
			VIBE_MODEL_NAMES[raw.id] ??
			(typeof raw.name === "string" && raw.name.length > 0
				? `${raw.name} (subscription)`
				: `${raw.id} (subscription)`);
		const billing = typeof raw.billing_model_name === "string" ? raw.billing_model_name : undefined;
		models.push(modelEntry(raw.id, name, { reasoning, image, contextWindow }, priceFor(raw.id, billing, livePricing)));
	}
	models.sort((a, b) => modelRank(a.id) - modelRank(b.id) || a.id.localeCompare(b.id));
	return models;
}

function readCookieHeader(): string | null {
	try {
		const stored = readFileSync(COOKIE_PATH, "utf8").trim();
		if (stored) return stored;
	} catch {
		// fall through to the environment
	}
	const envCookie = process.env.MISTRAL_COOKIE?.trim();
	return envCookie ? envCookie : null;
}

function writeCookieHeader(header: string): void {
	mkdirSync(dirname(COOKIE_PATH), { recursive: true });
	writeFileSync(COOKIE_PATH, header, { encoding: "utf8", mode: 0o600 });
	chmodSync(COOKIE_PATH, 0o600);
}

function clearCookieHeader(): void {
	try {
		unlinkSync(COOKIE_PATH);
	} catch {
		// already absent
	}
}
function readBudgetMode(): BudgetMode {
	try {
		const stored = readFileSync(BUDGET_PATH, "utf8").trim().toLowerCase();
		if (stored === "api" || stored === "vibe") return stored;
	} catch {
		// fall through to the environment
	}
	const envMode = process.env.MISTRAL_BUDGET_MODE?.trim().toLowerCase();
	return envMode === "api" ? "api" : "vibe";
}

function writeBudgetMode(mode: BudgetMode): void {
	mkdirSync(dirname(BUDGET_PATH), { recursive: true });
	writeFileSync(BUDGET_PATH, mode, { encoding: "utf8", mode: 0o600 });
	chmodSync(BUDGET_PATH, 0o600);
}


function parseCookieHeader(header: string): { name: string; value: string }[] {
	const raw = header.replace(/^\s*cookie\s*:/i, "").trim();
	if (!raw) return [];
	const pairs: { name: string; value: string }[] = [];
	for (const part of raw.split(";")) {
		const separator = part.indexOf("=");
		if (separator <= 0) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (name && value) pairs.push({ name, value });
	}
	return pairs;
}

function buildConsoleCookie(header: string): ConsoleCookie | null {
	const pairs = parseCookieHeader(header);
	const csrfToken = pairs.find((pair) => pair.name === "csrftoken")?.value;
	const sessions = pairs.filter((pair) => pair.name.startsWith("ory_session_"));
	if (!csrfToken || sessions.length === 0) return null;
	return {
		csrfToken,
		cookie: [`csrftoken=${csrfToken}`, ...sessions.map((pair) => `${pair.name}=${pair.value}`)].join("; "),
	};
}

function jsonContainerEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text.charAt(index);
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/** Concatenate the Next.js flight payload rows embedded in the subscription page. */
function flightText(html: string): string {
	let text = "";
	let cursor = 0;
	const marker = "self.__next_f.push(";
	while (cursor < html.length) {
		const at = html.indexOf(marker, cursor);
		if (at < 0) break;
		const start = html.indexOf("[", at + marker.length);
		if (start < 0) break;
		const end = jsonContainerEnd(html, start);
		if (end < 0) {
			cursor = at + marker.length;
			continue;
		}
		try {
			const row = JSON.parse(html.slice(start, end));
			if (Array.isArray(row) && row[0] === 1 && typeof row[1] === "string") text += row[1];
		} catch {
			// a non-JSON row is not a flight payload
		}
		cursor = end;
	}
	return text;
}

function findObjectValue(text: string, key: string): Record<string, unknown> | null {
	const needle = `"${key}"`;
	let cursor = 0;
	while (cursor < text.length) {
		const at = text.indexOf(needle, cursor);
		if (at < 0) return null;
		const colon = text.indexOf(":", at + needle.length);
		if (colon < 0) return null;
		let start = colon + 1;
		while (start < text.length && /\s/.test(text.charAt(start))) start += 1;
		if (text.charAt(start) !== "{") {
			cursor = at + needle.length;
			continue;
		}
		const end = jsonContainerEnd(text, start);
		if (end < 0) return null;
		try {
			const value = JSON.parse(text.slice(start, end));
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				return value as Record<string, unknown>;
			}
		} catch {
			// keep scanning
		}
		cursor = end;
	}
	return null;
}

function parseAllowance(value: unknown): BudgetAllowance | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const usedPercent = typeof record.usage_percentage === "number" ? record.usage_percentage : null;
	const total = typeof record.initial_budget === "number" ? record.initial_budget : null;
	const currency = typeof record.currency === "string" ? record.currency.toUpperCase() : null;
	if (usedPercent === null || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
	if (total === null || !Number.isFinite(total) || total <= 0 || !currency) return null;
	const reset = typeof record.reset_at === "string" ? Date.parse(record.reset_at) : Number.NaN;
	return { usedPercent, total, currency, resetAt: Number.isFinite(reset) ? reset : null };
}

function parseBudgets(html: string): { vibe: BudgetAllowance | null; api: BudgetAllowance | null } {
	const text = flightText(html);
	const budget = text ? findObjectValue(text, "budget") : null;
	return {
		vibe: parseAllowance(budget?.vibe_budget),
		api: parseAllowance(budget?.api_budget),
	};
}

async function fetchBudgets(
	cookie: ConsoleCookie,
	fetcher: FetchImpl,
	signal?: AbortSignal,
): Promise<{ vibe: BudgetAllowance | null; api: BudgetAllowance | null } | null> {
	let response: Response;
	try {
		response = await fetcher(SUBSCRIPTION_URL, {
			headers: {
				Accept: "text/html",
				"Accept-Language": "en-US,en;q=0.9",
				Cookie: cookie.cookie,
				Referer: SUBSCRIPTION_URL,
				"User-Agent": USER_AGENT,
			},
			redirect: "error",
			signal: requestSignal(signal),
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	try {
		return parseBudgets(await response.text());
	} catch {
		return null;
	}
}

function usageLimit(id: string, label: string, allowance: BudgetAllowance): UsageLimit {
	const usedFraction = allowance.usedPercent / 100;
	return {
		id,
		label,
		scope: { provider: PROVIDER_ID as UsageLimit["scope"]["provider"] },
		window:
			allowance.resetAt === null
				? undefined
				: { id: "monthly", label: "Monthly", resetsAt: allowance.resetAt },
		amount: {
			used: allowance.usedPercent,
			limit: 100,
			unit: "percent",
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
		},
		status: allowance.usedPercent >= 100 ? "exhausted" : allowance.usedPercent >= 80 ? "warning" : "ok",
		notes: [`Allowance: ${allowance.total.toFixed(2)} ${allowance.currency}`],
	};
}

const mistralUsage: UsageProvider = {
	id: PROVIDER_ID as UsageProvider["id"],
	cacheVersion: 2,
	supports: () => true,
	async fetchUsage(_params, ctx): Promise<UsageReport | null> {
		const header = readCookieHeader();
		if (!header) return null;
		const cookie = buildConsoleCookie(header);
		if (!cookie) return null;
		const budgets = await fetchBudgets(cookie, ctx.fetch, _params.signal);
		if (!budgets) return null;
		const limits: UsageLimit[] = [];
		if (budgets.vibe) limits.push(usageLimit("vibe-code", "Vibe Code usage", budgets.vibe));
		if (budgets.api) limits.push(usageLimit("included-api", "Included API usage", budgets.api));
		if (limits.length === 0) return null;
		return { provider: PROVIDER_ID as UsageReport["provider"], fetchedAt: Date.now(), limits };
	},
};

function mistralOAuth() {
	return {
		name: "Mistral subscription (browser sign-in)",
		async login(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
			const { verifier, challenge } = pkcePair();
			const process = await startSignIn(challenge, callbacks.signal);
			callbacks.onAuth({
				url: process.signInUrl,
				instructions: "Sign in with the Mistral account that has your Vibe/Pro plan.",
			});
			callbacks.onProgress?.("Waiting for Mistral sign-in...");
			const exchangeToken = await waitForSignIn(process, callbacks);
			callbacks.onProgress?.("Exchanging sign-in for a Mistral API key...");
			const apiKey = await exchangeForApiKey(process, exchangeToken, verifier, callbacks.signal);
			callbacks.onProgress?.("Signed in to Mistral.");
			return { access: apiKey, refresh: "mistral-browser-sign-in", expires: Date.now() + KEY_LIFETIME_MS };
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			// Browser-sign-in keys do not rotate; keep using the stored key and let
			// a real 401 surface as a rejected credential that requires /login.
			return { ...credentials, expires: Date.now() + KEY_LIFETIME_MS };
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

/**
 * Top-level fields Mistral's chat message schema accepts. Its API rejects any
 * other property with HTTP 422 (`extra_forbidden`), unlike OpenAI-compatible
 * endpoints that ignore unknown fields.
 */
const MISTRAL_MESSAGE_FIELDS: Record<string, readonly string[]> = {
	assistant: ["role", "content", "tool_calls", "prefix"],
	tool: ["role", "content", "tool_call_id", "name"],
	user: ["role", "content"],
	system: ["role", "content"],
};

function sanitizeMistralMessage(message: unknown): unknown {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
	const record = message as Record<string, unknown>;
	const role = record.role === "developer" ? "system" : record.role;
	const allowed = typeof role === "string" ? MISTRAL_MESSAGE_FIELDS[role] : undefined;
	if (!allowed) return message;
	const unchanged = role === record.role && Object.keys(record).every((key) => allowed.includes(key));
	if (unchanged) return message;
	const next: Record<string, unknown> = { role };
	for (const key of allowed) {
		if (key !== "role" && key in record) next[key] = record[key];
	}
	return next;
}

export default function mistralSubscription(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: API_BASE,
		api: "openai-completions",
		headers: { "User-Agent": USER_AGENT },
		compat: {
			// Streaming and non-streaming reasoning arrive as typed content parts.
			mistralReasoningContentParts: true,
			// Mistral derives cache affinity from the top-level prompt_cache_key.
			supportsPromptCacheKey: true,
		},
		oauth: mistralOAuth(),
		models: FALLBACK_MODELS,
		fetchDynamicModels: discoverModels,
		usage: mistralUsage,
	});

	// OMP stores reasoning in OpenAI/DeepSeek-style top-level fields
	// (`thinking_blocks`, `reasoning_content`) for replay. Mistral rejects both
	// and replays thinking through typed `content` parts instead, which the
	// encoder already emits because of `mistralReasoningContentParts`. Strip
	// every field its message schema does not define.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		const payload = event.payload as { messages?: unknown; metadata?: Record<string, unknown> } | null;
		if (!payload || !Array.isArray(payload.messages)) return;
		const messages = payload.messages.map((message) => sanitizeMistralMessage(message));
		// Mistral routes /v1/chat/completions billing by metadata.call_source: present
		// bills the Vibe Code plan budget, absent bills the plan's Included API budget
		// (the official vibe CLI sends call_source: "vibe_code"). /mistral budget picks.
		const metadata = { ...(payload.metadata ?? {}) };
		if (readBudgetMode() === "vibe") metadata.call_source = "vibe_code";
		else delete metadata.call_source;
		return { ...payload, messages, metadata };
	});

	pi.registerCommand("mistral", {
		description: "Mistral subscription: status | budget [vibe|api] | set-cookie | clear-cookie",
		getArgumentCompletions: (prefix: string) => {
			const query = (prefix ?? "").trim().toLowerCase();
			if (query.startsWith("budget")) {
				const value = query.slice("budget".length).trim();
				return (value ? ["vibe", "api"].filter((v) => v.startsWith(value)) : ["vibe", "api"]).map((value) => ({
					value: `budget ${value}`,
					label: `budget ${value}`,
				}));
			}
			const items = ["status", "budget", "set-cookie", "clear-cookie"].map((value) => ({ value, label: value }));
			return query ? items.filter((item) => item.value.startsWith(query)) : items;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "budget" || sub.startsWith("budget ")) {
				const value = sub.slice("budget".length).trim();
				if (value === "vibe" || value === "api") {
					writeBudgetMode(value);
					ctx.ui.notify(
						value === "vibe"
							? "Requests now carry metadata.call_source=vibe_code and bill the Vibe Code quota."
							: "Requests omit metadata.call_source and bill the Included API budget.",
						"info",
					);
				} else {
					ctx.ui.notify(`Current billing bucket: ${readBudgetMode()}. Usage: /mistral budget vibe|api`, "info");
				}
				return;
			}
			if (sub === "set-cookie") {
				const header = await ctx.ui.input(
					"Paste the Cookie header from console.mistral.ai (needs csrftoken and ory_session_*)",
					"Cookie: ...",
				);
				if (typeof header === "string" && header.trim().length > 0) {
					writeCookieHeader(header.trim());
					ctx.ui.notify("Stored Mistral console cookie; /usage now reads both meters.", "info");
				}
				return;
			}
			if (sub === "clear-cookie") {
				clearCookieHeader();
				ctx.ui.notify("Removed the stored Mistral console cookie.", "info");
				return;
			}

			const stored = readCookieHeader();
			const cookie = stored ? buildConsoleCookie(stored) : null;
			const mode = readBudgetMode();
			ctx.ui.notify(
				`Billing bucket: ${mode === "vibe" ? "Vibe Code quota (call_source=vibe_code)" : "Included API budget (no call_source)"}. ` +
					(cookie
						? "Console cookie stored; /usage reads the Vibe Code and Included API meters."
						: stored
							? "Stored cookie lacks csrftoken or ory_session_*; run /mistral set-cookie again."
							: "No console cookie. Copy the Cookie header from console.mistral.ai, then run /mistral set-cookie."),
				cookie ? "info" : "warning",
			);
		},
	});
}
