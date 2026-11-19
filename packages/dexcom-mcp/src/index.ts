#!/usr/bin/env -S deno run --unstable-kv --allow-net --allow-env --allow-read --allow-write --allow-run

import "@std/dotenv/load";
import { Command } from "@cliffy/command";
import {
  createDexcomConfig,
  type DexcomConfig,
  type DexcomRegion,
  isDexcomRegion,
} from "@wyattjoh/dexcom";
import deno from "../deno.json" with { type: "json" };
import { runLogin } from "./login.ts";
import { configureLogging, getLogger } from "./logging.ts";
import { type BridgeContext, DEXCOM_CALLBACK_PATH } from "./oauth/context.ts";
import { createDexcomSessions } from "./session.ts";
import { createKvStore, type Store } from "./store.ts";
import { createHttpHandler, startHttpServer } from "./transports/http.ts";
import { createStdioServer, LOCAL_USER_ID } from "./transports/stdio.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_LOCAL_REDIRECT = "http://localhost:8765/callback";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function loadRegion(): DexcomRegion {
  const region = Deno.env.get("DEXCOM_REGION") ?? "sandbox";
  if (!isDexcomRegion(region)) {
    throw new Error(
      `DEXCOM_REGION must be one of us, eu, jp, sandbox (got ${region})`,
    );
  }
  return region;
}

function loadDexcomConfig(redirectUri: string): DexcomConfig {
  return createDexcomConfig({
    region: loadRegion(),
    clientId: requireEnv("DEXCOM_CLIENT_ID"),
    clientSecret: requireEnv("DEXCOM_CLIENT_SECRET"),
    redirectUri,
    baseUrl: Deno.env.get("DEXCOM_BASE_URL"),
  });
}

/**
 * Default KV location: a per-user data directory, so stdio servers launched by
 * MCP clients from any working directory find the grant stored by `login`.
 */
function defaultKvPath(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  // XDG_DATA_HOME is honored only on Linux and other Unixes: on macOS and
  // Windows, GUI-launched MCP clients rarely inherit it, so honoring it would
  // split `login` (terminal) and the server (GUI) across two KV files.
  const base = Deno.build.os === "windows"
    ? Deno.env.get("LOCALAPPDATA")
    : Deno.build.os === "darwin"
    ? home && `${home}/Library/Application Support`
    : Deno.env.get("XDG_DATA_HOME") ?? (home && `${home}/.local/share`);
  if (!base) {
    throw new Error(
      "Cannot determine a data directory; set DEXCOM_MCP_KV_PATH",
    );
  }
  return `${base}/dexcom-mcp/dexcom-mcp.kv`;
}

function kvPath(): string {
  return Deno.env.get("DEXCOM_MCP_KV_PATH") ?? defaultKvPath();
}

async function openStore(): Promise<Store> {
  const path = kvPath();
  if (path !== ":memory:" && !/^https?:/.test(path)) {
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    if (dir && dir !== path) await Deno.mkdir(dir, { recursive: true });
  }
  getLogger(["dexcom-mcp"]).debug("Opening KV at {path}", { path });
  return createKvStore(await Deno.openKv(path));
}

