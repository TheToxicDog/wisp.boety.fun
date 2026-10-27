// Gateway & Streams view: live health from /api/status plus a latency probe.
import { wispUrl } from "./store.js";
import { $ } from "./ui.js";

let timer;

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export async function fetchStatus() {
  const res = await fetch("/api/status", { cache: "no-store" });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function refresh() {
  const badge = $("#gwBadge");
  try {
    const s = await fetchStatus();
    badge.textContent = "Online";
    badge.className = "badge ok";
    $("#gwUptime").textContent = fmtUptime(s.uptime);
    $("#gwSessions").textContent = s.sessions;
    $("#gwTotal").textContent = s.totalSessions;
    $("#gwMem").textContent = s.memoryMB + " MB";
    $("#gwLimit").textContent = `${s.streamLimit} streams / session`;
    $("#gwMotd").textContent = s.motd ? `MOTD: ${s.motd} · Node ${s.node}` : "";
  } catch {
    badge.textContent = "Offline";
    badge.className = "badge bad";
  }
  const sw = navigator.serviceWorker?.controller;
  $("#swBadge").textContent = sw ? "Active" : "Not active";
  $("#swBadge").className = "badge " + (sw ? "ok" : "bad");
  $("#wispUrlView").textContent = wispUrl();
}

async function ping() {
  const btn = $("#pingBtn");
  btn.disabled = true;
  const samples = [];
  const spark = $("#spark");
  spark.innerHTML = "";
  for (let i = 0; i < 12; i++) {
    const t = performance.now();
    try { await fetchStatus(); samples.push(performance.now() - t); }
    catch { samples.push(NaN); }
    const max = Math.max(...samples.filter(Number.isFinite), 1);
    spark.innerHTML = samples.map((v) => `<i style="height:${Number.isFinite(v) ? Math.max(4, (v / max) * 100) : 100}%;${Number.isFinite(v) ? "" : "background:var(--bad)"}" title="${v.toFixed(0)} ms"></i>`).join("");
  }
  const ok = samples.filter(Number.isFinite).sort((a, b) => a - b);
  $("#pingSummary").textContent = ok.length
    ? `median ${ok[ok.length >> 1].toFixed(0)} ms · min ${ok[0].toFixed(0)} ms · max ${ok.at(-1).toFixed(0)} ms · ${samples.length - ok.length} failed`
    : "All probes failed.";
  btn.disabled = false;
}

export function initGateway() {
  $("#pingBtn").addEventListener("click", ping);
}

export function showGateway(visible) {
  clearInterval(timer);
  if (!visible) return;
  refresh();
  timer = setInterval(refresh, 5000);
}
