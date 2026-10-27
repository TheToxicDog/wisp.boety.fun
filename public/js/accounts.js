// Account (own password, sign out) and People (master account: approve,
// add, reset passwords, disable, delete).
import { api } from "./api.js";
import { $, toast, escapeHtml, hue } from "./ui.js";

let me = null;
let pollTimer;

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function showSecret(title, value) {
  $("#secretTitle").textContent = title;
  $("#secretValue").textContent = value;
  $("#secretSheet").hidden = false;
}

// ───────── Account ─────────
export async function initAccount() {
  me = await api("/api/me");
  $("#navAccountName").textContent = me.name;
  $("#acctName").textContent = me.name;
  $("#acctRole").textContent = me.role === "admin" ? "Master account" : "Member";

  $("#signOut").addEventListener("click", async () => {
    await api("/api/auth/logout", {});
    location.replace("/login");
  });

  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const { current, next, confirm } = Object.fromEntries(new FormData(form));
    const err = $("#pwError");
    err.textContent = "";
    if (next !== confirm) return (err.textContent = "Passwords don't match");
    try {
      await api("/api/me/password", { current, next });
      form.reset();
      toast("Password updated");
    } catch (ex) { err.textContent = ex.message; }
  });

  $("#secretClose").addEventListener("click", () => ($("#secretSheet").hidden = true));
  $("#secretCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#secretValue").textContent); toast("Copied"); }
    catch { toast("Select the text to copy it"); }
  });

  if (me.role === "admin") initAdmin();
  return me;
}

// ───────── People (master account) ─────────
function personRow(u) {
  const status = u.status === "active" ? (u.online ? "Online" : "Active") : u.status === "pending" ? "Pending" : "Disabled";
  const meta = u.status === "pending"
    ? `Requested ${ago(u.created)}`
    : `Last seen ${ago(u.lastSeen)}${u.mustChangePassword ? " · must set password" : ""}`;
  const self = u.name === me.name;
  let actions;
  if (u.status === "pending") {
    actions = `<button class="btn primary sm" data-act="approve">Approve</button>
               <button class="btn sm danger" data-act="reject">Reject</button>`;
  } else if (self || u.role === "admin") {
    actions = `<span class="muted small">${self ? "You" : "Master"}</span>`;
  } else {
    actions = `<button class="btn sm" data-act="reset">Reset password</button>
      ${u.status === "active"
        ? `<button class="btn sm" data-act="signout">Sign out</button><button class="btn sm" data-act="disable">Disable</button>`
        : `<button class="btn sm" data-act="enable">Enable</button>`}
      <button class="btn sm danger" data-act="delete">Delete</button>`;
  }
  return `
    <div class="person" data-name="${escapeHtml(u.name)}" data-ui="admin.person">
      <span class="avatar" style="background:${hue(u.name)}">${escapeHtml(u.name[0].toUpperCase())}</span>
      <div class="who">
        <b>${escapeHtml(u.name)} ${u.role === "admin" ? '<em class="tag">Master</em>' : ""}</b>
        <small class="muted">${meta}</small>
        ${u.note ? `<small class="note">“${escapeHtml(u.note)}”</small>` : ""}
      </div>
      <span class="status s-${u.status}${u.online ? " online" : ""}">${status}</span>
      <div class="acts">${actions}</div>
    </div>`;
}

async function refreshPeople() {
  let list;
  try { list = await api("/api/admin/users"); } catch { return; }
  const pending = list.filter((u) => u.status === "pending");
  const others = list.filter((u) => u.status !== "pending");
  $("#pendingList").innerHTML = pending.length
    ? pending.map(personRow).join("")
    : `<div class="person empty">No requests right now.</div>`;
  $("#peopleList").innerHTML = others.map(personRow).join("");
  $("#pendingCount").textContent = pending.length;
  $("#pendingTag").textContent = pending.length;
  $("#pendingTag").hidden = !pending.length;
}

const CONFIRM = {
  reject: (n) => `Reject ${n}'s request? Their account will be deleted.`,
  delete: (n) => `Delete ${n}? They lose access immediately.`,
  disable: (n) => `Disable ${n}? They're signed out and can't sign in until you enable them.`,
  reset: (n) => `Reset ${n}'s password? They'll be signed out and need the new temporary password.`,
};

async function act(name, action) {
  if (CONFIRM[action] && !confirm(CONFIRM[action](name))) return;
  const path = `/api/admin/users/${encodeURIComponent(name)}`;
  try {
    if (action === "approve") { await api(`${path}/approve`, {}); toast(`${name} can sign in now`); }
    if (action === "reject" || action === "delete") { await api(path, undefined, "DELETE"); toast(`${name} removed`); }
    if (action === "disable") { await api(`${path}/disable`, {}); toast(`${name} disabled`); }
    if (action === "enable") { await api(`${path}/enable`, {}); toast(`${name} enabled`); }
    if (action === "signout") { await api(`${path}/signout`, {}); toast(`${name} signed out everywhere`); }
    if (action === "reset") {
      const r = await api(`${path}/reset-password`, {});
      showSecret(`Temporary password for ${name}`, r.password);
    }
  } catch (ex) { toast(ex.message); }
  refreshPeople();
}

function initAdmin() {
  $("#navAdmin").hidden = false;
  for (const id of ["#pendingList", "#peopleList"]) {
    $(id).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) act(btn.closest(".person").dataset.name, btn.dataset.act);
    });
  }
  $("#addUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const { username, password } = Object.fromEntries(new FormData(form));
    try {
      const r = await api("/api/admin/users", { username, password: password || undefined });
      form.reset();
      showSecret(`Password for ${r.user.name}`, r.password);
      refreshPeople();
    } catch (ex) { toast(ex.message); }
  });
  refreshPeople();
  // Keep the pending badge fresh even when People isn't open.
  setInterval(refreshPeople, 60_000);
}

export function showAdmin(visible) {
  clearInterval(pollTimer);
  if (!visible || me?.role !== "admin") return;
  refreshPeople();
  pollTimer = setInterval(refreshPeople, 10_000);
}
