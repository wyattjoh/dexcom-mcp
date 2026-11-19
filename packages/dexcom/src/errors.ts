/**
 * Error raised for any non-2xx response from the Dexcom API.
 */
export interface DexcomApiError extends Error {
  /**
   * Discriminant used by {@link isDexcomApiError}.
   */
  readonly name: "DexcomApiError";
  /**
   * HTTP status returned by Dexcom.
   */
  readonly status: number;
  /**
   * OAuth error code when the body was an OAuth error response.
   */
  readonly code: string | undefined;
}

/**
 * Creates a {@link DexcomApiError}.
 *
 * @param status - HTTP status code.
 * @param message - Human-readable description.
 * @param code - OAuth error code, when present.
 * @returns The error object.
 */
export function createDexcomApiError(
  status: number,
  message: string,
  code: string | undefined,
): DexcomApiError {
  return Object.assign(new Error(message), {
    name: "DexcomApiError" as const,
    status,
    code,
  });
}

/**
 * Narrows an unknown value to a {@link DexcomApiError}.
 *
 * @param error - Value caught from a client call.
 * @returns Whether the value is a Dexcom API error.
 */
export function isDexcomApiError(error: unknown): error is DexcomApiError {
  return error instanceof Error && error.name === "DexcomApiError" &&
    typeof (error as Partial<DexcomApiError>).status === "number";
}

/**
 * Builds a {@link DexcomApiError} from a failed response.
 *
 * @param response - The non-OK response.
 * @param context - Short description of the request, for the message.
 * @returns The error to throw.
 */
export async function toDexcomApiError(
  response: Response,
  context: string,
): Promise<DexcomApiError> {
  const text = await response.text().catch(() => "");
  let code: string | undefined;
  let detail = text.slice(0, 500);
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body.error === "string") code = body.error;
    const description = body.error_description ?? body.message ?? body.error;
    if (typeof description === "string") detail = description;
  } catch {
    // Non-JSON body; keep the raw text.
  }
  return createDexcomApiError(
    response.status,
    `${context} failed with ${response.status}${detail ? `: ${detail}` : ""}`,
    code,
  );
}
