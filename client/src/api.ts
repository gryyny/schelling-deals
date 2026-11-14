import { dealAccountId, type Offer, termsFor } from "./deal.ts";
import { type ChainReader, decodePassHeader, verifyPass } from "./pass.ts";

/** What this API sells: fixed at startup from the seller's own offer, never taken from the request. */
export interface ApiPolicy {
  seller: string;
  item: string;
  /** Deal accounts derived locally from the trusted offer's terms, one per tier. */
  deals: ReadonlySet<string>;
}

export function apiPolicyFromOffer(offer: Offer): ApiPolicy {
  return { seller: offer.seller, item: offer.item, deals: new Set(offer.tiers.map((_, i) => dealAccountId(termsFor(offer, i)))) };
}

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
export async function handleApiRequest(req: ApiRequest, policy: ApiPolicy, chain: ChainReader, nowMs: number): Promise<ApiResponse> {
  if (req.method !== "GET" || req.path !== "/v1/quotes") return { status: 404, body: { error: "not found; use GET /v1/quotes" } };
  if (!req.authorization) return { status: 401, body: { error: "missing Authorization: Pass <base64url pass>" } };
  const sp = decodePassHeader(req.authorization);
  if (!sp) return { status: 401, body: { error: "malformed pass" } };
  // Trust boundary first: a correctly signed pass from another seller, deal or product grants nothing here.
  if (sp.seller !== policy.seller) return { status: 401, body: { error: "pass is not from this API's seller" } };
  if (!policy.deals.has(sp.pass.deal)) return { status: 401, body: { error: "pass is not for a deal of this API's offer" } };
  if (sp.pass.item !== policy.item) return { status: 401, body: { error: "pass is not for this API's product" } };
  const v = await verifyPass(sp, chain, nowMs);
  if (!v.ok) return { status: 401, body: { error: v.reason ?? "invalid pass", checks: v.checks } };
  return { status: 200, body: { seat: sp.pass.buyer, validUntil: v.validUntil, dataLabel: "sample data", quotes: SAMPLE_QUOTES } };
}
