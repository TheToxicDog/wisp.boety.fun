// Epoxy transport that redials the Wisp relay when its connection has died
// (iPad asleep or backgrounded, network change, relay restart). Plain epoxy
// keeps using the dead connection, so every page fails with
// "Wisp(MuxTaskEnded)" until the app is reloaded. Loaded by bare-mux's
// shared worker (see setTransport in browser.js).
import EpoxyTransport from "/epoxy/index.mjs";

// Failed while opening the stream, so nothing reached the site: safe to retry.
const deadRelay = (err) => /Connect, Wisp\(|MuxTaskEnded/.test(String(err?.message ?? err));

export default class HealingTransport extends EpoxyTransport {
  redialing = null;

  // Many requests fail together when the socket drops; redial once for all.
  redial() {
    this.redialing ||= this.client.replace_stream_provider()
      .catch((err) => console.warn("Wisp redial failed", err))
      .finally(() => { this.redialing = null; });
    return this.redialing;
  }

  async request(remote, method, body, headers, signal) {
    try {
      return await super.request(remote, method, body, headers, signal);
    } catch (err) {
      // A streamed body can't be sent twice.
      if (!deadRelay(err) || body instanceof ReadableStream || signal?.aborted) throw err;
      console.warn("Wisp relay connection lost, redialing");
      await this.redial();
      return super.request(remote, method, body, headers, signal);
    }
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    // Sites' own WebSockets can't be retried transparently, but a dead relay
    // is redialed so the site's reconnect (and the next page load) works.
    const error = (e) => {
      if (deadRelay(e)) this.redial();
      onerror(e);
    };
    return super.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, error);
  }
}
