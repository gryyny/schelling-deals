import { NEAR, type Offer, formatNear } from "./deal.ts";

/**
 * Scripted, deterministic buyer agents (no LLM). Each profile is private to its agent:
 * no agent sees another's profile or talks to another agent.
 */
export interface BuyerProfile {
  name: string;
  needUnits: number;
  maxUnitPriceYocto: bigint;
  budgetYocto: bigint;
  /** Willing to wait for a cheaper tier with a larger minimum. */
  patient: boolean;
}

const milli = NEAR / 1000n;

export const PROFILES: Record<string, BuyerProfile> = {
  ada: { name: "Ada", needUnits: 4, maxUnitPriceYocto: 120n * milli, budgetYocto: 1n * NEAR, patient: false },
  bo: { name: "Bo", needUnits: 6, maxUnitPriceYocto: 110n * milli, budgetYocto: 1n * NEAR, patient: false },
  cy: { name: "Cy", needUnits: 3, maxUnitPriceYocto: 50n * milli, budgetYocto: 1n * NEAR, patient: false },
  dee: { name: "Dee", needUnits: 5, maxUnitPriceYocto: 80n * milli, budgetYocto: 1n * NEAR, patient: true },
};

export interface Decision {
  tierIndex: number | null;
  units: number;
  reasoning: string[];
}

export function decide(offer: Offer, p: BuyerProfile, nowNs: bigint): Decision {
  const reasoning: string[] = [
    `${p.name}: need ${p.needUnits} units, pay at most ${formatNear(p.maxUnitPriceYocto)}/unit, budget ${formatNear(p.budgetYocto)}, ${p.patient ? "will wait for a cheaper tier" : "prefers the tier most likely to close"}`,
  ];
  const acceptable: number[] = [];
  offer.tiers.forEach((t, i) => {
    const price = BigInt(t.unitPriceYocto);
    const cost = price * BigInt(p.needUnits);
    const label = `tier ${String.fromCharCode(65 + i)} (${formatNear(price)}/unit, min ${t.minUnits}, max ${t.maxUnits})`;
    if (BigInt(t.deadlineNs) <= nowNs) reasoning.push(`${label}: rejected, deadline passed`);
    else if (price > p.maxUnitPriceYocto) reasoning.push(`${label}: rejected, price above my max ${formatNear(p.maxUnitPriceYocto)}`);
    else if (cost > p.budgetYocto) reasoning.push(`${label}: rejected, ${formatNear(cost)} exceeds budget`);
    else if (p.needUnits > t.maxUnits) reasoning.push(`${label}: rejected, my need exceeds the tier cap`);
    else {
      reasoning.push(`${label}: acceptable, would cost ${formatNear(cost)}`);
      acceptable.push(i);
    }
  });
  if (acceptable.length === 0) {
    reasoning.push(`${p.name}: no tier meets my limits, declining`);
    return { tierIndex: null, units: 0, reasoning };
  }
  const tiers = offer.tiers;
  const price = (i: number) => BigInt(tiers[i]?.unitPriceYocto ?? "0");
  const min = (i: number) => tiers[i]?.minUnits ?? 0;
  const pick = acceptable.reduce((best, i) => {
    if (p.patient) return price(i) < price(best) ? i : best;
    return min(i) < min(best) || (min(i) === min(best) && price(i) < price(best)) ? i : best;
  });
  reasoning.push(
    p.patient
      ? `${p.name}: choosing the cheapest acceptable tier ${String.fromCharCode(65 + pick)}; if it misses I reclaim my pledge`
      : `${p.name}: choosing tier ${String.fromCharCode(65 + pick)}, the lowest minimum among acceptable tiers`,
  );
  return { tierIndex: pick, units: p.needUnits, reasoning };
}
