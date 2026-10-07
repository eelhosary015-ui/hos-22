import { postProductionEntry } from "../modules/accounts/services/auto-posting.service.js";
(async () => {
  // totalCost 0 -> returns null, but getAccountConfig()/ensureCoreAccounts() run first.
  const r = await postProductionEntry({ orderId: 1, orderNumber: "PROBE-1", productName: "probe", quantity: 0, totalCost: 0 } as any);
  console.log("postProductionEntry returned:", r);
  process.exit(0);
})().catch(e => { console.error("PROBE ERROR:", e); process.exit(1); });
