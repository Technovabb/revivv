/* ===== My Revivv: shared helpers =====
   Used by portal.html and the my-*.html pages. Everything is on window.my.
   Data from the server only ever goes in with textContent (see el()). */
(() => {
  "use strict";
  const api = window.revivvApi || null;
  const TZ = "America/Barbados";
  const PHONE = "1-246-260-8228";
  const TEL = "tel:+12462608228";
  const WA = "https://wa.me/12462608228";

  /* ---------- building the page ---------- */
  // el("p", { class: "x", text: "Hi" }, child, "more text", [list]) — text only, never HTML.
  const PROPS = ["value", "checked", "disabled", "selected", "hidden", "readOnly"];
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = String(v);
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (PROPS.includes(k)) n[k] = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    return add(n, kids);
  }
  function add(n, kids) {
    for (const k of [kids].flat(Infinity)) {
      if (k == null || k === false || k === "") continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return n;
  }
  const $ = id => document.getElementById(id);
  function say(node, text, kind) {
    if (!node) return;
    node.className = "msg" + (kind ? " " + kind : "");
    node.textContent = text || "";
  }

  /* ---------- money and dates (Barbados time) ---------- */
  function money(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100, a = Math.abs(v);
    const s = a.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(a) ? 0 : 2, maximumFractionDigits: 2 });
    return (v < 0 ? "−" : "") + "$" + s;
  }
  const toDate = v => (v instanceof Date ? v : new Date(v));
  function parts(v, opts) {
    const out = {};
    new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: TZ }, opts)).formatToParts(toDate(v)).forEach(p => { out[p.type] = p.value; });
    return out;
  }
  function isoDay(v) { const p = parts(v, { year: "numeric", month: "2-digit", day: "2-digit" }); return p.year + "-" + p.month + "-" + p.day; }
  const todayISO = () => isoDay(new Date());
  function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // "8:49am"
  function clock(v) {
    const p = parts(v, { hour: "numeric", minute: "2-digit", hourCycle: "h12" });
    return p.hour + ":" + p.minute + String(p.dayPeriod || "").toLowerCase().replace(/[\s.]/g, "");
  }
  // "Wed 28 Oct" (with the year when it isn't this year)
  function day(v) {
    const p = parts(v, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return p.weekday + " " + p.day + " " + p.month + (p.year !== todayISO().slice(0, 4) ? " " + p.year : "");
  }
  // "Wed 28 Oct, 8:49am"
  const when = v => day(v) + ", " + clock(v);
  function dayLabel(v) {
    const k = isoDay(v), t = todayISO();
    if (k === t) return "Today";
    if (k === addDays(t, -1)) return "Yesterday";
    return day(v);
  }

  /* ---------- talking to the server ---------- */
  const DOWN = { data: null, error: { message: "Can't reach Revivv right now.", status: 0 }, status: 0 };
  const call = (name, params) => (api ? api.rpc(name, params) : Promise.resolve(DOWN));
  const isDown = r => !!(r && r.error) && (!r.status || r.status >= 500);
  function errText(r) {
    if (isDown(r)) return "We can't reach Revivv right now. Please try again in a minute, or WhatsApp us on " + PHONE + ".";
    return (r && r.error && r.error.message) || "Something went wrong. Please try again.";
  }
  // { user, down }: user is { email } when signed in.
  async function session() {
    if (!api) return { user: null, down: true };
    const r = await api.auth.getSession();
    if (r.error && (!r.error.status || r.error.status >= 500)) return { user: null, down: true };
    return { user: (r.data && r.data.session && r.data.session.user) || null, down: false };
  }
  let accountReq = null;
  const account = (fresh) => (!fresh && accountReq) || (accountReq = call("my_account"));

  /* ---------- the sub-menu ---------- */
  const pageName = () => (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
  function markNav() {
    const page = pageName();
    document.querySelectorAll(".my-nav a").forEach(a => {
      if ((a.dataset.myPage || "").split(" ").includes(page)) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  function showNav(on) {
    document.querySelectorAll(".my-nav").forEach(n => n.classList.toggle("is-on", !!on));
  }
  function setBadge(n) {
    n = Math.max(0, Number(n) || 0);
    document.querySelectorAll("[data-my-unread]").forEach(b => {
      b.hidden = n === 0;
      b.replaceChildren(el("span", { "aria-hidden": "true", text: n > 99 ? "99+" : n }),
        el("span", { class: "sr-only", text: " (" + n + " new)" }));
    });
  }
  async function refreshBadge() {
    const r = await account();
    if (!r.error && r.data) setBadge(r.data.unread);
  }

  /* ---------- panels ---------- */
  // Where this page is, for portal.html?next=… (portal only accepts my-*.html and portal.html).
  const here = () => (location.pathname.split("/").pop() || "portal.html") + location.search;
  function contact(text) {
    return el("div", { class: "my-contact" },
      text ? el("p", { class: "sr-only", text }) : null,
      el("a", { class: "btn btn-wa", href: WA, target: "_blank", rel: "noopener" }, "WhatsApp us"),
      el("a", { class: "btn btn-ghost", href: TEL }, "Call " + PHONE));
  }
  function offlinePanel(extra) {
    return el("div", { class: "offline-note", role: "status" },
      el("b", { text: "We can't reach Revivv right now." }),
      " " + (extra || "Please try again in a few minutes.") + " Need us now? ",
      el("a", { href: WA, target: "_blank", rel: "noopener" }, "WhatsApp " + PHONE),
      " or ", el("a", { href: TEL }, "call us"), ".");
  }
  // "Sign in to see your bookings." → a card with a Sign in button that comes back here.
  function signedOutPanel(why) {
    document.body.dataset.myState = "out";
    return el("section", { class: "card my-gate" },
      el("h1", { class: "title", text: "Please sign in" }),
      el("p", { text: why || "Sign in to see this page." }),
      el("a", { class: "btn btn-primary my-wide", href: "portal.html?next=" + encodeURIComponent(here()) }, "Sign in"),
      el("p", { class: "hint" }, "No password yet? On the sign-in page, tap “First time? Create a password” and use the email you booked with."));
  }
  function errorPanel(r) {
    if (isDown(r)) return offlinePanel();
    return el("div", { class: "card" }, el("p", { class: "msg err", text: errText(r) }),
      el("p", { class: "hint" }, "Still stuck? ", el("a", { href: WA, target: "_blank", rel: "noopener" }, "WhatsApp us"), " or call ", el("a", { href: TEL }, PHONE), "."));
  }

  /* Start a signed-in page. Returns the user, or null after showing the
     right panel (offline / please sign in) in `root`. */
  async function start({ root, why, badge = true }) {
    markNav();
    const s = await session();
    if (s.down) { root.replaceChildren(offlinePanel()); return null; }
    if (!s.user) { root.replaceChildren(signedOutPanel(why)); return null; }
    document.body.dataset.myState = "in";
    showNav(true);
    if (badge) refreshBadge();
    return s.user;
  }
  // Coming back with the Back button to a page that said "Please sign in": check again.
  window.addEventListener("pageshow", e => { if (e.persisted && document.body.dataset.myState === "out") location.reload(); });

  /* ---------- booking bits ---------- */
  const METHOD = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", mobile: "Mobile payment", voucher: "Gift voucher", other: "Other" };
  const methodLabel = m => METHOD[m] || "Payment";
  const STATUS = {
    requested: "Requested", confirmed: "Confirmed", on_the_way: "On the way", in_progress: "Started",
    completed: "Done", cancelled: "Cancelled", no_show: "No-show"
  };
  const pill = (status, label) => el("span", { class: "pill s-" + status, text: label || STATUS[status] || status });
  const carText = (type, desc) => [desc, type].filter(Boolean).join(" · ");
  const bookingLink = (ref, key) => "my-booking.html?ref=" + encodeURIComponent(ref) + (key ? "&k=" + encodeURIComponent(key) : "");

  // The 6-stamp card (styles from site.css).
  function stampCard(stamps) {
    const n = Math.max(0, Math.min(6, Number(stamps) || 0));
    const row = el("div", { class: "stamps", "aria-hidden": "true" });
    for (let i = 0; i < 6; i++) {
      if (i < n) row.append(el("span", { class: "stamp on", text: "✓" }));
      else if (i === 5) row.append(el("span", { class: "stamp free", text: "50%" }));
      else row.append(el("span", { class: "stamp", text: i + 1 }));
    }
    const left = 6 - n;
    const hint = n >= 5 ? "Your next detail is 50% off (the package price)."
      : "You're " + left + " detail" + (left === 1 ? "" : "s") + " away from 50% off.";
    return el("section", { class: "card" },
      el("h2", { class: "card-h" }, "Stamps: " + n + " of 6"),
      row,
      el("p", { class: "hint", text: hint }),
      el("p", { class: "hint" }, "You get a stamp for each finished detail. ", el("a", { href: "rewards.html" }, "How rewards work")));
  }

  /* ---------- the conversation ---------- */
  /* chat({ send(body) → Promise<{data:{messages}, error}>, links: show booking refs as links })
     Returns { node, render(messages, toBottom) }. */
  function chat({ send, links = false, intro }) {
    const box = el("div", { class: "chat-box", tabindex: "0", "aria-label": "Messages with Revivv" });
    const ta = el("textarea", { id: "chatText", rows: "2", maxlength: "2000", placeholder: "Write a message…", autocomplete: "off" });
    const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Send");
    const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
    const form = el("form", { class: "chat-form", novalidate: true },
      el("label", { class: "sr-only", for: "chatText", text: "Your message" }),
      el("div", { class: "chat-in" }, ta, btn),
      msg,
      el("p", { class: "hint", text: "Enter sends. Shift + Enter makes a new line." }));
    const node = el("div", { class: "chat" },
      el("p", { class: "chat-note", text: intro || "We usually reply within a few hours, Monday to Saturday." }), box, form);

    let lastId = 0, count = 0, lastDay = "";
    function bubble(m) {
      if (m.sender === "system") {
        return el("p", { class: "chat-sys" }, el("span", { text: m.body }), el("time", { datetime: m.at, text: clock(m.at) }));
      }
      const me = m.sender === "customer";
      return el("div", { class: "chat-row " + (me ? "me" : "them") },
        el("div", { class: "bubble" },
          me ? el("span", { class: "sr-only", text: "You: " }) : el("b", { class: "who", text: m.name || "Revivv" }),
          el("p", { class: "body", text: m.body }),
          el("span", { class: "meta" },
            links && m.ref ? el("a", { href: bookingLink(m.ref), text: m.ref }) : null,
            el("time", { datetime: m.at, text: clock(m.at) }))));
    }
    function render(messages, toBottom) {
      messages = messages || [];
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
      const fresh = messages.filter(m => m.id > lastId);
      const first = count === 0;
      if (!messages.length && box.querySelector(".my-empty")) return;   // still empty
      if (count > 0 && messages.length - fresh.length === count) {
        if (!fresh.length) return;                     // nothing new
      } else {
        box.replaceChildren(); lastDay = ""; fresh.length = 0; fresh.push(...messages);
      }
      if (!messages.length) box.append(el("p", { class: "my-empty chat-sys", text: "No messages yet. Ask us anything — we're happy to help." }));
      else if (box.querySelector(".my-empty")) box.querySelector(".my-empty").remove();
      for (const m of fresh) {
        const d = dayLabel(m.at);
        if (d !== lastDay) { box.append(el("p", { class: "chat-day", text: d })); lastDay = d; }
        box.append(bubble(m));
      }
      lastId = messages.length ? messages[messages.length - 1].id : 0;
      count = messages.length;
      if (first || near || toBottom) box.scrollTop = box.scrollHeight;
      if (first) box.setAttribute("role", "log");     // announce new messages after the first load
    }

    ta.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) { say(msg, "Write a message first.", "err"); ta.focus(); return; }
      if (btn.disabled) return;
      btn.disabled = true; say(msg, "Sending…");
      let r;
      try { r = await send(body); } catch (err) { r = DOWN; }
      btn.disabled = false;
      if (r.error) { say(msg, errText(r), "err"); return; }
      ta.value = "";
      say(msg, "Sent.", "ok");
      setTimeout(() => { if (msg.textContent === "Sent.") say(msg, ""); }, 2500);
      if (r.data && r.data.messages) render(r.data.messages, true);
    });
    return { node, render, box };
  }

  window.my = {
    el, add, $, say, money, clock, day, when, dayLabel, isoDay, todayISO,
    call, isDown, errText, session, account, start,
    markNav, showNav, setBadge, refreshBadge,
    contact, offlinePanel, signedOutPanel, errorPanel,
    methodLabel, pill, carText, bookingLink, stampCard, chat,
    PHONE, TEL, WA
  };
})();
