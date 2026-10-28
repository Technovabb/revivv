/* Back office: Reports (staff-reports.html, owners only). Money taken, jobs,
   customers and busy times for a range of dates, with CSV downloads. */
(() => {
  const { el, clear, rpc, fmt, act, field, empty, loading, param, SOURCES, api } = Office;

  /* ---------- dates ---------- */
  const monthStart = (iso, back = 0) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1 - back, 1)).toISOString().slice(0, 10);
  const weekday = iso => new Date(iso + "T12:00:00Z").getUTCDay();
  const isISO = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const PRESETS = [
    ["month", "This month", t => ({ from: monthStart(t), to: t })],
    ["last", "Last month", t => ({ from: monthStart(t, 1), to: fmt.addDays(monthStart(t), -1) })],
    ["three", "Last 3 months", t => ({ from: monthStart(t, 2), to: t })],
    ["year", "This year", t => ({ from: t.slice(0, 4) + "-01-01", to: t })]
  ];
  const short = iso => fmt.date(iso, { plain: true });
  const rangeText = ({ from, to }) => from === to ? short(from) : `${short(from)} to ${short(to)}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const SLOT_ORDER = ["priority", "morning", "afternoon", "late"];
  const SLOT_NAMES = { priority: "Priority slot", morning: "Morning", afternoon: "Afternoon", late: "Late afternoon" };

  /* Preset chips plus "Pick dates" (two date inputs). Calls pick({ from, to }) */
  function rangeBar(start, pick){
    const t = fmt.todayISO();
    const chips = el("div", { class: "chips", role: "group", "aria-label": "Dates" });
    const fromI = el("input", { type: "date", value: start.from }), toI = el("input", { type: "date", value: start.to });
    const msg = el("p", { class: "msg err", role: "alert" });
    const custom = el("div", { class: "range-custom hide" },
      el("div", { class: "grid2" }, field("From", fromI), field("To", toI)), msg,
      el("button", { class: "btn btn-primary", type: "button", on: { click: () => {
        msg.textContent = "";
        if (!isISO(fromI.value) || !isISO(toI.value)) { msg.textContent = "Pick both dates."; return; }
        if (toI.value < fromI.value) { msg.textContent = "The end date is before the start date."; return; }
        if (toI.value > fmt.addDays(fromI.value, 366)) { msg.textContent = "Pick a year or less."; return; }
        pick({ from: fromI.value, to: toI.value });
      } } }, "Show these dates"));
    const buttons = [];
    const on = key => buttons.forEach(b => b.classList.toggle("on", b.dataset.key === key));
    for (const [key, label, fn] of PRESETS){
      buttons.push(el("button", { type: "button", dataset: { key }, on: { click: () => {
        const r = fn(t);
        fromI.value = r.from; toI.value = r.to;
        on(key); custom.classList.add("hide"); pick(r);
      } } }, label));
    }
    buttons.push(el("button", { type: "button", dataset: { key: "custom" }, on: { click: () => {
      on("custom"); custom.classList.remove("hide"); fromI.focus();
    } } }, "Pick dates"));
    chips.append(...buttons);
    const match = PRESETS.find(([, , fn]) => { const r = fn(t); return r.from === start.from && r.to === start.to; });
    on(match ? match[0] : "custom");
    if (!match) custom.classList.remove("hide");
    return el("div", { class: "card" }, chips, custom);
  }

  /* ---------- pieces ---------- */
  const kpi = (value, label, cls) => el("div", { class: "kpi" + (cls ? " " + cls : "") }, el("b", { text: value }), el("span", { text: label }));

  // A list of bars. rows: [{ label, n (sets the length), text }]
  function bars(rows, none){
    if (!rows.length) return empty(none);
    const max = Math.max(0, ...rows.map(r => r.n));
    return el("div", { class: "bars" }, rows.map(r => {
      const w = max > 0 && r.n > 0 ? Math.max(1, Math.round(r.n / max * 100)) : 0;
      return el("div", { class: "bar" }, el("span", { text: r.label }), el("i", { style: `width:${w}%`, "aria-hidden": "true" }), el("span", { text: r.text }));
    }));
  }
  const barCard = (title, hint, body) => el("div", { class: "card" }, el("h2", {}, title, hint ? el("small", { text: hint }) : null), body);

  // Money taken per day as columns; longer ranges are grouped by week (from Monday).
  function chart(byDay){
    const weekly = byDay.length > 62;
    let pts = byDay.map(d => ({ day: d.day, taken: d.taken, jobs: d.jobs, label: short(d.day) }));
    if (weekly){
      const weeks = [];
      for (const d of pts){
        const monday = fmt.addDays(d.day, -((weekday(d.day) + 6) % 7));
        const w = weeks[weeks.length - 1];
        if (w && w.key === monday) { w.taken += d.taken; w.jobs += d.jobs; }
        else weeks.push({ key: monday, day: d.day, taken: d.taken, jobs: d.jobs, label: `Week of ${short(d.day)}` });
      }
      pts = weeks.map(w => ({ ...w, taken: Math.round(w.taken * 100) / 100 }));
    }
    const max = Math.max(0, ...pts.map(p => p.taken));
    const best = pts.reduce((b, p) => (p.taken > (b ? b.taken : 0) ? p : b), null);
    const tip = p => `${p.label}: ${fmt.money(p.taken)} taken, ${plural(p.jobs, "detail")} done`;
    const caption = el("p", { class: "chart-cap", role: "status", text: max > 0 ? "Tap a column to see that " + (weekly ? "week." : "day.") : "No money taken in these dates." });
    const cols = el("div", { class: "cols-chart", role: "img",
      "aria-label": best ? `Money taken per ${weekly ? "week" : "day"}. Best: ${tip(best)}.` : "No money taken in these dates." });
    let picked = null;
    for (const p of pts){
      const h = max > 0 && p.taken > 0 ? Math.max(2, Math.round(p.taken / max * 100)) : 0;
      const col = el("i", { class: h ? null : "zero", style: h ? `height:${h}%` : null, title: tip(p) });
      col.addEventListener("click", () => {
        if (picked) picked.classList.remove("picked");
        picked = col; col.classList.add("picked");
        caption.textContent = tip(p);
      });
      cols.append(col);
    }
    const first = pts[0], last = pts[pts.length - 1];
    return el("div", { class: "card" },
      el("h2", {}, `Money taken per ${weekly ? "week" : "day"}`, max > 0 ? el("small", { text: `Best: ${fmt.money(max)}` }) : null),
      cols,
      first ? el("div", { class: "chart-axis" }, el("span", { text: short(first.day) }), el("span", { text: short(last.day) })) : null,
      caption);
  }

  const td = (label, content, cls) => el("td", { "data-l": label, class: cls || null }, content);
  function table(heads, rows){
    return el("div", { class: "tbl-wrap" }, el("table", { class: "tbl" },
      el("thead", {}, el("tr", {}, heads.map(([h, r]) => el("th", { class: r ? "r" : null, text: h })))),
      el("tbody", {}, rows)));
  }

  /* ---------- the page ---------- */
  async function render(main, me, site){
    const t = fmt.todayISO();
    let range = isISO(param("from")) && isISO(param("to")) && param("to") >= param("from")
      ? { from: param("from"), to: param("to") } : PRESETS[0][2](t);
    let seq = 0;
    const slotNames = { ...SLOT_NAMES };
    for (const s of (site && site.slots) || []) slotNames[s.id] = s.label;

    const sub = el("div", { class: "sub" });
    main.append(el("div", { class: "o-title" }, el("div", {}, el("h1", { text: "Reports" }), sub)));
    main.append(rangeBar(range, r => { range = r; load(); }));
    const box = el("div");
    main.append(box);

    const dl = (label, what) => el("button", { class: "btn", type: "button", on: { click: e =>
      act(e.currentTarget, () => api.download(`/export/${what}.csv?from=${range.from}&to=${range.to}`, `revivv-${what}-${range.from}-to-${range.to}.csv`), "Downloaded").catch(() => {})
    } }, label);
    main.append(el("div", { class: "card" }, el("h2", { text: "Downloads for the accountant" }),
      el("p", { class: "muted small", text: "Spreadsheet files (CSV) for the dates above." }),
      el("div", { class: "acts" }, dl("Download payments (CSV)", "payments"), dl("Download bookings (CSV)", "bookings"))));

    async function load(){
      const my = ++seq;
      sub.textContent = rangeText(range);
      history.replaceState(null, "", `?from=${range.from}&to=${range.to}`);
      loading(box);
      let r;
      try {
        r = await rpc("report", range);
      } catch (e) {
        if (my === seq) clear(box, el("div", { class: "alert bad", text: e.message }));
        return;
      }
      if (my !== seq) return;
      draw(r);
    }

    function draw(r){
      const st = r.statuses || {};
      const cust = r.customers || {};
      const out = [];

      out.push(el("p", { class: "note", text: "Money taken = payments plus gift vouchers sold, minus refunds. A voucher spent on a detail is not counted again." }));
      out.push(el("div", { class: "kpis" },
        kpi(fmt.money(r.taken), "money taken"),
        kpi(String(r.jobs), "details done"),
        kpi(fmt.money(r.averageJob), "average per detail"),
        kpi(String(cust.new || 0), "new customers"),
        kpi(String(cust.returning || 0), "returning customers"),
        kpi(String(st.no_show || 0), "no-shows", st.no_show ? "warn" : ""),
        kpi(String(st.cancelled || 0), "cancellations"),
        kpi(fmt.money(r.vouchersSold.total), `gift vouchers sold · ${r.vouchersSold.n}`)));

      out.push(chart(r.byDay || []));

      const pk = bars(r.byPackage.map(x => ({ label: x.package, n: x.n, text: `${x.n} · ${fmt.money(x.value)}` })), "No finished details in these dates.");
      const counts = Object.fromEntries(r.byWeekday.map(x => [x.dow, x.n]));
      const wd = r.byWeekday.length
        ? bars([1, 2, 3, 4, 5, 6, 0].map(d => ({ label: DAYS[d], n: counts[d] || 0, text: String(counts[d] || 0) })), "")
        : empty("No finished details in these dates.");
      out.push(el("div", { class: "cols even" },
        barCard("Details by package", "count · value", pk),
        barCard("Busiest days", "finished details", wd)));

      const slots = r.bySlot.slice().sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
        .map(x => ({ label: slotNames[x.slot] || x.slot, n: x.n, text: String(x.n) }));
      const src = r.bySource.map(x => ({ label: SOURCES[x.source] || x.source || "Not known", n: x.n, text: String(x.n) }));
      out.push(el("div", { class: "cols even" },
        barCard("Busiest time slots", "finished details", bars(slots, "No finished details in these dates.")),
        barCard("Where bookings came from", "not counting cancelled", bars(src, "No bookings in these dates."))));

      const ad = r.addons.map(x => ({ label: x.addon, n: x.n, text: String(x.n) }));
      const pay = r.byMethod.map(x => ({ label: x.label || x.method, n: x.total, text: `${fmt.money(x.total)} · ${x.n}` }));
      if (r.vouchersSold.n) pay.push({ label: "Gift vouchers sold", n: r.vouchersSold.total, text: `${fmt.money(r.vouchersSold.total)} · ${r.vouchersSold.n}` });
      out.push(el("div", { class: "cols even" },
        barCard("Popular add-ons", "on finished details", bars(ad, "No add-ons in these dates.")),
        barCard("How people paid", "amount · payments", bars(pay, "No payments in these dates."))));

      // top customers
      const top = r.top.map((c, i) => el("tr", {},
        td("#", String(i + 1)),
        td("Customer", el("a", { href: `staff-customer.html?id=${encodeURIComponent(c.id)}`, text: c.name || "—" })),
        td("Details", String(c.jobs), "r"),
        td("Spent", el("b", { class: "num", text: fmt.money(c.spend) }), "r")));
      out.push(el("div", { class: "card" }, el("h2", {}, "Top 10 customers", el("small", { text: "by money paid in these dates" })),
        top.length ? table([["#"], ["Customer"], ["Details", 1], ["Spent", 1]], top) : empty("No payments in these dates.")));

      // still owed
      const owedTotal = r.owing.reduce((s, x) => s + x.owing, 0);
      const owed = r.owing.map(x => el("tr", {},
        td("Booking", el("a", { href: `staff-booking.html?ref=${encodeURIComponent(x.ref)}`, text: x.ref })),
        td("Customer", x.name || "—"),
        td("Date", short(x.date)),
        td("Owed", el("b", { class: "num owed", text: fmt.money(x.owing) }), "r")));
      out.push(el("div", { class: "card" },
        el("h2", {}, "Still owed", el("small", { text: owed.length ? `${fmt.money(Math.round(owedTotal * 100) / 100)} on ${plural(owed.length, "finished job")} up to ${short(r.to)}` : `finished jobs up to ${short(r.to)}` })),
        owed.length ? table([["Booking"], ["Customer"], ["Date"], ["Owed", 1]], owed) : empty("Nothing owed. Every finished job is paid.")));

      clear(box, out);
    }

    await load();
  }

  Office.start({ page: "reports", title: "Reports", owner: true, render });
})();
