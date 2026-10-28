/* ===== My bookings (my-bookings.html): coming up and past ===== */
(() => {
  "use strict";
  const M = window.my;
  const { el, $, money, call } = M;
  const root = $("myRoot");

  function item(b, past) {
    return el("a", { class: "bk" + (past ? " past" : ""), href: M.bookingLink(b.ref, b.key) },
      el("span", { class: "bk-when" }, b.dateText, el("span", { class: "sr-only", text: ", " })),
      M.pill(b.status, b.statusLabel),
      el("span", { class: "bk-what" },
        b.slotText, el("br"),
        b.package + " · " + M.carText(b.vehicleType, b.vehicleDesc), el("br"),
        money(b.total) + " · Ref " + b.ref),
      el("span", { class: "bk-go", "aria-hidden": "true", text: "→" }));
  }

  async function load() {
    const user = await M.start({ root, why: "Sign in to see your bookings." });
    if (!user) return;
    const r = await call("my_bookings");
    if (r.error) { root.replaceChildren(M.errorPanel(r)); return; }
    const { upcoming = [], past = [] } = r.data || {};

    const book = el("a", { class: "btn btn-primary my-wide", href: "quote.html" }, "Book a detail");
    const out = [
      el("div", { class: "my-head" },
        el("h1", { class: "title", text: "My bookings" }),
        el("p", { text: "Tap a booking to see where it's up to, payments, photos and messages." })),
      el("h2", { class: "my-sec", text: "Coming up" })
    ];
    if (upcoming.length) out.push(el("div", { class: "bk-list" }, upcoming.map(b => item(b, false))));
    else out.push(el("p", { class: "my-empty", text: "No bookings coming up." }));
    out.push(el("div", { class: "my-actions" }, book));

    out.push(el("h2", { class: "my-sec", text: "Past and cancelled" }));
    if (past.length) out.push(el("div", { class: "bk-list" }, past.map(b => item(b, true))));
    else out.push(el("p", { class: "my-empty", text: "Your past details will show here." }));

    root.replaceChildren(...out);
  }

  load().catch(err => { console.error(err); root.replaceChildren(M.errorPanel({ error: { message: "Something went wrong. Please reload the page." }, status: 400 })); });
})();
