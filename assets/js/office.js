/* ===== Revivv back office: the shared shell =====
   Every staff-*.html page loads api.js, this file, then its own script, which calls
     Office.start({ page: "today", title: "Today", owner: false, render: async (main, me) => { ... } })
   start() draws the header and menu, signs the person in if needed (staff only;
   owner-only pages refuse crew), then calls render with the <main> element and
   me = { name, role, owner, email }.
   Text always goes in with textContent (Office.el), never as HTML. */
(() => {
  const api = window.revivvApi;
  const NAV = [
    { key: "today", href: "staff.html", label: "Today" },
    { key: "bookings", href: "staff-bookings.html", label: "Bookings" },
    { key: "new", href: "staff-new.html", label: "+ Booking" },
    { key: "customers", href: "staff-customers.html", label: "Customers" },
    { key: "messages", href: "staff-messages.html", label: "Messages", badge: true },
    { key: "money", href: "staff-money.html", label: "Money", owner: true },
    { key: "reports", href: "staff-reports.html", label: "Reports", owner: true },
    { key: "settings", href: "staff-settings.html", label: "Settings", owner: true },
    { key: "team", href: "staff-team.html", label: "Staff", owner: true },
    { key: "outbox", href: "staff-outbox.html", label: "Emails", owner: true }
  ];

  /* ---------- building the page ---------- */
  // el("div", { class: "x", on: { click: fn }, dataset: { id: 1 } }, "text", childEl, [more])
  function el(tag, attrs, ...kids){
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)){
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k === "style") n.setAttribute("style", v);
      else if (k in n && typeof v !== "string") n[k] = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    add(n, kids);
    return n;
  }
  function add(n, kids){
    for (const k of kids.flat(Infinity)){
      if (k == null || k === false) continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return n;
  }
  const clear = (n, ...kids) => { n.replaceChildren(); return add(n, kids); };
  const $ = (sel, root = document) => root.querySelector(sel);
  const param = name => new URLSearchParams(location.search).get(name);

  /* ---------- talking to the server ---------- */
  class ApiError extends Error {}
  async function rpc(name, params){
    const r = await api.rpc(name, params);
    if (r.status === 0) { offline(true); throw Object.assign(new ApiError("Can't reach Revivv's server. Check the internet connection."), { status: 0 }); }
    offline(false);
    if (r.status === 401) { location.reload(); throw new ApiError("Please sign in again."); }
    if (r.error) throw Object.assign(new ApiError(r.error.message), { status: r.status });
    return r.data;
  }
  async function post(path, body){
    const r = await api.post(path, body);
    if (r.status === 0) { offline(true); throw new ApiError("Can't reach Revivv's server."); }
    if (r.error) throw new ApiError(r.error.message);
    return r.data;
  }
  let offlineBar;
  function offline(on){
    if (!offlineBar) return;
    offlineBar.classList.toggle("hide", !on);
  }

  /* ---------- formats ---------- */
  const TZ = "America/Barbados";
  const money = n => {
    const v = Number(n || 0), neg = v < 0;
    const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: Math.abs(v) % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return (neg ? "−$" : "$") + s;
  };
  const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function date(iso, opts = {}){
    if (!iso) return "";
    const today = todayISO();
    if (!opts.plain){
      if (iso === today) return "Today";
      if (iso === addDays(today, 1)) return "Tomorrow";
      if (iso === addDays(today, -1)) return "Yesterday";
    }
    const o = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" };
    if (iso.slice(0, 4) !== today.slice(0, 4)) o.year = "numeric";
    return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", o).replace(",", "");
  }
  function time(ts){
    return new Date(ts).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
  }
  function when(ts){
    if (!ts) return "";
    const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
    return `${date(iso)}, ${time(ts)}`;
  }
  const fmt = { money, date, time, when, todayISO, addDays };
  const STATUS = { requested: "Requested", confirmed: "Confirmed", on_the_way: "On the way", in_progress: "Started",
    completed: "Done", cancelled: "Cancelled", no_show: "No-show" };
  const pill = (status, label) => el("span", { class: `pill st-${status}`, text: label || STATUS[status] || status });
  const SOURCES = { website: "Website", phone: "Phone", whatsapp: "WhatsApp", walk_in: "Walk-in", instagram: "Instagram", other: "Other" };
  const METHODS = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", mobile: "Mobile money", voucher: "Voucher", other: "Other" };

  // A booking's steps as small chips: done, now, still to come (or stopped).
  function steps(list, status){
    const stopped = status === "cancelled" || status === "no_show";
    const nowIdx = list.findIndex(s => s.key === status);
    return el("div", { class: "steps" }, list.map((s, i) => el("span", {
      class: s.key === "cancelled" || s.key === "no_show" ? "stop" : i === nowIdx && !stopped && status !== "completed" ? "now" : s.at ? "done" : "",
      title: s.at ? when(s.at) : ""
    }, s.label)));
  }

  /* ---------- small bits of UI ---------- */
  function toast(text, isErr){
    const t = el("div", { class: "toast" + (isErr ? " err" : ""), role: "status", text });
    document.body.append(t);
    setTimeout(() => t.remove(), isErr ? 5000 : 2600);
  }
  // Run an action from a button: disables it, shows errors, toasts success.
  async function act(button, fn, done){
    if (button) button.disabled = true;
    try {
      const out = await fn();
      if (done) toast(done);
      return out;
    } catch (e) {
      toast(e.message, true);
      throw e;
    } finally {
      if (button) button.disabled = false;
    }
  }
  /* A dialog. body: nodes; buttons: [{ label, class, value }]. Resolves with the
     clicked value, or null if closed. With a form inside, Enter submits the first button. */
  function dialog(title, body, buttons = [{ label: "OK", class: "btn-primary", value: true }]){
    return new Promise(resolve => {
      const d = el("dialog", { class: "dlg" });
      const form = el("form", { method: "dialog" }, el("h2", { text: title }), body,
        el("div", { class: "acts" }, buttons.map(b => el("button", { class: `btn ${b.class || ""}`, value: String(b.value), type: "submit" }, b.label)),
          el("button", { class: "btn btn-ghost", value: "", type: "submit", formnovalidate: true }, "Close")));
      d.append(form);
      d.addEventListener("close", () => { const v = d.returnValue; d.remove(); resolve(v && v !== "" ? v : null); });
      document.body.append(d);
      d.showModal();
      const first = d.querySelector("input,select,textarea");
      if (first) first.focus();
    });
  }
  async function confirm(title, text, okLabel = "Yes", danger){
    return (await dialog(title, el("p", { class: "muted", text }), [{ label: okLabel, class: danger ? "btn-danger" : "btn-primary", value: "yes" }])) === "yes";
  }
  // Ask for one line of text; resolves with it, or null if cancelled.
  async function ask(title, label, { value = "", required = true, okLabel = "Save", type = "text", hint } = {}){
    const input = el(type === "textarea" ? "textarea" : "input", { type: type === "textarea" ? null : type, value, required });
    if (type === "textarea") input.value = value;
    const v = await dialog(title, [hint ? el("p", { class: "muted small", text: hint }) : null, el("div", { class: "field" }, el("label", { text: label }), input)],
      [{ label: okLabel, class: "btn-primary", value: "ok" }]);
    return v === "ok" ? input.value.trim() : null;
  }
  function viewer(src){
    const d = el("dialog", { class: "viewer", on: { click: () => d.close() } }, el("img", { src, alt: "" }));
    d.addEventListener("close", () => d.remove());
    document.body.append(d);
    d.showModal();
  }
  const loading = n => clear(n, el("p", { class: "loading", text: "Loading…" }));
  const empty = (text) => el("p", { class: "empty", text });
  const field = (label, input, hint) => el("div", { class: "field" }, el("label", { text: label }), input, hint ? el("span", { class: "dim small", text: hint }) : null);
  function select(options, value){
    const s = el("select");
    for (const o of options){
      const [v, label] = Array.isArray(o) ? o : [o, o];
      s.append(el("option", { value: v, text: label, selected: String(v) === String(value) }));
    }
    return s;
  }
  // A link that opens WhatsApp with a phone number (Barbados numbers get 1-246 added).
  function waLink(phone, text){
    let d = String(phone || "").replace(/\D/g, "");
    if (d.length === 7) d = "1246" + d;
    if (d.length === 10) d = "1" + d;
    return d ? `https://wa.me/${d}${text ? "?text=" + encodeURIComponent(text) : ""}` : null;
  }

  /* ---------- sign in ---------- */
  let info = null;
  async function siteInfo(){
    if (info) return info;
    const r = await api.rpc("site_info");
    info = r.data || { emailCodes: false, slots: [], packages: [], addons: [], business: {} };
    return info;
  }

  function gate(main, why){
    const email = el("input", { type: "email", autocomplete: "username", placeholder: "you@example.com", required: true });
    const pass = el("input", { type: "password", autocomplete: "current-password", placeholder: "Password" });
    const code = el("input", { inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code", maxlength: 6 });
    const msg = el("p", { class: "msg err", role: "alert", text: why || "" });
    const passRow = field("Password", pass), codeRow = field("Code from your email", code);
    codeRow.classList.add("hide");
    const go = el("button", { class: "btn btn-primary btn-block", type: "submit" }, "Sign in");
    let mode = "password";
    const switcher = el("button", { class: "link-btn", type: "button", on: { click: async () => {
      msg.textContent = "";
      if (mode === "password"){
        if (!email.value) { msg.textContent = "Type your email first."; return; }
        const r = await api.auth.sendCode(email.value);
        if (r.error) { msg.textContent = r.error.message; return; }
        mode = "code"; passRow.classList.add("hide"); codeRow.classList.remove("hide"); code.focus();
        msg.className = "msg ok"; msg.textContent = "We emailed you a code.";
        switcher.textContent = "Use my password instead";
      } else {
        mode = "password"; codeRow.classList.add("hide"); passRow.classList.remove("hide");
        switcher.textContent = "Email me a code instead";
      }
    } } }, "Email me a code instead");
    const form = el("form", { class: "gate", on: { submit: async e => {
      e.preventDefault();
      msg.className = "msg err"; msg.textContent = "";
      go.disabled = true;
      const r = mode === "password"
        ? await api.auth.signInWithPassword({ email: email.value, password: pass.value })
        : await api.auth.verifyCode(email.value, code.value);
      go.disabled = false;
      if (r.status === 0) { msg.textContent = "Can't reach Revivv's server. Check the internet connection."; return; }
      if (r.error) { msg.textContent = /Invalid login/.test(r.error.message) ? "That email and password don't match." : r.error.message; return; }
      location.reload();
    } } },
      el("h1", { text: "Staff sign in" }),
      el("p", { text: "For the Revivv team. Customers: My Revivv is on the main site." }),
      field("Email", email), passRow, codeRow, msg, go,
      el("p", { class: "small", style: "margin-top:1rem" }, siteInfoHasCodes ? switcher : null),
      el("p", { class: "small" }, el("a", { href: "index.html", text: "← Back to the website" })));
    clear(main, form);
    email.focus();
  }
  let siteInfoHasCodes = false;

  /* ---------- the shell ---------- */
  async function start({ page, title, owner = false, render }){
    document.title = `${title} — Revivv Staff`;
    const main = el("main", { class: "wrap", id: "main" });
    offlineBar = el("div", { class: "o-offline hide", role: "alert", text: "Can't reach Revivv's server right now. Changes won't save until it's back." });
    const who = el("div", { class: "o-who" });
    const nav = el("nav", { class: "o-nav", "aria-label": "Back office" });
    const head = el("header", { class: "o-head" },
      el("div", { class: "wrap" },
        el("div", { class: "o-bar" }, el("a", { class: "o-brand", href: "staff.html" }, "Revivv ", el("span", { text: "· Staff" })), who),
        nav),
      offlineBar);
    const root = document.getElementById("office") || document.body;
    clear(root, head, main);
    loading(main);

    const [s, me] = await Promise.all([siteInfo(), api.staffMe()]);
    siteInfoHasCodes = !!s.emailCodes;
    if (me.status === 0) { clear(main, el("div", { class: "alert bad", text: "Can't reach Revivv's server right now. Try again in a minute." })); return; }
    const staff = me.data;
    if (!staff){
      nav.classList.add("hide");
      const session = await api.auth.getSession();
      gate(main, session.data.session ? "This account isn't on the staff list. Sign in with your staff email." : "");
      return;
    }
    const user = { ...staff, owner: staff.role === "owner" };
    for (const n of NAV){
      if (n.owner && !user.owner) continue;
      nav.append(el("a", { href: n.href, class: n.key === page ? "is-active" : "", "aria-current": n.key === page ? "page" : null },
        n.label, n.badge ? el("span", { class: "badge", id: "msgBadge" }) : null));
    }
    clear(who, el("b", { text: user.name }), el("span", { text: user.owner ? "Owner" : "Crew" }),
      el("button", { class: "link-btn", on: { click: async () => { await api.auth.signOut(); location.href = "staff.html"; } } }, "Sign out"));
    const active = nav.querySelector(".is-active");
    if (active) active.scrollIntoView({ inline: "center", block: "nearest" });

    if (owner && !user.owner){
      clear(main, el("div", { class: "alert", text: "This page is for the owners." }), el("a", { href: "staff.html", class: "btn" }, "Back to Today"));
      return;
    }
    // Opened from a password link (api.js has already signed them in): choose a password now.
    if (param("type") === "recovery") await choosePassword();
    refreshBadge();
    setInterval(refreshBadge, 60_000);
    try {
      clear(main);
      await render(main, user, s);
    } catch (e) {
      clear(main, el("div", { class: "alert bad", text: e.message || "Something went wrong." }));
    }
  }

  async function choosePassword(){
    const p1 = el("input", { type: "password", autocomplete: "new-password", minlength: 8, required: true });
    const p2 = el("input", { type: "password", autocomplete: "new-password", minlength: 8, required: true });
    const msg = el("p", { class: "msg err", role: "alert" });
    for (;;){
      const v = await dialog("Choose your password", [
        el("p", { class: "muted small", text: "You'll use it with your email to sign in to the back office. At least 8 characters." }),
        field("New password", p1), field("Type it again", p2), msg
      ], [{ label: "Save password", class: "btn-primary", value: "ok" }]);
      if (v !== "ok") break;
      if (p1.value.length < 8) { msg.textContent = "Use at least 8 characters."; continue; }
      if (p1.value !== p2.value) { msg.textContent = "The two passwords don't match."; continue; }
      const r = await api.auth.updateUser({ password: p1.value });
      if (r.error) { msg.textContent = r.error.message; continue; }
      toast("Password saved.");
      break;
    }
    const q = new URLSearchParams(location.search);
    q.delete("type");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
  }

  async function refreshBadge(){
    const r = await api.rpc("staff_inbox");
    if (!r.data) return;
    const n = r.data.filter(t => t.unread > 0).length;
    const b = document.getElementById("msgBadge");
    if (b) b.textContent = n ? String(n) : "";
  }

  window.Office = {
    start, el, add, clear, $, param, rpc, post, fmt, pill, steps, toast, act, dialog, confirm, ask, viewer,
    loading, empty, field, select, waLink, refreshBadge, siteInfo, STATUS, SOURCES, METHODS, api
  };
})();
