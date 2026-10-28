/* Back office: Emails (staff-outbox.html, owners only). Every email Revivv sends
   to customers and staff. With no mailbox yet they are held here, not sent, and
   can be passed on by WhatsApp. */
(() => {
  const { el, clear, rpc, fmt, act, toast, empty, loading, waLink, param } = Office;

  const KIND = {
    requested: "Booking received",
    confirmed: "Booking confirmed",
    moved: "Booking moved",
    reminder: "Reminder",
    on_the_way: "On the way",
    completed: "Thank you",
    cancelled: "Booking cancelled",
    nudge: "Time for your next detail",
    message_to_customer: "Message to the customer",
    message_to_staff: "Message to staff",
    staff_new_booking: "New booking (to staff)",
    staff_cancelled: "Booking cancelled (to staff)"
  };
  // Emails that go to staff: never sent to the customer's WhatsApp.
  const TO_STAFF = new Set(["message_to_staff", "staff_new_booking", "staff_cancelled"]);
  const STATUS = { held: "Waiting", pending: "Sending", sent: "Sent", failed: "Failed" };
  const CHIPS = [["", "All"], ["held", "Waiting"], ["sent", "Sent"], ["failed", "Failed"]];

  async function copy(text){
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = el("textarea", { class: "offscreen", readonly: true });
      t.value = text;
      document.body.append(t); t.select();
      try { document.execCommand("copy"); } catch { /* nothing more to try */ }
      t.remove();
    }
    toast("Copied");
  }

  function emailItem(e, held, reload){
    const kind = KIND[e.kind] || (e.kind || "Email").replace(/_/g, " ");
    const wa = e.phone && !TO_STAFF.has(e.kind) ? waLink(e.phone, e.body) : null;
    const acts = el("div", { class: "acts" },
      wa ? el("a", { class: "btn btn-ok", href: wa, target: "_blank", rel: "noopener" }, "Send on WhatsApp") : null,
      el("button", { class: "btn", type: "button", on: { click: () => copy(e.body || "") } }, "Copy text"),
      e.ref ? el("a", { class: "btn btn-ghost", href: `staff-booking.html?ref=${encodeURIComponent(e.ref)}` }, `Booking ${e.ref}`) : null,
      !held && e.status === "failed" ? el("button", { class: "btn btn-primary", type: "button", on: { click: async ev => {
        await act(ev.currentTarget, () => rpc("outbox_retry", { id: e.id }), "It will be sent again shortly").then(reload, () => {});
      } } }, "Try again") : null);
    return el("details", { class: "item mail" },
      el("summary", {},
        el("div", { class: "item-top" },
          el("div", { class: "mail-head" },
            el("h3", { text: e.subject || "(no subject)" }),
            el("div", { class: "meta", text: `To ${e.to_addr}` }),
            el("div", { class: "meta", text: `${kind} · ${fmt.when(e.created_at)}` })),
          el("div", { class: "right" },
            el("span", { class: `pill ${e.status === "failed" ? "st-cancelled" : "soft"}`, text: STATUS[e.status] || e.status }))),
        el("span", { class: "more", "aria-hidden": "true" })),
      el("div", { class: "mail-body", text: e.body || "" }),
      e.sent_at ? el("p", { class: "dim small", text: `Sent ${fmt.when(e.sent_at)}` }) : null,
      e.status === "failed" && e.last_error ? el("p", { class: "msg err", text: `What went wrong: ${e.last_error}` }) : null,
      TO_STAFF.has(e.kind) ? el("p", { class: "dim small", text: "This one was for the team, not the customer." }) : null,
      acts);
  }

  async function render(main){
    let status = CHIPS.some(([k]) => k && k === param("status")) ? param("status") : "";
    let seq = 0;
    const sub = el("div", { class: "sub", text: "Emails Revivv sends to customers and the team. Tap one to read it." });
    main.append(el("div", { class: "o-title" }, el("div", {}, el("h1", { text: "Emails" }), sub)));
    const banner = el("div");
    const chips = el("div", { class: "chips", role: "group", "aria-label": "Which emails" });
    const count = el("p", { class: "dim small count" });
    const list = el("div", { class: "list" });
    for (const [key, label] of CHIPS){
      chips.append(el("button", { type: "button", class: key === status ? "on" : "", dataset: { key }, on: { click: e => {
        status = key;
        chips.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === e.currentTarget));
        history.replaceState(null, "", key ? `?status=${key}` : location.pathname);
        load();
      } } }, label));
    }
    main.append(banner, chips, count, list);

    async function load(){
      const my = ++seq;
      loading(list);
      count.textContent = "";
      let o;
      try {
        o = await rpc("outbox_list", status ? { status } : {});
      } catch (e) {
        if (my === seq) clear(list, el("div", { class: "alert bad", text: e.message }));
        return;
      }
      if (my !== seq) return;
      clear(banner, o.held
        ? el("div", { class: "alert", text: "No mailbox yet, so these emails were not sent. You can pass the important ones on by WhatsApp." })
        : null);
      const n = o.emails.length;
      count.textContent = n >= 300 ? "The newest 300 emails." : n === 1 ? "1 email." : `${n} emails.`;
      if (!n) { clear(list, empty(status ? `No ${STATUS[status].toLowerCase()} emails.` : "No emails yet.")); return; }
      clear(list, o.emails.map(e => emailItem(e, o.held, load)));
    }
    await load();
  }

  Office.start({ page: "outbox", title: "Emails", owner: true, render });
})();
