/* Back office: Money (staff-money.html, owners only). Payments taken between two
   dates with totals by method, CSV downloads for the accountant, and gift vouchers. */
(() => {
  const { el, clear, rpc, fmt, act, dialog, confirm, field, select, toast, empty, loading, param, METHODS, api } = Office;
  const TZ = "America/Barbados";

  /* ---------- dates ---------- */
  const dayOf = ts => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  const weekday = iso => new Date(iso + "T12:00:00Z").getUTCDay();
  const monthStart = (iso, back = 0) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1 - back, 1)).toISOString().slice(0, 10);
  const isISO = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const PRESETS = [
    ["today", "Today", t => ({ from: t, to: t })],
    ["week", "This week", t => ({ from: fmt.addDays(t, -((weekday(t) + 6) % 7)), to: t })],
    ["month", "This month", t => ({ from: monthStart(t), to: t })],
    ["last", "Last month", t => ({ from: monthStart(t, 1), to: fmt.addDays(monthStart(t), -1) })]
  ];
  const rangeText = ({ from, to }) => from === to ? fmt.date(from, { plain: true }) : `${fmt.date(from, { plain: true })} to ${fmt.date(to, { plain: true })}`;
  const r2 = n => Math.round(n * 100) / 100;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

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

  /* ---------- copy to the clipboard ---------- */
  async function copy(text){
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const host = document.querySelector("dialog[open]") || document.body;
      const t = el("textarea", { class: "offscreen", readonly: true });
      t.value = text;
      host.append(t); t.select();
      try { document.execCommand("copy"); } catch { /* nothing more to try */ }
      t.remove();
    }
    toast("Copied");
  }

  /* ---------- payments ---------- */
  const td = (label, content, cls) => el("td", { "data-l": label, class: cls || null }, content);

  function paymentsTable(list){
    if (!list.length) return empty("No payments in these dates.");
    const body = el("tbody");
    for (const p of list){
      const how = p.method === "voucher" && p.voucher ? `Voucher ${p.voucher}` : (p.methodLabel || METHODS[p.method] || p.method);
      body.append(el("tr", {},
        td("When", fmt.when(p.created_at)),
        td("Booking", el("a", { href: `staff-booking.html?ref=${encodeURIComponent(p.ref)}`, text: p.ref })),
        td("Customer", p.name || "—"),
        td("How", how),
        td("Amount", el("b", { class: p.amount < 0 ? "neg num" : "num", text: p.amount < 0 ? `${fmt.money(p.amount)} refund` : fmt.money(p.amount) }), "r"),
        td("Note", p.note || "—"),
        td("Taken by", p.taken_by || "—")));
    }
    const head = el("tr", {}, ["When", "Booking", "Customer", "How", "Amount", "Note", "Taken by"].map(h => el("th", { class: h === "Amount" ? "r" : null, text: h })));
    return el("div", { class: "tbl-wrap" }, el("table", { class: "tbl" }, el("thead", {}, head), body));
  }

  // Totals for the dates: money taken = payments (less refunds) + vouchers sold; vouchers spent are not new money.
  function totals(payments, vouchers, range){
    const by = {};
    let net = 0, refunds = 0, spent = 0, spentN = 0;
    for (const p of payments){
      if (p.method === "voucher") { spent += p.amount; spentN++; continue; }
      const m = by[p.method] || (by[p.method] = { total: 0, n: 0 });
      m.total += p.amount; m.n++;
      net += p.amount;
      if (p.amount < 0) refunds += p.amount;
    }
    const sold = vouchers.filter(v => !v.voided && v.createdAt && dayOf(v.createdAt) >= range.from && dayOf(v.createdAt) <= range.to);
    const soldTotal = sold.reduce((s, v) => s + v.amount, 0);
    const kpi = (value, label, cls) => el("div", { class: "kpi" + (cls ? " " + cls : "") }, el("b", { text: value }), el("span", { text: label }));
    const box = el("div", { class: "kpis" }, kpi(fmt.money(r2(net + soldTotal)), "money taken"));
    for (const m of Object.keys(METHODS)){
      if (m === "voucher" || !by[m]) continue;
      box.append(kpi(fmt.money(r2(by[m].total)), `${METHODS[m]} · ${plural(by[m].n, "payment")}`));
    }
    for (const m of Object.keys(by)) if (!METHODS[m]) box.append(kpi(fmt.money(r2(by[m].total)), `${m} · ${plural(by[m].n, "payment")}`));
    if (refunds < 0) box.append(kpi(fmt.money(r2(refunds)), "refunds (taken off)", "bad"));
    box.append(kpi(fmt.money(r2(soldTotal)), `gift vouchers sold · ${sold.length}`));
    if (spentN) box.append(kpi(fmt.money(r2(spent)), "paid with vouchers (not new money)"));
    return [box, el("p", { class: "note", text: "Money taken = payments plus gift vouchers sold, minus refunds. Refunds show with a minus sign. When someone pays with a voucher, that money came in when the voucher was sold, so it is not counted again." })];
  }

  /* ---------- vouchers ---------- */
  function voucherState(v){
    if (v.voided) return ["Void", "st-cancelled"];
    if (v.expired) return ["Expired", "st-no_show"];
    if (v.balance <= 0) return ["Used up", "soft"];
    return ["Can be used", "st-completed"];
  }

  function vouchersTable(list, reload){
    if (!list.length) return empty("No vouchers here.");
    const body = el("tbody");
    for (const v of list){
      const [state, cls] = voucherState(v);
      const voidBtn = !v.voided ? el("button", { class: "btn btn-danger", type: "button", on: { click: async e => {
        const btn = e.currentTarget;
        const left = v.balance > 0 && !v.expired ? ` The ${fmt.money(v.balance)} left on it can't be used.` : "";
        if (!await confirm("Void this voucher?", `${v.code} will stop working.${left} This can't be undone.`, "Void it", true)) return;
        await act(btn, () => rpc("voucher_void", { id: v.id }), "Voucher voided").then(reload, () => {});
      } } }, "Void") : null;
      body.append(el("tr", {},
        td("Code", el("div", {}, el("span", { class: "code", text: v.code }), v.note ? el("div", { class: "dim small", text: v.note }) : null)),
        td("For", v.recipient || "—"),
        td("Bought by", v.buyer || "—"),
        td("Paid by", METHODS[v.paidMethod] || v.paidMethod || "—"),
        td("Value", el("span", { class: "num", text: fmt.money(v.amount) }), "r"),
        td("Left", el("b", { class: "num", text: fmt.money(v.balance) }), "r"),
        td("Expires", v.expiresOn ? fmt.date(v.expiresOn, { plain: true }) : "Never"),
        td("Status", el("span", { class: `pill ${cls}`, text: state })),
        td("", voidBtn, "r")));
    }
    const head = el("tr", {}, ["Code", "For", "Bought by", "Paid by", "Value", "Left", "Expires", "Status", ""].map(h =>
      el("th", { class: h === "Value" || h === "Left" ? "r" : null, text: h })));
    return el("div", { class: "tbl-wrap" }, el("table", { class: "tbl" }, el("thead", {}, head), body));
  }

  async function sellVoucher(reload){
    const amount = el("input", { type: "number", inputmode: "decimal", min: "1", max: "10000", step: "0.01", required: true, placeholder: "e.g. 100" });
    const method = select(Object.entries(METHODS).filter(([k]) => k !== "voucher"), "cash");
    const buyer = el("input", { maxlength: 100, autocomplete: "off", placeholder: "Who paid" });
    const recipient = el("input", { maxlength: 100, autocomplete: "off", placeholder: "Who will use it" });
    const expires = el("input", { type: "date", min: fmt.todayISO() });
    const note = el("textarea", { maxlength: 300, rows: 2 });
    const msg = el("p", { class: "msg err", role: "alert" });
    const body = [
      field("Amount ($ BBD)", amount),
      field("Paid by", method),
      el("div", { class: "grid2" }, field("Bought by", buyer), field("Who it's for", recipient)),
      field("Expiry date", expires, "Leave empty if it never runs out."),
      field("Note", note, "Only staff see this."),
      msg
    ];
    for (;;){
      const v = await dialog("Sell a gift voucher", body, [{ label: "Sell voucher", class: "btn-primary", value: "sell" }]);
      if (v !== "sell") return;
      try {
        const out = await rpc("voucher_create", {
          amount: amount.value, paid_method: method.value, buyer: buyer.value.trim(), recipient: recipient.value.trim(),
          note: note.value.trim(), expires_on: expires.value || ""
        });
        reload();
        await dialog("Voucher sold", [
          el("p", { class: "muted", text: `A ${fmt.money(amount.value)} gift voucher${recipient.value.trim() ? ` for ${recipient.value.trim()}` : ""}. Give them this code:` }),
          el("p", { class: "vcode", text: out.code }),
          el("button", { class: "btn btn-block", type: "button", on: { click: () => copy(out.code) } }, "Copy code"),
          el("p", { class: "dim small", text: "They pay with it until the money on it runs out. You can find it again in the list." })
        ], [{ label: "Done", class: "btn-primary", value: "ok" }]);
        return;
      } catch (e) {
        msg.textContent = e.message;   // open the form again with what they typed
      }
    }
  }

  /* ---------- the page ---------- */
  async function render(main){
    const t = fmt.todayISO();
    let range = isISO(param("from")) && isISO(param("to")) && param("to") >= param("from")
      ? { from: param("from"), to: param("to") } : PRESETS[2][2](t);
    let vouchers = [], vFilter = "live", seq = 0;

    const sub = el("div", { class: "sub" });
    main.append(el("div", { class: "o-title" }, el("div", {}, el("h1", { text: "Money" }), sub)));
    main.append(rangeBar(range, r => { range = r; load(); }));
    const sums = el("div");
    const pays = el("div");
    const vBox = el("div");
    const count = el("small");

    const dl = (label, what) => el("button", { class: "btn", type: "button", on: { click: e =>
      act(e.currentTarget, () => api.download(`/export/${what}.csv?from=${range.from}&to=${range.to}`, `revivv-${what}-${range.from}-to-${range.to}.csv`), "Downloaded").catch(() => {})
    } }, label);

    main.append(sums,
      el("div", { class: "card" }, el("h2", { text: "Downloads for the accountant" }),
        el("p", { class: "muted small", text: "Spreadsheet files (CSV) for the dates above. Payments are by the day they were taken. Bookings are by the day of the detail." }),
        el("div", { class: "acts" }, dl("Download payments (CSV)", "payments"), dl("Download bookings (CSV)", "bookings"))),
      el("div", { class: "card" }, el("h2", {}, "Payments", count), pays));

    const vChips = el("div", { class: "chips", role: "group", "aria-label": "Which vouchers" });
    for (const [key, label] of [["live", "Can be used"], ["all", "All vouchers"]]){
      vChips.append(el("button", { type: "button", class: key === vFilter ? "on" : "", dataset: { key }, on: { click: e => {
        vFilter = key;
        vChips.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === e.currentTarget));
        drawVouchers();
      } } }, label));
    }
    main.append(el("div", { class: "card" },
      el("h2", { text: "Gift vouchers" }),
      el("div", { class: "acts acts-top" }, el("button", { class: "btn btn-primary", type: "button", on: { click: () => sellVoucher(load) } }, "Sell a voucher")),
      vChips, vBox));

    function drawVouchers(){
      const list = vFilter === "all" ? vouchers : vouchers.filter(v => !v.voided && !v.expired && v.balance > 0);
      clear(vBox, vouchersTable(list, load));
    }

    async function load(){
      const my = ++seq;
      sub.textContent = rangeText(range);
      history.replaceState(null, "", `?from=${range.from}&to=${range.to}`);
      loading(pays);
      try {
        const [p, v] = await Promise.all([rpc("payments_list", range), rpc("vouchers_list")]);
        if (my !== seq) return;
        vouchers = v;
        clear(sums, totals(p.payments, vouchers, range),
          p.payments.length >= 1000 ? el("div", { class: "alert", text: "Too many payments to add up here: these totals only count the newest 1,000. The Reports page has the full totals." }) : null);
        count.textContent = p.payments.length >= 1000 ? "the newest 1,000 (download for all)" : plural(p.payments.length, "payment");
        clear(pays, paymentsTable(p.payments));
        drawVouchers();
      } catch (e) {
        if (my !== seq) return;
        clear(sums);
        clear(pays, el("div", { class: "alert bad", text: e.message }));
      }
    }
    await load();
  }

  Office.start({ page: "money", title: "Money", owner: true, render });
})();
