import { supabaseVerifier } from "./accounts.js";
import { packageVersion, startGateway } from "./serve.js";
import { requirePro, supabaseSubscriptions } from "./subscription.js";

// The gateway as a process (the Docker image runs this), configured by environment:
//   PORT                          listen port (8787)
//   RELAY_DATA_PATH               SQLite file with pairings and keys (./data/relay.db); keep it on a volume
//   SUPABASE_URL + SUPABASE_ANON_KEY   turn accounts on
//   AUTH_REQUIRED=true            computers need an active Pro account (with SUPABASE_SERVICE_ROLE_KEY)
//   TRUSTED_PROXIES               comma-separated proxy addresses (or IPv4 ranges, 10.0.0.0/8) whose X-Forwarded-For is believed
//   WS_CONNECT_RATE_LIMIT_MAX / WS_CONNECT_RATE_LIMIT_WINDOW_MS   connections per address (20 per 60000 ms)
//   LOG_LEVEL                     debug | info | warn | error (info)

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
type LogLevel = keyof typeof LOG_LEVELS;
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;

function log(level: LogLevel, message: string): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[logLevel]) process.stdout.write(`[gateway:${level}] ${message}\n`);
}

const port = Number(process.env.PORT ?? 8787);
const databasePath = process.env.RELAY_DATA_PATH ?? "./data/relay.db";
const supabase = {
  url: process.env.SUPABASE_URL ?? "",
  anonKey: process.env.SUPABASE_ANON_KEY ?? "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
};
const version = packageVersion();

const gateway = await startGateway({
  port,
  databasePath,
  version,
  log: (message) => log("info", `[relay] ${message}`),
  verifyToken: supabase.url && supabase.anonKey ? supabaseVerifier(supabase.url, supabase.anonKey) : undefined,
  admit:
    process.env.AUTH_REQUIRED === "true"
      ? requirePro(supabaseSubscriptions(supabase), (message) => log("warn", `[relay] ${message}`))
      : undefined,
  trustedProxies: (process.env.TRUSTED_PROXIES ?? "").split(","),
  wsConnectLimit: {
    max: Number(process.env.WS_CONNECT_RATE_LIMIT_MAX ?? 20),
    windowMs: Number(process.env.WS_CONNECT_RATE_LIMIT_WINDOW_MS ?? 60_000),
  },
});

log("info", `LinkShell Gateway v${version}`);
log("info", `listening on http://0.0.0.0:${gateway.port}`);
// Said at every start: coming up on an empty file is how every phone gets unpaired.
log("info", `pairings and keys in ${databasePath}`);
log("info", `log level: ${logLevel}`);

function shutdown(): void {
  process.stdout.write("[gateway] shutting down...\n");
  void gateway.close().then(() => {
    process.stdout.write("[gateway] stopped\n");
    process.exit(0);
  });
  // Connections that won't close don't get to hold the process.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
