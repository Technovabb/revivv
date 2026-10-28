/* Back office: Today (staff.html). Today's jobs with one-tap steps, bookings
   waiting to be confirmed, the week ahead, and (owners) money. */
(() => {
  const { el, clear, rpc, fmt, pill, act, empty, waLink } = Office;

  // The next step a job can take from where it is, as buttons.
  const NEXT = {
    requested: [["confirm", "Confirm", "btn-primary"]],
    confirmed: [["on_the_way", "On the way", ""], ["start", "Start", ""], ["complete", "Done", "btn-ok"]],
    on_the_way: [["start", "Start", ""], ["complete", "Done", "btn-ok"]],
    in_progress: [["complete", "Done", "btn-ok"]]
  };

  function jobCard(j, reload, { showDate = false } = {}){
    const buttons = (NEXT[j.status] || [])
      .filter(([a]) => a !== "on_the_way" || (j.location || "").startsWith("Mobile"))
      .map(([action, label, cls]) => el("button", { class: `btn btn-sm ${cls}`, on: { click: async e => {
        await act(e.currentTarget, () => rpc("staff_act", { ref: j.ref, action }), `${j.name}: ${label.toLowerCase()}`);
        reload();
      } } }, label));
    const wa = waLink(j.phone);
    return el("div", { class: "item" },
      el("div", { class: "item-top" },
        el("div", {},
          el("div", { class: "slot-tag", text: showDate ? `${j.dateText} · ${j.slotText}` : j.slotText }),
          el("h3", {}, el("a", { href: `staff-booking.html?ref=${j.ref}`, style: "color:inherit;text-decoration:none" }, j.name)),
          el("div", { class: "meta", text: `${j.package} · ${j.vehicle}` }),
          j.addons ? el("div", { class: "meta", text: `+ ${j.addons}` }) : null,
          el("div", { class: "meta", text: (j.location || "").startsWith("Mobile") ? `Mobile: ${[j.address, j.parish].filter(Boolean).join(", ")}` : "Drop-off" }),
          j.notes ? el("div", { class: "note", text: j.notes }) : null),
        el("div", { class: "right" }, pill(j.status), el("div", { class: "money", style: "margin-top:.4rem", text: fmt.money(j.total) }),
          j.status === "completed" && j.owing > 0 ? el("div", { class: "pill owing", style: "margin-top:.3rem", text: `Owes ${fmt.money(j.owing)}` }) : null)),
      el("div", { class: "acts" }, buttons,
        el("a", { class: "btn btn-sm btn-ghost", href: `staff-booking.html?ref=${j.ref}` }, "Open"),
        j.phone ? el("a", { class: "btn btn-sm btn-ghost", href: `tel:${j.phone}` }, "Call") : null,
        wa ? el("a", { class: "btn btn-sm btn-ghost", href: wa, target: "_blank", rel: "noopener" }, "WhatsApp") : null));
  }

  async function render(main, me){
    const o = await rpc("staff_overview");
    const reload = () => render(main, me);
    clear(main);
    main.append(el("div", { class: "o-title" },
      el("div", {}, el("h1", { text: "Today" }), el("div", { class: "sub", text: `${o.todayText} · ${o.jobs.filter(j => j.status !== "cancelled" && j.status !== "no_show").length} jobs` })),
      el("a", { class: "btn btn-primary", href: "staff-new.html" }, "+ New booking")));

    if (o.closed) main.append(el("div", { class: "alert", text: `Today is marked closed${o.closed.reason ? `: ${o.closed.reason}` : ""}.` }));
    if (o.unconfirmedTomorrow) {
      main.append(el("div", { class: "alert" }, `${o.unconfirmedTomorrow} booking${o.unconfirmedTomorrow > 1 ? "s" : ""} tomorrow ${o.unconfirmedTomorrow > 1 ? "are" : "is"} not confirmed yet. `,
        el("a", { href: `staff-bookings.html?status=requested&from=${fmt.addDays(o.today, 1)}&to=${fmt.addDays(o.today, 1)}`, text: "See them" })));
    }
    if (me.owner && o.heldEmails) {
      main.append(el("div", { class: "alert" }, `${o.heldEmails} email${o.heldEmails > 1 ? "s are" : " is"} waiting (no mailbox yet). `,
        el("a", { href: "staff-outbox.html", text: "Read them" })));
    }

    const kpis = el("div", { class: "kpis" },
      el("a", { class: "kpi" + (o.waiting.length ? " warn" : ""), href: "staff-bookings.html?status=requested" }, el("b", { text: String(o.waiting.length) }), el("span", { text: "waiting to confirm" })),
      el("a", { class: "kpi" + (o.unreadThreads ? " warn" : ""), href: "staff-messages.html" }, el("b", { text: String(o.unreadThreads) }), el("span", { text: "unread conversations" })));
    if (o.money) {
      kpis.append(
        el("a", { class: "kpi", href: "staff-money.html" }, el("b", { text: fmt.money(o.money.today) }), el("span", { text: "taken today" })),
        el("a", { class: "kpi", href: "staff-money.html" }, el("b", { text: fmt.money(o.money.week) }), el("span", { text: "this week" })),
        el("a", { class: "kpi", href: "staff-reports.html" }, el("b", { text: fmt.money(o.money.month) }), el("span", { text: "this month" })),
        el("a", { class: "kpi" + (o.money.owing > 0 ? " warn" : ""), href: "staff-bookings.html?owing=1" }, el("b", { text: fmt.money(o.money.owing) }), el("span", { text: "owed on finished jobs" })));
    }
    main.append(kpis);

    // the next 7 days
    const counts = Object.fromEntries(o.week.map(d => [d.day, d.n]));
    const week = el("div", { class: "week" });
    for (let i = 0; i < 7; i++) {
      const d = fmt.addDays(o.today, i);
      const dt = new Date(d + "T12:00:00Z");
      week.append(el("a", { href: `staff-bookings.html?from=${d}&to=${d}`, class: i === 0 ? "today" : "" },
        el("span", { text: dt.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }) }),
        el("b", { text: String(dt.getUTCDate()) }),
        el("em", { text: counts[d] ? `${counts[d]} job${counts[d] > 1 ? "s" : ""}` : "—" })));
    }
    main.append(el("div", { class: "card" }, el("h2", {}, "The week ahead", el("small", { text: "tap a day" })), week));

    const jobs = el("div", { class: "list" });
    if (!o.jobs.length) jobs.append(empty("No jobs today."));
    o.jobs.forEach(j => jobs.append(jobCard(j, reload)));
    main.append(el("div", { class: "card" }, el("h2", { text: "Today's jobs" }), jobs));

    if (o.waiting.length) {
      const list = el("div", { class: "list" });
      o.waiting.forEach(j => list.append(jobCard(j, reload, { showDate: true })));
      main.append(el("div", { class: "card" }, el("h2", {}, "Waiting to confirm", el("small", { text: "newest bookings from the website" })), list));
    }
  }

  window.OfficeToday = { jobCard, NEXT };
  Office.start({ page: "today", title: "Today", render });
})();
