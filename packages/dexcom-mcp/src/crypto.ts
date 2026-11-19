/**
 * Encodes bytes as unpadded base64url.
 *
 * @param bytes - Input bytes.
 * @returns The encoded string.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/**
 * Generates a URL-safe random token with 256 bits of entropy.
 *
 * @returns The token.
 */
export function randomToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * SHA-256 of a string, base64url-encoded. Tokens are stored by this hash so a
 * leaked database does not leak usable bearer tokens.
 *
 * @param value - Input string.
 * @returns The base64url digest.
 */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * Verifies an RFC 7636 S256 PKCE code verifier against its challenge.
 *
 * @param verifier - The code_verifier from the token request.
 * @param challenge - The code_challenge from the authorization request.
 * @returns Whether they match.
 */
export async function verifyPkce(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return timingSafeEqualString(await sha256(verifier), challenge);
}

/**
 * Constant-time string comparison.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns Whether the strings are equal.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
