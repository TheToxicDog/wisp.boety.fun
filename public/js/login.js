// Sign-in page: sign in, request access, two-step master setup (access
// code, then credentials), forced password change and the pending screen.
import { $, $$ } from "./ui.js";
import { api } from "./api.js";

// Same-site paths only ("/x", never "//host" or "/\host").
const next = new URLSearchParams(location.search).get("next");
const enter = () => location.replace(next && /^\/(?![\/\\])/.test(next) ? next : "/");

function showView(id) {
  $$(".view").forEach((v) => (v.hidden = v.id !== id));
  $(`#${id} form:not([hidden]) input`)?.focus({ preventScroll: true });
}

function setTab(tab) {
  $(".tabs").dataset.active = tab;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#signin").hidden = tab !== "signin";
  $("#signup").hidden = tab !== "signup";
  $("#authTitle").textContent = tab === "signin" ? "Welcome back" : "Request access";
  $("#authSub").textContent = tab === "signin"
    ? "Sign in to continue to your workspace."
    : "Create an account. The owner approves new members.";
  clearErrors();
  $(`#${tab} input`).focus({ preventScroll: true });
}

function clearErrors(scope = document) {
  $$(".alert", scope).forEach((a) => (a.hidden = true));
  $$(".control.invalid", scope).forEach((c) => c.classList.remove("invalid"));
}

function fail(form, message, input) {
  const alert = $(".alert", form);
  alert.textContent = message;
  alert.hidden = false;
  if (input) { input.closest(".control").classList.add("invalid"); input.focus(); }
}

// Wraps a form: client-side checks, busy spinner, server error display.
function handle(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors(form);
    for (const input of $$("input[required]", form)) {
      if (!input.value.trim()) return fail(form, `Please fill in ${input.closest(".field").querySelector("label").firstChild.textContent.trim().toLowerCase()}.`, input);
      if (input.minLength > 0 && input.value.length < input.minLength) {
        return fail(form, input.type === "password" ? `Password must be at least ${input.minLength} characters.` : `Must be at least ${input.minLength} characters.`, input);
      }
    }
    const data = Object.fromEntries(new FormData(form));
    const pw = data.password ?? data.next;
    if ("confirm" in data && data.confirm !== pw) return fail(form, "Passwords don't match.", $("[name=confirm]", form));

    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    btn.classList.add("busy");
    try { await fn(data, form); }
    catch (ex) {
      if (ex.data?.status === "pending") return showView("v-pending");
      fail(form, ex.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
    }
  });
}

// ───────── Password helpers ─────────
function strength(pw) {
  if (!pw) return 0;
  let s = pw.length >= 8 ? 1 : 0;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  else if (/\d|[^A-Za-z0-9]/.test(pw) && pw.length >= 10) s++;
  return Math.max(1, Math.min(4, s));
}
const LABELS = ["", "Weak", "Fair", "Good", "Strong"];

for (const input of $$("input[data-strength]")) {
  const meter = input.closest(".field").querySelector(".meter");
  input.addEventListener("input", () => {
    const score = input.value ? strength(input.value) : 0;
    meter.dataset.score = score;
    meter.querySelector("span").textContent = LABELS[score];
  });
}

for (const btn of $$(".reveal")) {
  btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.classList.toggle("on", show);
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
}

// ───────── Forms ─────────
handle($("#signin"), async ({ username, password }) => {
  const r = await api("/api/auth/login", { username, password });
  if (r.mustChangePassword) {
    showView("v-change");
    $("#ch-cur").value = password;
    $("#ch-next").focus();
  } else enter();
});

handle($("#signup"), async ({ username, password, note }, form) => {
  await api("/api/auth/signup", { username, password, note });
  form.reset();
  showView("v-pending");
});

let setupCode = "";
handle($("#setup-code"), async ({ code }) => {
  await api("/api/auth/setup/check", { code });
  setupCode = code;
  $("#setup-code").hidden = true;
  $("#setup-account").hidden = false;
  $("#st1").className = "done";
  $("#st1 span").textContent = "✓";
  $("#st2").className = "on";
  $("#sa-user").focus();
});

handle($("#setup-account"), async ({ username, password }) => {
  await api("/api/auth/setup", { code: setupCode, username, password });
  enter();
});

$("#setupBack").addEventListener("click", () => {
  $("#setup-account").hidden = true;
  $("#setup-code").hidden = false;
  $("#st1").className = "on";
  $("#st1 span").textContent = "1";
  $("#st2").className = "";
  clearErrors();
  $("#sc-code").select();
});

handle($("#change"), async ({ current, next: nextPw }) => {
  await api("/api/me/password", { current, next: nextPw });
  enter();
});

$(".tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (tab) setTab(tab);
});
$("#backToSignin").addEventListener("click", () => { showView("v-auth"); setTab("signin"); });

// ───────── Boot ─────────
const status = $("#status");
try {
  const state = await api("/api/auth/state");
  status.dataset.state = "ok";
  $("#statusText").textContent = "Gateway online";
  if (state.setupRequired) showView("v-setup");
  else if (state.signedIn && state.mustChangePassword) showView("v-change");
  else if (state.signedIn) enter();
  else { showView("v-auth"); setTab("signin"); }
} catch {
  status.dataset.state = "down";
  $("#statusText").textContent = "Gateway unreachable";
  showView("v-auth");
  setTab("signin");
}
