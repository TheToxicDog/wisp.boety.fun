// Deployment constants. Change these when the gateway moves.
export const WISP_URL = "wss://wisp.boety.fun/wisp/";
export const SW_URL = "/sw.js";
export const SW_SCOPE = "/service/"; // also the Scramjet URL prefix

// Local development talks to the relay on the same host instead.
export const IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
