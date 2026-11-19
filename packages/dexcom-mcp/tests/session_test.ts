import { assert, assertEquals, assertRejects } from "@std/assert";
import { getDevices } from "@wyattjoh/dexcom";
import {
  createDexcomSessions,
  isReauthorizationRequiredError,
} from "../src/session.ts";
import { createFixture } from "./helpers.ts";

Deno.test("concurrent calls on an expired token share one refresh", async () => {
  const fx = await createFixture(20);
  try {
    fx.dexcom.validRefreshTokens.add("seed-refresh");
    await fx.store.putGrant({
      grantId: "grant-1",
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
      grantId: "grant-1",
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
      grantId: "grant-1",
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
      grantId: "grant-1",
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

Deno.test("two processes sharing a KV spend the refresh token once", async () => {
  const fx = await createFixture(50);
  try {
    fx.dexcom.validRefreshTokens.add("seed-refresh");
    await fx.store.putGrant({
      grantId: "grant-1",
      userId: "u",
      accessToken: "expired",
      refreshToken: "seed-refresh",
      accessTokenExpiresAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    // Separate session managers have separate in-process single-flight maps,
    // like two stdio servers on one KV file.
    const other = createDexcomSessions(fx.config, fx.store);
    const results = await Promise.allSettled([
      fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth)),
      other.withAuth("u", (auth) => getDevices(auth)),
    ]);
    assertEquals(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
    assertEquals(fx.dexcom.refreshCount(), 1);
    const stored = await fx.store.getGrant("u");
    assertEquals(stored?.grant.refreshToken, "dex-refresh-1");
    assertEquals(stored?.grant.grantId, "grant-1");
  } finally {
    fx.close();
  }
});

Deno.test("a waiting process uses the lease holder's rotated tokens", async () => {
  const fx = await createFixture();
  try {
    await fx.store.putGrant({
      grantId: "grant-1",
      userId: "u",
      accessToken: "expired",
      refreshToken: "spent-elsewhere",
      accessTokenExpiresAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    const owner = await fx.store.acquireRefreshLock("u", 10_000);
    assert(owner);
    const call = fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth));
    // The holder finishes: it stores fresh tokens and releases the lease.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fx.dexcom.validAccessTokens.add("fresh-access");
    await fx.store.putGrant({
      grantId: "grant-1",
      userId: "u",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accessTokenExpiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });
    await fx.store.releaseRefreshLock("u", owner);
    await call;
    assertEquals(fx.dexcom.refreshCount(), 0);
    assertEquals(
      (await fx.store.getGrant("u"))?.grant.accessToken,
      "fresh-access",
    );
  } finally {
    fx.close();
  }
});

Deno.test("a rejected refresh does not delete a grant replaced meanwhile", async () => {
  const fx = await createFixture(100);
  try {
    await fx.store.putGrant({
      grantId: "grant-1",
      userId: "u",
      accessToken: "expired",
      refreshToken: "dead",
      accessTokenExpiresAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    const call = fx.ctx.sessions.withAuth("u", (auth) => getDevices(auth));
    // While Dexcom is rejecting "dead", a writer outside the lease (say an
    // older version) stores working tokens.
    await new Promise((resolve) => setTimeout(resolve, 30));
    fx.dexcom.validAccessTokens.add("fresh-access");
    await fx.store.putGrant({
      grantId: "grant-1",
      userId: "u",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accessTokenExpiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });
    await call;
    assertEquals(
      (await fx.store.getGrant("u"))?.grant.refreshToken,
      "fresh-refresh",
    );
  } finally {
    fx.close();
  }
});
