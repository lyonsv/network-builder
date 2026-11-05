import type { CostStage, CostTracker } from '../types';

export function createCostTracker(): CostTracker {
  const totals: Record<CostStage, number> = { enrich: 0, rank: 0, research: 0, dossier: 0, lens: 0, ahoy: 0 };
  let incomplete = false;
  return {
    add(stage, usd) {
      if (Number.isFinite(usd) && usd > 0) totals[stage] += usd;
    },
    total() {
      return totals.enrich + totals.rank + totals.research + totals.dossier + totals.lens;
    },
    byStage() {
      return { ...totals };
    },
    markIncomplete() {
      incomplete = true;
    },
    isIncomplete() {
      return incomplete;
    },
  };
}
