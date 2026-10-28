/* ===== Messages (my-messages.html): the conversation with Revivv =====
   Checks for new messages every 20 seconds while the page is open on screen. */
(() => {
  "use strict";
  const M = window.my;
  const { el, $, call } = M;
  const root = $("myRoot");
  const EVERY = 20000;

  let talk = null, timer = null, busy = false, warn = null;

  async function refresh() {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    const r = await call("my_thread");            // also marks them as read
    busy = false;
    if (r.error) {
      warn.textContent = M.isDown(r) ? "Can't reach Revivv right now. We'll keep trying." : M.errText(r);
      warn.hidden = false;
      return;
    }
    warn.hidden = true;
    talk.render(r.data.messages);
    M.setBadge(0);
  }
  function tick() {
    clearInterval(timer);
    if (document.visibilityState === "visible") timer = setInterval(refresh, EVERY);
  }

  async function load() {
    const user = await M.start({ root, why: "Sign in to see your messages.", badge: false });
    if (!user) return;
    const r = await call("my_thread");
    if (r.error) { root.replaceChildren(M.errorPanel(r)); return; }

    talk = M.chat({ links: true, send: body => call("my_send", { body }) });
    warn = el("p", { class: "msg err", role: "status", hidden: true });
    root.replaceChildren(
      el("div", { class: "my-head" },
        el("h1", { class: "title", text: "Messages" }),
        el("p", { text: "Ask us anything about your bookings, your car or our packages. We usually reply within a few hours, Monday to Saturday." })),
      el("section", { class: "card", "aria-label": "Conversation with Revivv" }, warn, talk.node),
      el("p", { class: "hint" }, "In a hurry? ", el("a", { href: M.WA, target: "_blank", rel: "noopener" }, "WhatsApp us"),
        " or call ", el("a", { href: M.TEL }, M.PHONE), "."));
    talk.render(r.data.messages, true);
    M.setBadge(0);

    tick();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
      tick();
    });
  }

  load().catch(err => { console.error(err); root.replaceChildren(M.errorPanel({ error: { message: "Something went wrong. Please reload the page." }, status: 400 })); });
})();
