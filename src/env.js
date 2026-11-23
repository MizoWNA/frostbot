// Load .env if present (hosts with a panel can set env vars instead). Must be imported first.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {}
