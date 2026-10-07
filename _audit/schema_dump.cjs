/* TEST-AUDIT: dump real PostgreSQL schema for ERP tables (read-only) */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// load .env manually
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TABLES = [
  'products','ingredients','inventory_items','inventory_movements','inventory_stock_ledger',
  'warehouses','suppliers','purchase_requests','purchase_orders','goods_receipts','purchases',
  'supplier_transactions','sales_orders','sales_delivery_notes','sales_invoices','orders','order_items',
  'production_orders','production_runs','production_order_materials','production_boms','bom_items',
  'journal_entries','journal_items','accounts','treasury_transactions','treasury_accounts','safes',
  'employees','attendance','payroll_records','payroll_bonuses','payroll_deductions',
  'employee_bonuses','employee_deductions','branches','companies','customers',
  'recipes','recipe_items','shifts','pos_shifts','account_mappings'
];

(async () => {
  const out = {};
  try {
    const { rows: tbl } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
    out.allTables = tbl.map(r => r.table_name);

    const { rows: cols } = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
    out.columns = {};
    for (const c of cols) {
      (out.columns[c.table_name] ||= []).push(
        `${c.column_name}:${c.data_type}${c.is_nullable === 'NO' ? ' NOTNULL' : ''}`);
    }

    const { rows: fks } = await pool.query(
      `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
       WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' ORDER BY 1,2`);
    out.fks = fks.map(f => `${f.table_name}.${f.column_name} -> ${f.foreign_table}.${f.foreign_column}`);

    const { rows: uniq } = await pool.query(
      `SELECT tc.table_name, tc.constraint_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) cols
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
       WHERE tc.constraint_type IN ('UNIQUE','PRIMARY KEY') AND tc.table_schema='public'
       GROUP BY 1,2 ORDER BY 1,2`);
    out.unique = uniq.map(u => `${u.table_name} [${u.constraint_name}] (${u.cols})`);
  } catch (e) {
    out.error = String(e && e.message);
  } finally {
    await pool.end();
  }
  fs.writeFileSync(path.join(__dirname, 'schema.json'), JSON.stringify(out, null, 1));
  const missing = TABLES.filter(t => !out.columns || !out.columns[t]);
  console.log('ERROR:', out.error || 'none');
  console.log('TABLES:', (out.allTables || []).length);
  console.log('MISSING FROM EXPECTED LIST:', JSON.stringify(missing));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