function parseDuration(name: string, fallbackSeconds: number): number {
  const raw = Deno.env.get(name);
  const seconds = raw ? Number(raw) : fallbackSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds`);
  }
  return seconds * 1000;
}

function setupShutdown(close: () => Promise<void>): void {
  const logger = getLogger(["dexcom-mcp"]);
  const cleanup = async () => {
    logger.info("Received shutdown signal, cleaning up");
    try {
      await close();
    } catch (error) {
      logger.error("Error during shutdown", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      Deno.exit(0);
    }
  };
  Deno.addSignalListener("SIGINT", cleanup);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", cleanup);
}

/**
 * Validates `MCP_PUBLIC_URL`: an origin with no path, and https unless both
 * the public hostname and the bind address are loopback (local development).
 * Behind a reverse proxy the bind address is loopback, so the public URL
 * itself decides whether codes, tokens, and cookies would travel in clear.
 *
 * @param value - The configured public URL.
 * @param bindHost - The `--host` bind address.
 * @returns The parsed URL.
 */
export function parsePublicUrl(value: string, bindHost: string): URL {
  const publicUrl = new URL(value);
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error(
      "MCP_PUBLIC_URL must be an origin without a path (serve the bridge at the root of its host)",
    );
  }
  if (
    publicUrl.protocol !== "https:" &&
    !(LOOPBACK_HOSTS.has(publicUrl.hostname) && LOOPBACK_HOSTS.has(bindHost))
  ) {
    throw new Error(
      "MCP_PUBLIC_URL must be an https URL unless it is a loopback address and the server binds to loopback (local development).",
    );
  }
  return publicUrl;
}

async function runHttp(port: number, host: string): Promise<void> {
  const logger = getLogger(["dexcom-mcp"]);
  const publicUrl = parsePublicUrl(
    Deno.env.get("MCP_PUBLIC_URL") ?? `http://localhost:${port}`,
    host,
  );
  const issuer = publicUrl.href.replace(/\/+$/, "");
  const dexcom = loadDexcomConfig(`${issuer}${DEXCOM_CALLBACK_PATH}`);
  const store = await openStore();
  const ctx: BridgeContext = {
    issuer,
    resourceUrl: new URL(`${issuer}/mcp`),
    dexcom,
    store,
    sessions: createDexcomSessions(dexcom, store),
    accessTokenTtlMs: parseDuration("MCP_ACCESS_TOKEN_TTL", 3600),
    refreshTokenTtlMs: parseDuration("MCP_REFRESH_TOKEN_TTL", 30 * 24 * 3600),
  };
  const allowedOriginHostnames = (Deno.env.get("MCP_ALLOWED_ORIGINS") ??
    "localhost,127.0.0.1,[::1]").split(",").map((origin) => origin.trim())
    .filter(Boolean);

  const handler = createHttpHandler({
    ctx,
    allowedOriginHostnames,
    allowInsecureIssuer: publicUrl.protocol !== "https:",
  });
  const server = startHttpServer(handler, port, host);
  logger.info("MCP endpoint: {url}", { url: ctx.resourceUrl.href });
  logger.info("Register this Dexcom redirect URI: {uri}", {
    uri: dexcom.redirectUri,
  });
  setupShutdown(async () => {
    await server.close();
    store.close();
  });
}

async function runStdio(): Promise<void> {
  const dexcom = loadDexcomConfig(
    Deno.env.get("DEXCOM_REDIRECT_URI") ?? DEFAULT_LOCAL_REDIRECT,
  );
  const store = await openStore();
  const sessions = createDexcomSessions(dexcom, store);
  if (!await sessions.hasGrant(LOCAL_USER_ID)) {
    store.close();
    throw new Error(
      "No Dexcom authorization found. Run `dexcom-mcp login` first.",
    );
  }
  const server = createStdioServer(sessions);
  setupShutdown(async () => {
    await server.close();
    store.close();
  });
}

async function main(): Promise<void> {
  try {
    await new Command()
      .name("dexcom-mcp")
      .version(deno.version)
      .description("Model Context Protocol server for the Dexcom API")
      .globalOption("--debug", "Enable debug logging")
      .option(
        "--http",
        "Serve Streamable HTTP with the OAuth bridge instead of stdio",
      )
      .option("-p, --port <port:number>", "HTTP port", { default: 3000 })
      .option("--host <host:string>", "HTTP bind address", {
        default: "127.0.0.1",
      })
      .action(async (options) => {
        await configureLogging({
          debug: options.debug ?? false,
          useStdio: !options.http,
        });
        if (options.http) await runHttp(options.port, options.host);
        else await runStdio();
      })
      .command("login", "Authorize with Dexcom for stdio mode")
      .action(async (options) => {
        await configureLogging({
          debug: options.debug ?? false,
          useStdio: true,
        });
        const dexcom = loadDexcomConfig(
          Deno.env.get("DEXCOM_REDIRECT_URI") ?? DEFAULT_LOCAL_REDIRECT,
        );
        const store = await openStore();
        try {
          await runLogin(dexcom, store);
        } finally {
          store.close();
        }
        console.error(`Stored the Dexcom grant in ${kvPath()}`);
      })
      .parse(Deno.args);
  } catch (error) {
    console.error(
      "[FATAL]",
      error instanceof Error ? error.message : String(error),
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
