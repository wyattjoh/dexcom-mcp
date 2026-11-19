import { assertEquals, assertThrows } from "@std/assert";
import { parsePublicUrl } from "../src/index.ts";

Deno.test("MCP_PUBLIC_URL must be https unless everything is loopback", () => {
  assertEquals(
    parsePublicUrl("http://localhost:3000", "127.0.0.1").href,
    "http://localhost:3000/",
  );
  assertEquals(
    parsePublicUrl("https://dexcom.example.com", "0.0.0.0").origin,
    "https://dexcom.example.com",
  );
  // Behind a loopback-bound reverse proxy the public URL decides.
  assertThrows(() => parsePublicUrl("http://dexcom.example.com", "127.0.0.1"));
  assertThrows(() => parsePublicUrl("http://localhost:3000", "0.0.0.0"));
  assertThrows(() => parsePublicUrl("https://dexcom.example.com/mcp", "::1"));
});
