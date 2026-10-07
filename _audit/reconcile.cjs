/* REMO PRO ERP — financial reconciliation snapshot, read-only, real PostgreSQL. */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 30000 });

(async () => {
  const one = async (sql, a) => (await pool.query(sql, a)).rows[0];
  const n = (v) => Number(v || 0);
  const f = (v) => n(v).toFixed(2);

  const purchaseValue = await one(`SELECT COALESCE(SUM(total_landed_cost),0) v, COUNT(*)::int c FROM goods_receipts`);
  const purchaseOrders = await one(`SELECT COALESCE(SUM(total_amount),0) v, COUNT(*)::int c FROM purchase_orders`);
  const invValue = await one(`SELECT COALESCE(SUM(quantity * COALESCE(NULLIF(avg_cost,0), NULLIF(unit_cost,0), NULLIF(last_cost,0), 0)),0) v,
                                      COUNT(*)::int rows, COALESCE(SUM(quantity),0) qty FROM inventory_items`);
  const invByWh = await pool.query(
    `SELECT w.id, w.name, COALESCE(SUM(ii.quantity * COALESCE(NULLIF(ii.avg_cost,0), NULLIF(ii.unit_cost,0),0)),0)::numeric value, COALESCE(SUM(ii.quantity),0)::numeric qty
       FROM warehouses w LEFT JOIN inventory_items ii ON ii.warehouse_id = w.id
      GROUP BY w.id, w.name HAVING COALESCE(SUM(ii.quantity),0) <> 0 ORDER BY value DESC LIMIT 8`);
  const prod = await one(`SELECT COUNT(*)::int runs, COALESCE(SUM(total_cost),0) cost, COALESCE(SUM(quantity),0) qty FROM production_runs`);
  const prodOrders = await one(`SELECT COUNT(*)::int orders, COALESCE(SUM(total_cost),0) cost FROM production_orders WHERE COALESCE(is_executed,false) = true`);
  const salesOrd = await one(`SELECT COUNT(*)::int c FROM sales_orders`);
  const deliv = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(total_cost),0) cost, COALESCE(SUM(total_amount),0) amount FROM sales_delivery_notes`);
  const delivPosted = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(total_cost),0) cost FROM sales_delivery_notes WHERE is_posted = true`);
  const invoices = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(net_amount),0) revenue, COALESCE(SUM(total_cost),0) cogs FROM sales_invoices`);
  const posOrders = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(total),0) revenue FROM orders`);
  const treasury = await one(`SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('in','deposit','receipt') OR type='in' THEN amount ELSE -amount END),0) v,
                                     COUNT(*)::int c FROM treasury_transactions`);
  const treasuryByType = await pool.query(
    `SELECT COALESCE(transaction_type, type) t, COUNT(*)::int c, COALESCE(SUM(amount),0) amount
       FROM treasury_transactions GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
  const supBal = await one(`SELECT COALESCE(SUM(balance),0) v, COUNT(*)::int c FROM suppliers`);
  const supTx = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(amount),0) v FROM supplier_transactions`);
  const custBal = await one(`SELECT COALESCE(SUM(${`CASE WHEN type IN ('invoice','debit') THEN amount WHEN type IN ('payment','credit','reversal') THEN -amount WHEN type='adjustment' THEN amount ELSE 0 END`}),0) v,
                                    COUNT(*)::int c FROM customer_transactions`);
  const je = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(total_debit),0) d, COALESCE(SUM(total_credit),0) cr FROM journal_entries`);
  const ji = await one(`SELECT COUNT(*)::int c, COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) cr FROM journal_items`);
  const cogsGl = await one(`SELECT COALESCE(SUM(ji.debit - ji.credit),0) v FROM journal_items ji
                              JOIN accounts a ON a.id = ji.account_id WHERE a.code = '5100'`);
  const invGl = await one(`SELECT COALESCE(SUM(ji.debit - ji.credit),0) v FROM journal_items ji
                             JOIN accounts a ON a.id = ji.account_id WHERE a.code IN ('1140','1141','1142')`);
  const apGl = await one(`SELECT COALESCE(SUM(ji.credit - ji.debit),0) v FROM journal_items ji
                            JOIN accounts a ON a.id = ji.account_id WHERE a.code = '2110'`);
  const revGl = await one(`SELECT COALESCE(SUM(ji.credit - ji.debit),0) v FROM journal_items ji
                             JOIN accounts a ON a.id = ji.account_id WHERE a.code IN ('4000','4100')`);
  const dupJournals = await one(`SELECT COUNT(*)::int c FROM (
      SELECT source_type, source_id FROM journal_entries
       WHERE source_type IS NOT NULL AND source_id IS NOT NULL
       GROUP BY 1,2 HAVING COUNT(*) > 1) x`);
  const dupDeliv = await one(`SELECT COUNT(*)::int c FROM (
      SELECT source_type, source_id FROM journal_entries WHERE source_type='sales_delivery' AND source_id IS NOT NULL
       GROUP BY 1,2 HAVING COUNT(*) > 1) x`);
  const prodLegs = await pool.query(
    `SELECT je.id, je.reference, je.source_type, je.source_id,
            COUNT(DISTINCT ji.account_id)::int accounts, je.total_debit, je.total_credit
       FROM journal_entries je JOIN journal_items ji ON ji.journal_entry_id = je.id
      WHERE je.source_type = 'production_order' GROUP BY 1,2,3,4,6,7 ORDER BY je.id DESC LIMIT 5`);
  const legacyProd = await one(`SELECT COUNT(*)::int c FROM journal_entries je
      WHERE je.source_type='production' AND je.id IN (
        SELECT journal_entry_id FROM journal_items GROUP BY journal_entry_id HAVING COUNT(DISTINCT account_id) = 1)`);

  const out = {
    generated_at: new Date().toISOString(),
    purchase: { goods_receipts_value: f(purchaseValue.v), goods_receipts_count: purchaseValue.c,
                purchase_orders_value: f(purchaseOrders.v), purchase_orders_count: purchaseOrders.c },
    inventory: { value: f(invValue.v), rows: invValue.rows, qty: f(invValue.qty),
                 top_warehouses: invByWh.rows.map(r => ({ id: r.id, name: r.name, value: f(r.value), qty: f(r.qty) })) },
    production: { runs: prod.runs, run_cost: f(prod.cost), run_qty: f(prod.qty),
                  executed_orders: prodOrders.orders, executed_order_cost: f(prodOrders.cost),
                  new_style_journals: prodLegs.rows.map(r => ({ id: r.id, ref: r.reference, source_id: r.source_id,
                    distinct_accounts: r.accounts, debit: f(r.total_debit), credit: f(r.total_credit) })),
                  legacy_same_account_journals_untouched: legacyProd.c },
    sales: { sales_orders: salesOrd.c, delivery_notes: deliv.c, delivery_cogs: f(deliv.cost), delivery_amount: f(deliv.amount),
             posted_deliveries: delivPosted.c, posted_delivery_cogs: f(delivPosted.cost),
             invoices: invoices.c, invoice_revenue: f(invoices.revenue), invoice_cogs: f(invoices.cogs),
             pos_orders: posOrders.c, pos_revenue: f(posOrders.revenue) },
    treasury: { net: f(treasury.v), transactions: treasury.c,
                by_type: treasuryByType.rows.map(r => ({ type: r.t, count: r.c, amount: f(r.amount) })) },
    suppliers: { stored_balance_sum: f(supBal.v), suppliers: supBal.c, transactions: supTx.c, transactions_amount: f(supTx.v) },
    customers: { derived_receivable: f(custBal.v), ledger_rows: custBal.c },
    general_ledger: {
      entries: je.c, header_debit: f(je.d), header_credit: f(je.cr),
      items: ji.c, item_debit: f(ji.d), item_credit: f(ji.cr),
      balanced: Math.abs(n(ji.d) - n(ji.cr)) < 0.01,
      diff: f(n(ji.d) - n(ji.cr)),
      cogs_account_5100_net: f(cogsGl.v), inventory_accounts_net: f(invGl.v),
      ap_account_2110_net: f(apGl.v), revenue_accounts_net: f(revGl.v),
      duplicate_source_journals: dupJournals.c, duplicate_delivery_journals: dupDeliv.c
    },
    trial_balance_check: { total_debit: f(ji.d), total_credit: f(ji.cr), difference: f(n(ji.d) - n(ji.cr)) }
  };
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(__dirname, "reconciliation.json"), JSON.stringify(out, null, 1));
  await pool.end();
})().catch(async e => { console.error("FATAL", e); try { await pool.end(); } catch {} process.exit(1); });
