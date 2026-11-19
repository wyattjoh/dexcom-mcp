import {
  buildLoginUrl,
  type DexcomConfig,
  exchangeCode,
} from "@wyattjoh/dexcom";
import { randomToken, timingSafeEqualString } from "./crypto.ts";
import { getLogger } from "./logging.ts";
import { grantFromTokens } from "./session.ts";
import type { Store } from "./store.ts";
import { LOCAL_USER_ID } from "./transports/stdio.ts";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string): void {
  const command = Deno.build.os === "darwin"
    ? ["open", url]
    : Deno.build.os === "windows"
    ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    new Deno.Command(command[0]!, {
      args: command.slice(1),
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    // Opening the browser is best-effort; the URL is printed regardless.
  }
}

function page(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Dexcom MCP</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem"><p>${message}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Runs the interactive stdio login: serves the Dexcom redirect URI on
 * loopback, opens the Dexcom login page, exchanges the code, and stores the
 * grant for the local user.
 *
 * @param config - Dexcom configuration; its redirect URI must be loopback.
 * @param store - Persistent store.
 * @param openUrl - Opens the login URL; defaults to the system browser.
 */
export async function runLogin(
  config: DexcomConfig,
  store: Store,
  openUrl: (url: string) => void = openBrowser,
): Promise<void> {
  const logger = getLogger(["dexcom-mcp", "login"]);
  const redirect = new URL(config.redirectUri);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
    throw new Error(
      `DEXCOM_REDIRECT_URI must be a loopback URL for login (got ${redirect.origin})`,
    );
  }

  const state = randomToken();
  const { promise, resolve, reject } = Promise.withResolvers<void>();

  const server = Deno.serve({
    hostname: redirect.hostname.replace(/^\[|\]$/g, ""),
    port: Number(redirect.port || 80),
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== redirect.pathname) return page("Not found", 404);
    const returnedState = url.searchParams.get("state") ?? "";
    if (!timingSafeEqualString(returnedState, state)) {
      return page(
        "State mismatch. Run <code>dexcom-mcp login</code> again.",
        400,
      );
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      reject(
        new Error(
          `Dexcom authorization failed: ${error ?? "no code returned"}`,
        ),
      );
      return page("Dexcom authorization was not completed.", 400);
    }
    try {
      const tokens = await exchangeCode(config, code);
      const existing = await store.getGrant(LOCAL_USER_ID);
      await store.putGrant(
        grantFromTokens(LOCAL_USER_ID, tokens, existing?.grant.grantId),
      );
      resolve();
      return page("Dexcom connected. You can close this window.");
    } catch (exchangeError) {
      reject(exchangeError);
      return page(
        "Could not exchange the Dexcom code. Check the terminal.",
        500,
      );
    }
  });

  const loginUrl = buildLoginUrl(config, state).href;
  console.error(
    `Opening Dexcom login (${config.region}). If no browser opens, visit:\n\n  ${loginUrl}\n`,
  );
  openUrl(loginUrl);

  const timer = setTimeout(
    () => reject(new Error("Timed out waiting for Dexcom login (5 minutes)")),
    LOGIN_TIMEOUT_MS,
  );
  try {
    await promise;
    logger.info("Stored Dexcom grant for stdio mode");
    console.error("Dexcom login complete. Start the server with `dexcom-mcp`.");
  } finally {
    clearTimeout(timer);
    // Graceful: lets the in-flight callback response reach the browser.
    await server.shutdown();
  }
}
