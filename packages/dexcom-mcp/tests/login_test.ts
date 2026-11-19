import { assertEquals } from "@std/assert";
import { createDexcomConfig } from "@wyattjoh/dexcom";
import { runLogin } from "../src/login.ts";
import { createKvStore } from "../src/store.ts";
import { LOCAL_USER_ID } from "../src/transports/stdio.ts";
import { createFakeDexcom } from "./helpers.ts";

Deno.test("login stores the local grant from the loopback callback", async () => {
  const dexcom = createFakeDexcom();
  // Reserve a free port from the OS, then hand it to the login server.
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const config = createDexcomConfig({
    region: "sandbox",
    clientId: "client",
    clientSecret: "secret",
    redirectUri: `http://127.0.0.1:${port}/callback`,
    fetch: dexcom.fetch,
  });
  const store = createKvStore(await Deno.openKv(":memory:"));
  try {
    let callbackStatus = 0;
    await runLogin(config, store, (loginUrl) => {
      const state = new URL(loginUrl).searchParams.get("state");
      // Simulate the browser returning from Dexcom.
      setTimeout(async () => {
        const response = await fetch(
          `http://127.0.0.1:${port}/callback?code=dexcom-code&state=${state}`,
        );
        callbackStatus = response.status;
        await response.body?.cancel();
      }, 10);
    });
    const grant = await store.getGrant(LOCAL_USER_ID);
    assertEquals(grant?.grant.refreshToken, "dex-refresh-1");
    assertEquals(callbackStatus, 200);
  } finally {
    store.close();
  }
});
