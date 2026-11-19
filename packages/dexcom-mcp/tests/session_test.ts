import { assertEquals, assertRejects } from "@std/assert";
import { getDevices } from "@wyattjoh/dexcom";
import { isReauthorizationRequiredError } from "../src/session.ts";
import { createFixture } from "./helpers.ts";

Deno.test("concurrent calls on an expired token share one refresh", async () => {
  const fx = await createFixture(20);
  try {
    fx.dexcom.validRefreshTokens.add("seed-refresh");
    await fx.store.putGrant({
      userId: "u",
      accessToken: "expired",
      refreshToken: "seed-refresh",
      accessTokenExpiresAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    const results = await Promise.all(
      Array.from(
        { length: 5 },
        () => fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth)),
      ),
    );
    assertEquals(results.length, 5);
    assertEquals(fx.dexcom.refreshCount(), 1);
    const stored = await fx.store.getGrant("u");
    assertEquals(stored?.grant.refreshToken, "dex-refresh-1");
  } finally {
    fx.close();
  }
});

Deno.test("concurrent 401s on a valid-looking token share one refresh", async () => {
  const fx = await createFixture(20);
  try {
    fx.dexcom.validRefreshTokens.add("seed-refresh");
    await fx.store.putGrant({
      userId: "u",
      accessToken: "revoked-early",
      refreshToken: "seed-refresh",
      accessTokenExpiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });
    await Promise.all(
      Array.from(
        { length: 4 },
        () => fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth)),
      ),
    );
    assertEquals(fx.dexcom.refreshCount(), 1);
  } finally {
    fx.close();
  }
});

Deno.test("rejected refresh deletes the grant and requires re-auth", async () => {
  const fx = await createFixture();
  try {
    await fx.store.putGrant({
      userId: "u",
      accessToken: "expired",
      refreshToken: "dead",
      accessTokenExpiresAt: 0,
      updatedAt: 0,
    });
    const error = await assertRejects(() =>
      fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth))
    );
    assertEquals(isReauthorizationRequiredError(error), true);
    assertEquals(await fx.store.getGrant("u"), undefined);
  } finally {
    fx.close();
  }
});

Deno.test("rate-limited refresh keeps the grant", async () => {
  const fx = await createFixture();
  try {
    fx.dexcom.validRefreshTokens.add("seed-refresh");
    fx.dexcom.refreshFailureStatus = 429;
    await fx.store.putGrant({
      userId: "u",
      accessToken: "expired",
      refreshToken: "seed-refresh",
      accessTokenExpiresAt: 0,
      updatedAt: 0,
    });
    const error = await assertRejects(() =>
      fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth))
    );
    assertEquals(isReauthorizationRequiredError(error), false);
    assertEquals(
      (await fx.store.getGrant("u"))?.grant.refreshToken,
      "seed-refresh",
    );
  } finally {
    fx.close();
  }
});
