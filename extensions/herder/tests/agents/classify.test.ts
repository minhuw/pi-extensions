import { describe, expect, it } from "vitest";
import { classifyError, classifyMessage, toAgentError } from "../../src/agents/classify.ts";
import { AgentError, type ErrorClass } from "../../src/types.ts";

describe("classifyMessage", () => {
	it.each<[string, ErrorClass]>([
		["429 Too Many Requests", "rate_limit"],
		["rate_limit_error: Number of request tokens has exceeded your per-minute rate limit", "rate_limit"],
		["Request was throttled. Please wait", "rate_limit"],
		["429 You exceeded your current quota, please check your plan and billing details", "usage_limit"],
		["insufficient_quota", "usage_limit"],
		["Your credit balance is too low to access the Anthropic API", "usage_limit"],
		["You've hit your usage limit. Upgrade to Pro", "usage_limit"],
		["402 Payment Required", "usage_limit"],
		["401 Unauthorized", "auth"],
		["403 Forbidden", "auth"],
		["invalid x-api-key", "auth"],
		["Incorrect API key provided: sk-***", "auth"],
		["No API key found for anthropic", "auth"],
		["authentication_error: OAuth token has expired", "auth"],
		["No model credentials configured", "auth"],
		["529 overloaded_error: Overloaded", "transient"],
		["503 Service Unavailable", "transient"],
		["500 Internal Server Error", "transient"],
		["read ECONNRESET", "transient"],
		["socket hang up", "transient"],
		["fetch failed", "transient"],
		["Request timed out", "transient"],
		["getaddrinfo EAI_AGAIN api.example.com", "transient"],
		["terminated", "transient"],
		["other side closed", "transient"],
		["Provider returned error", "transient"],
		["server_error: An error occurred while processing your request", "transient"],
		["internal error", "transient"],
		["stream ended without producing a message", "transient"],
		["Anthropic stream ended before message_stop", "transient"],
		["The upstream provider returned an error", "transient"],
		["429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'", "rate_limit"],
		["Quota exceeded: tokens per minute (TPM) limit reached", "rate_limit"],
		["RPM limit exceeded for this model", "rate_limit"],
		["Quota exceeded for requests per second", "rate_limit"],
		["429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'requests per day'", "usage_limit"],
		["Monthly usage limit reached", "usage_limit"],
		["out of budget", "usage_limit"],
		["model is at capacity", "transient"],
		["http2 request did not get a response", "transient"],
		["prompt is too long: 250000 tokens > 200000 maximum", "fatal"],
		["400 invalid_request_error: messages.0.content is empty", "fatal"],
		["something unexpected", "fatal"],
	])("%j → %s", (message, expected) => {
		expect(classifyMessage(message)).toBe(expected);
	});
});

describe("classifyError", () => {
	it("keeps an AgentError's class, including the runner's own stall/timeout/invalid_output", () => {
		for (const errorClass of ["stall", "timeout", "invalid_output", "transient"] as const) {
			expect(classifyError(new AgentError(errorClass, "429 would otherwise look like a rate limit"))).toBe(errorClass);
		}
	});

	it("uses HTTP status codes, but lets a quota message override a 429", () => {
		const withStatus = (status: number, message = "request failed") => Object.assign(new Error(message), { status });
		expect(classifyError(withStatus(429))).toBe("rate_limit");
		expect(classifyError(withStatus(401))).toBe("auth");
		expect(classifyError(withStatus(502))).toBe("transient");
		expect(classifyError(withStatus(429, "insufficient_quota"))).toBe("usage_limit");
		expect(classifyError(Object.assign(new Error("x"), { statusCode: 403 }))).toBe("auth");
		expect(classifyError(withStatus(400, "bad request"))).toBe("fatal");
		expect(classifyError("plain string 503")).toBe("transient");
		expect(classifyError(withStatus(429, "Quota exceeded for quota metric 'requests per minute'"))).toBe("rate_limit");
		expect(classifyError(new TypeError("terminated"))).toBe("transient");
	});

	it("wraps unknown errors as AgentError with the cause attached", () => {
		const cause = new Error("read ECONNRESET");
		const wrapped = toAgentError(cause);
		expect(wrapped).toMatchObject({ errorClass: "transient", message: "read ECONNRESET", cause });
		const original = new AgentError("auth", "no key");
		expect(toAgentError(original)).toBe(original);
	});
});
