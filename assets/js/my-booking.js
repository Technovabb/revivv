/* ===== One booking (my-booking.html) =====
   Opened from the link in every customer email:
     my-booking.html?ref=RV-…&k=<key>   works without signing in
     my-booking.html?ref=RV-…           for a signed-in customer */
(() => {
  "use strict";
  const M = window.my;
  const { el, $, say, money, when, day, call, isDown, errText, session, account, chat } = M;
  const api = window.revivvApi;

  const q = new URLSearchParams(location.search);
  const ref = (q.get("ref") || "").trim().toUpperCase();
  const k = (q.get("k") || "").trim();
  const byKey = !!k;
  const root = $("myRoot"), receipt = $("receipt");

  const NOTE = {
    requested: "We've got your request. We'll confirm your slot soon.",
    confirmed: "You're booked in. See you then!",
    on_the_way: "We're on our way to you.",
    in_progress: "We're working on your vehicle now.",
    completed: "All done. Thank you for choosing Revivv!",
    cancelled: "This booking was cancelled.",
    no_show: "We missed you on the day."
  };
  const OPEN = ["requested", "confirmed", "on_the_way", "in_progress"];

  let flash = "";          // a one-off line at the top, e.g. after cancelling
  let talk = null;         // the conversation, kept between reloads

  /* ---------- pieces ---------- */
  function heading(b) {
    let note = NOTE[b.status] || "";
    if (b.status === "cancelled" && b.cancelReason) {
      note = /by the customer/i.test(b.cancelReason) ? "You cancelled this booking." : "This booking was cancelled. Reason: " + b.cancelReason;
    }
    return el("div", { class: "my-head" },
      el("p", { class: "eyebrow", text: "Booking " + b.ref }),
      el("h1", { class: "title", text: b.statusLabel || b.status }),
      el("p", { text: b.dateText + " · " + b.slotText }),
      el("p", { text: note }));
  }

  function steps(b) {
    const stopped = b.status === "cancelled" || b.status === "no_show";
    const list = stopped ? b.steps.filter(s => s.at || s.key === b.status) : b.steps;
    const cur = list.findIndex(s => s.key === b.status);
    const ol = el("ol", { class: "my-steps" });
    list.forEach((s, i) => {
      let cls, mark, sub;
      if (s.key === "cancelled" || s.key === "no_show") { cls = "stop now"; mark = "✕"; }
      else if (s.at) { cls = "done" + (i === cur ? " now" : ""); mark = "✓"; }
      else if (i < cur) { cls = "skip"; mark = ""; sub = "Skipped"; }
      else { cls = "todo"; mark = String(i + 1); }
      ol.append(el("li", { class: cls, "aria-current": i === cur ? "step" : null },
        el("span", { class: "dot", "aria-hidden": "true", text: mark }),
        el("b", { text: s.label }),
        s.at ? el("time", { datetime: s.at, text: when(s.at) }) : sub ? el("small", { text: sub }) : null,
        el("span", { class: "sr-only", text: s.at ? " (done)" : i === cur ? " (now)" : " (not yet)" })));
    });
    return el("section", { class: "card", "aria-labelledby": "stepsTitle" },
      el("h2", { class: "card-h", id: "stepsTitle", text: "Where it's up to" }), ol);
  }

  const row = (label, value, sub, cls) => el("div", { class: "my-row" + (cls ? " " + cls : "") },
    el("span", { text: label }), el("span", null, value, sub ? el("span", { class: "sub", text: sub }) : null));

  function details(b) {
    const where = b.mobile
      ? row("Where", "We come to you", [b.address, b.parish].filter(Boolean).join(", "))
      : row("Where", "Drop off", "You bring your vehicle to us");
    return el("section", { class: "card", "aria-labelledby": "detailsTitle" },
      el("h2", { class: "card-h", id: "detailsTitle", text: "Your booking" }),
      el("div", { class: "my-rows" },
        row("Date", b.dateText, b.slotText),
        where,
        row("Package", b.package),
        row("Vehicle", M.carText(b.vehicleType, b.vehicleDesc)),
        row("Add-ons", b.addons || "None"),
        b.notes ? row("Your notes", b.notes) : null));
  }

  function moneyCard(b) {
    const extras = [];
    if (b.rewardApplied) extras.push("Includes your 50% stamp reward");
    if (b.creditUsed > 0) extras.push("Includes " + money(b.creditUsed) + " credit");
    const paidUp = b.owing <= 0 && b.paid > 0;
    const cancelled = b.status === "cancelled";
    let last;
    if (cancelled) last = null;
    else if (paidUp) last = row("Still to pay", "Paid in full", null, "big good");
    else last = row("Still to pay", money(Math.max(0, b.owing)), null, "big owe");
    let hint;
    if (cancelled) hint = el("p", { class: "hint", text: b.paid > 0 ? "This booking was cancelled. WhatsApp or call us about your money back." : "This booking was cancelled, so there's nothing to pay." });
    else if (!b.payments.length) hint = el("p", { class: "hint", text: "No payments yet." });
    if (b.payments.length) hint = el("p", { class: "hint" }, hint ? hint.textContent + " " : "", el("a", { href: "#receipt" }, "See your receipt"));
    return el("section", { class: "card", "aria-labelledby": "moneyTitle" },
      el("h2", { class: "card-h", id: "moneyTitle", text: "Price and payments" }),
      el("div", { class: "my-rows" },
        row("Price", money(b.total), extras.join(". ")),
        row("Paid", money(b.paid)),
        last),
      hint);
  }

  function changeCard(b) {
    const card = el("section", { class: "card", "aria-labelledby": "changeTitle" });
    if (b.canCancel) {
      const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
      const area = el("div", { class: "my-actions" });
      const ask = () => {
        area.replaceChildren(
          el("p", { class: "my-wide", text: "Cancel your booking for " + b.dateText + "? This can't be undone." }),
          el("button", { class: "btn btn-danger solid", type: "button", on: { click: go } }, "Yes, cancel it"),
          el("button", { class: "btn btn-ghost", type: "button", on: { click: back } }, "No, keep it"));
        area.lastElementChild.focus();
      };
      const back = () => { area.replaceChildren(cancelBtn); say(msg, ""); cancelBtn.focus(); };
      async function go(e) {
        area.querySelectorAll("button").forEach(x => { x.disabled = true; });
        e.target.textContent = "Cancelling…";
        const r = byKey ? await call("booking_cancel", { ref, k }) : await call("my_cancel", { ref });
        if (r.error) { back(); say(msg, errText(r), "err"); return; }
        flash = "Your booking is cancelled. We hope to see you another time.";
        load();
      }
      const cancelBtn = el("button", { class: "btn btn-danger", type: "button", on: { click: ask } }, "Cancel booking");
      area.append(cancelBtn);
      card.append(
        el("h2", { class: "card-h", id: "changeTitle", text: "Need to cancel?" }),
        el("p", { text: "You can cancel online up to " + b.cancelHours + " hours before your slot. That's until " + when(b.cancelBy) + "." }),
        area, msg,
        el("p", { class: "hint", text: "To change the date or time, WhatsApp or call us." }),
        M.contact());
    } else if (OPEN.includes(b.status)) {
      M.add(card, [
        el("h2", { class: "card-h", id: "changeTitle", text: "Need to change something?" }),
        el("p", { text: "To change or cancel, WhatsApp or call us." }),
        (b.status === "requested" || b.status === "confirmed")
          ? el("p", { class: "hint", text: "It's less than " + b.cancelHours + " hours to your slot, so this booking can't be cancelled online." }) : null,
        M.contact()]);
    } else {
      card.append(
        el("h2", { class: "card-h", id: "changeTitle", text: "Questions?" }),
        el("p", { text: "WhatsApp or call us about this booking." }),
        M.contact(),
        el("div", { class: "my-actions" }, el("a", { class: "btn btn-primary", href: "quote.html" }, "Book another detail")));
    }
    return card;
  }

  const KINDS = [
    ["before", "Before", ""],
    ["after", "After", ""],
    ["damage", "Marks we found", "We photograph any marks or damage before we start, so everyone knows they were already there."]
  ];
  function photos(b) {
    if (!b.photos || !b.photos.length) return null;
    const sec = el("section", { class: "card", "aria-labelledby": "photosTitle" },
      el("h2", { class: "card-h", id: "photosTitle" }, "Photos", el("small", { text: "Taken by our team. Tap a photo to see it bigger." })));
    for (const [kind, label, note] of KINDS) {
      const list = b.photos.filter(p => p.kind === kind);
      if (!list.length) continue;
      const grid = el("div", { class: "photo-grid" });
      list.forEach((p, i) => {
        const src = api.photoUrl(p.id, byKey ? k : undefined);
        const alt = p.caption || label + " photo " + (i + 1);
        grid.append(el("figure", null,
          el("a", { href: src, target: "_blank", rel: "noopener" },
            el("img", { src, alt, loading: "lazy", width: "300", height: "300" })),
          p.caption ? el("figcaption", { text: p.caption }) : null));
      });
      sec.append(el("div", { class: "photo-group" },
        el("h3", { text: label }), note ? el("p", { class: "hint", text: note }) : null, grid));
    }
    return sec;
  }

  function messages(list, unread) {
    if (!talk) {
      talk = chat({
        links: !byKey,
        intro: (byKey ? "Messages about this booking." : "This is your whole conversation with Revivv.") +
          " We usually reply within a few hours, Monday to Saturday.",
        send: body => (byKey ? call("booking_send", { ref, k, body }) : call("my_send", { ref, body }))
      });
    }
    const sec = el("section", { class: "card", id: "messages", "aria-labelledby": "msgTitle" },
      el("h2", { class: "card-h", id: "msgTitle", text: "Messages" }), talk.node);
    // render after it's on the page, so it can scroll to the newest message
    setTimeout(() => talk.render(list), 0);
    return sec;
  }

  function fillReceipt(b, name) {
    if (!b.payments.length) { receipt.hidden = true; document.body.classList.remove("has-receipt"); return; }
    const rows = [
      row("Date", day(new Date())),
      row("Customer", name || b.name),
      row("Booking", b.ref, b.dateText + " · " + b.slotText),
      row("Package", b.package, M.carText(b.vehicleType, b.vehicleDesc)),
      b.addons ? row("Add-ons", b.addons) : null,
      row("Price", money(b.total))
    ];
    b.payments.forEach(p => {
      const refund = p.amount < 0;
      rows.push(row((refund ? "Refund" : "Paid") + " · " + M.methodLabel(p.method), money(p.amount), day(p.at)));
    });
    rows.push(row("Total paid", money(b.paid), null, "good"));
    rows.push(b.owing <= 0 ? row("Still to pay", "Nothing", null, "big good") : row("Still to pay", money(b.owing), null, "big"));
    receipt.replaceChildren(
      el("div", { class: "receipt-top" },
        el("img", { src: "images/logo.png", alt: "Revivv", width: "130", height: "34" }),
        el("p", null, "Revivv Vehicle Detailing", el("br"), M.PHONE, el("br"), "revivvbb.com")),
      el("h2", { class: "card-h", id: "receiptTitle" }, "Receipt", el("small", { text: "Booking " + b.ref })),
      el("div", { class: "my-rows" }, rows),
      el("p", { class: "receipt-foot", text: "Prices in Barbados dollars (BBD). Thank you for choosing Revivv." }),
      el("div", { class: "my-actions no-print" },
        el("button", { class: "btn btn-ghost", type: "button", on: { click: () => window.print() } }, "Print receipt")));
    receipt.hidden = false;
    document.body.classList.add("has-receipt");
  }

  function render(b, { stamps, list, unread, name, signedIn }) {
    const out = [];
    if (flash) { out.push(el("p", { class: "my-alert ok", role: "status", text: flash })); flash = ""; }
    if (unread > 0) {
      out.push(el("p", { class: "my-alert" },
        el("span", { text: "You have " + unread + " new message" + (unread === 1 ? "" : "s") + " from Revivv." }),
        el("a", { href: "#messages" }, "Read now")));
    }
    out.push(heading(b), steps(b), details(b), moneyCard(b), changeCard(b), messages(list, unread), photos(b));
    if (stamps != null) out.push(M.stampCard(stamps));
    if (!signedIn) {
      out.push(el("p", { class: "hint" }, "Have a Revivv password? ",
        el("a", { href: "portal.html?next=my-bookings.html" }, "Sign in to see all your bookings"), "."));
    }
    root.replaceChildren(...out.filter(Boolean));
    fillReceipt(b, name);
  }

  function notFound(text) {
    root.replaceChildren(el("section", { class: "card my-gate" },
      el("h1", { class: "title", text: "Booking not found" }),
      el("p", { text: text }),
      M.contact(),
      el("p", { class: "hint" }, el("a", { href: "my-bookings.html" }, "See all your bookings"),
        document.body.dataset.myState === "in" ? "." : " (you'll need to sign in).")));
  }

  /* ---------- loading ---------- */
  let first = true;
  async function load() {
    M.markNav();
    if (!ref) { notFound("This link is missing the booking number. Open the link in your latest Revivv email again."); return; }

    if (byKey) {
      const [r, s] = await Promise.all([call("booking_view", { ref, k }), first ? session() : Promise.resolve(null)]);
      if (r.error) {
        if (isDown(r)) root.replaceChildren(M.offlinePanel("We can't show your booking at the moment."));
        else notFound(r.error.message);
        return;
      }
      const d = r.data;
      if (s && s.user) { document.body.dataset.myState = "in"; M.showNav(true); }
      const signedIn = document.body.dataset.myState === "in";
      render(d.booking, { stamps: d.customer.stamps, list: d.messages, unread: first ? d.unread : 0, name: d.customer.name, signedIn });
      if (first && d.unread > 0) {
        await call("booking_read", { ref, k });
        if (signedIn) M.refreshBadge();
      } else if (first && signedIn) M.refreshBadge();
    } else {
      const user = first ? await M.start({ root, why: "Sign in to see this booking.", badge: false }) : true;
      if (!user) return;
      const [r, a] = await Promise.all([call("my_booking", { ref }), account(!first)]);
      if (r.error) {
        if (isDown(r)) root.replaceChildren(M.offlinePanel("We can't show your booking at the moment."));
        else notFound(r.error.message + " If you were sent a link by email, open that link instead.");
        return;
      }
      const acct = a && !a.error ? a.data : null;
      const t = await call("my_thread");            // also marks the messages as read
      const list = t.error ? [] : t.data.messages;
      render(r.data, { stamps: acct ? acct.stamps : null, list, unread: first && acct ? acct.unread : 0, name: acct && acct.name, signedIn: true });
      if (!t.error) M.setBadge(0);
    }
    if (first && location.hash === "#messages") {
      const m = $("messages");
      if (m) m.scrollIntoView();
    }
    first = false;
  }

  load().catch(err => { console.error(err); root.replaceChildren(M.errorPanel({ error: { message: "Something went wrong showing this booking. Please reload the page." }, status: 400 })); });
})();
