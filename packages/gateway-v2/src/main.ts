import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { supabaseVerifier } from "./accounts.js";
import { Gateway } from "./server.js";

// `PORT`, `DATA_PATH` (sqlite), and optionally SUPABASE_URL + SUPABASE_ANON_KEY for accounts.
const databasePath = process.env.DATA_PATH ?? "./data/gateway-v2.db";
mkdirSync(dirname(databasePath), { recursive: true });
const verifyToken =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? supabaseVerifier(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : undefined;
const gateway = new Gateway({ port: Number(process.env.PORT ?? 8788), databasePath, verifyToken });
const port = await gateway.start();
process.stderr.write(`LinkShell gateway v2 on :${port}${verifyToken ? " (accounts on)" : ""}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void gateway.stop().then(() => process.exit(0)));
}
