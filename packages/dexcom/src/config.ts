/**
 * Dexcom API regions. `sandbox` serves Dexcom's synthetic test users.
 */
export type DexcomRegion = "us" | "eu" | "jp" | "sandbox";

/**
 * Base URL for each Dexcom region. The same host serves login, token, and
 * data endpoints, so a grant is only valid against the host that issued it.
 */
export const DEXCOM_BASE_URLS: Readonly<Record<DexcomRegion, string>> = {
  us: "https://api.dexcom.com",
  eu: "https://api.dexcom.eu",
  jp: "https://api.dexcom.jp",
  sandbox: "https://sandbox-api.dexcom.com",
};

/**
 * Configuration for a registered Dexcom developer application.
 */
export interface DexcomConfig {
  /**
   * Base URL for every request (derived from the region unless overridden).
   */
  readonly baseUrl: string;
  /**
   * Region the base URL belongs to.
   */
  readonly region: DexcomRegion;
  /**
   * OAuth client ID from the Dexcom app management page.
   */
  readonly clientId: string;
  /**
   * OAuth client secret. Never sent anywhere but Dexcom's token endpoint.
   */
  readonly clientSecret: string;
  /**
   * Redirect URI registered with Dexcom for this application.
   */
  readonly redirectUri: string;
  /**
   * Request timeout in milliseconds.
   */
  readonly timeoutMs: number;
  /**
   * Fetch implementation, injectable for tests.
   */
  readonly fetch: typeof fetch;
}

/**
 * Options accepted by {@link createDexcomConfig}.
 */
export interface DexcomConfigOptions {
  /**
   * Region to target; defaults to `sandbox`.
   */
  region: DexcomRegion | undefined;
  /**
   * OAuth client ID.
   */
  clientId: string;
  /**
   * OAuth client secret.
   */
  clientSecret: string;
  /**
   * Redirect URI registered with Dexcom.
   */
  redirectUri: string;
  /**
   * Overrides the region's base URL (for tests or proxies).
   */
  baseUrl?: string | undefined;
  /**
   * Request timeout in milliseconds; defaults to 30 seconds.
   */
  timeoutMs?: number | undefined;
  /**
   * Fetch implementation; defaults to the global fetch.
   */
  fetch?: typeof fetch | undefined;
}

/**
 * Returns true when the value names a supported Dexcom region.
 *
 * @param value - Candidate region string.
 * @returns Whether the value is a {@link DexcomRegion}.
 */
export function isDexcomRegion(value: string): value is DexcomRegion {
  return Object.hasOwn(DEXCOM_BASE_URLS, value);
}

/**
 * Creates an immutable Dexcom client configuration.
 *
 * @param options - Application credentials and targeting options.
 * @returns A configuration object accepted by every client function.
 */
export function createDexcomConfig(options: DexcomConfigOptions): DexcomConfig {
  const region = options.region ?? "sandbox";
  return Object.freeze({
    region,
    baseUrl: (options.baseUrl ?? DEXCOM_BASE_URLS[region]).replace(/\/+$/, ""),
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    timeoutMs: options.timeoutMs ?? 30_000,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  });
}
