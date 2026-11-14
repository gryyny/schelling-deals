import { type ChainReader, decodePassHeader, verifyPass } from "./pass.ts";

export interface ApiRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Fixed sample so the demo needs no external data source. */
export const SAMPLE_QUOTES = [
  { symbol: "NEAR/USD", bid: "3.141", ask: "3.143", ts: "2026-11-14T00:00:00Z" },
  { symbol: "BTC/USD", bid: "91234.50", ask: "91240.00", ts: "2026-11-14T00:00:00Z" },
  { symbol: "ETH/USD", bid: "3456.70", ask: "3457.10", ts: "2026-11-14T00:00:00Z" },
] as const;

/** Quote Feed API: GET /v1/quotes with `Authorization: Pass <base64url(pass JSON)>`. */
export async function handleApiRequest(req: ApiRequest, chain: ChainReader, nowMs: number): Promise<ApiResponse> {
  if (req.method !== "GET" || req.path !== "/v1/quotes") return { status: 404, body: { error: "not found; use GET /v1/quotes" } };
  if (!req.authorization) return { status: 401, body: { error: "missing Authorization: Pass <base64url pass>" } };
  const sp = decodePassHeader(req.authorization);
  if (!sp) return { status: 401, body: { error: "malformed pass" } };
  const v = await verifyPass(sp, chain, nowMs);
  if (!v.ok) return { status: 401, body: { error: v.reason ?? "invalid pass", checks: v.checks } };
  return { status: 200, body: { seat: sp.pass.buyer, validUntil: v.validUntil, dataLabel: "sample data", quotes: SAMPLE_QUOTES } };
}
