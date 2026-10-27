// Sign-in page: master setup, sign in, access requests, forced password change.
import { $, $$ } from "./ui.js";
import { api } from "./api.js";

const panels = ["signin", "signup", "setup", "change", "pending"];
function show(id, tabs = true) {
  panels.forEach((p) => ($("#" + p).hidden = p !== id));
  $("#tabs").hidden = !tabs;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
  $(`#${id} input`)?.focus();
}

// Wraps a form: disables while busy, shows the server's error text.
function handle(id, fn) {
  const form = $("#" + id);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $(".auth-error", form);
    const btn = $("button[type=submit]", form);
    const data = Object.fromEntries(new FormData(form));
    err.textContent = "";
    if ("confirm" in data && data.confirm !== (data.password ?? data.next)) {
      err.textContent = "Passwords don't match";
      return;
    }
    btn.disabled = true;
    try { await fn(data, form); }
    catch (ex) {
      if (ex.data?.status === "pending") return show("pending", false);
      err.textContent = ex.message;
    } finally { btn.disabled = false; }
  });
}

// Same-site paths only ("/x", never "//host" or "/\host").
const next = new URLSearchParams(location.search).get("next");
const enter = () => location.replace(next && /^\/(?![\/\\])/.test(next) ? next : "/");

handle("signin", async ({ username, password }) => {
  const r = await api("/api/auth/login", { username, password });
  if (r.mustChangePassword) {
    show("change", false);
    $("#change [name=current]").value = password;
    $("#change [name=next]").focus();
  } else enter();
});

handle("signup", async ({ username, password, note }, form) => {
  await api("/api/auth/signup", { username, password, note });
  form.reset();
  show("pending", false);
});

handle("setup", async ({ code, username, password }) => {
  await api("/api/auth/setup", { code, username, password });
  enter();
});

handle("change", async ({ current, next }) => {
  await api("/api/me/password", { current, next });
  enter();
});

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (tab) show(tab);
});
$("#backToSignin").addEventListener("click", () => show("signin"));

const state = await api("/api/auth/state");
if (state.setupRequired) show("setup", false);
else if (state.signedIn && state.mustChangePassword) show("change", false);
else if (state.signedIn) enter();
else show("signin");
