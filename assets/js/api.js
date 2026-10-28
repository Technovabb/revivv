/* ===== Revivv API client =====
   The booking, rewards and staff pages talk to Revivv's own server
   (api.revivvbb.com, code in server/). Every call answers in the same
   shape the pages already handle: { data, error, status }.
   - status 0 means the server couldn't be reached (the pages then offer
     WhatsApp/phone instead);
   - 4xx comes with a plain message to show. */
(() => {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const BASE = local ? `http://${location.hostname}:4380` : "https://api.revivvbb.com";

  async function call(path, body, auth){
    let res;
    try {
      res = await fetch(BASE + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      const name = auth ? "AuthRetryableFetchError" : "FetchError";
      return { data: null, error: { name, message: "Can't reach Revivv right now.", status: 0 }, status: 0 };
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return { data: json.data ?? null, error: null, status: res.status };
    const message = json.error?.message || "Something went wrong. Please try again.";
    return { data: null, error: { message, status: res.status }, status: res.status };
  }

  /* A password-reset link arrives as ?type=recovery&token=… — swap the
     one-time token for a signed-in session before anything else runs,
     and take it out of the address bar. */
  let ready = Promise.resolve();
  const q = new URLSearchParams(location.search);
  if (q.get("type") === "recovery" && q.get("token")){
    const token = q.get("token");
    q.delete("token");
    history.replaceState(null, "", location.pathname + "?" + q + location.hash);
    ready = call("/auth/recover", { token }, true).then(r => { if (r.error) alert(r.error.message); });
  }

  window.revivvApi = {
    auth: {
      async getSession(){
        await ready;
        const r = await call("/auth/session", undefined, true);
        const user = r.data && r.data.user;
        return { data: { session: user ? { user } : null }, error: r.error };
      },
      signUp: ({ email, password }) => call("/auth/signup", { email, password }, true),
      signInWithPassword: ({ email, password }) => call("/auth/signin", { email, password }, true),
      signOut: () => call("/auth/signout", {}, true),
      async updateUser({ password }){ await ready; return call("/auth/password", { password }, true); },
      resetPasswordForEmail: (email, opts) =>
        call("/auth/reset", { email, redirectTo: (opts && opts.redirectTo) || location.href }, true)
    },
    rpc: (name, params) => call("/rpc/" + name, params || {}),
    /* the signed-in person's staff record ({ name }), or null if they aren't staff */
    staffMe: () => call("/staff/me", undefined, true)
  };
})();
