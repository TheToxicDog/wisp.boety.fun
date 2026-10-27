// JSON API helper: GET when no body, POST otherwise. Throws with the
// server's error message; a 401 inside the app sends you to sign in.
export async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith("/login")) location.replace("/login");
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  }
  return data;
}
