import { createClient } from "@supabase/supabase-js";
import { loadDotEnv } from "../src/env.js";
import { customerRows, ticketRows } from "../src/fixtures.js";

/**
 * Loads the demo dataset into Supabase, injection payloads included. Run after
 * applying sql/001_schema.sql:  npm run seed
 */
loadDotEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first");
  process.exit(1);
}

const client = createClient(url, key, { auth: { persistSession: false } });

const customers = await client.from("customers").upsert(customerRows()).select("id");
if (customers.error) throw new Error(`customers: ${customers.error.message}`);

const tickets = await client.from("support_tickets").upsert(ticketRows()).select("id");
if (tickets.error) throw new Error(`support_tickets: ${tickets.error.message}`);

console.log(
  `seeded ${customers.data?.length ?? 0} customers, ${tickets.data?.length ?? 0} tickets`,
);
console.log("note: several rows contain prompt-injection payloads by design");
