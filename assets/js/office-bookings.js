/* Back office: Bookings (staff-bookings.html). Every booking, grouped by day,
   with quick filters (upcoming, waiting, done, cancelled, owing, all), a date
   range and a search box. Other pages link here with filters in the address:
   ?status=requested  ?from=2026-10-29&to=2026-10-29  ?owing=1  ?q=kim */
(() => {
  const { el, clear, rpc, fmt, pill, empty, toast } = Office;

  const CHIPS = [
    { key: "upcoming", label: "Upcoming", status: "open" },
    { key: "waiting", label: "Waiting", status: "requested" },
    { key: "done", label: "Done", status: "completed" },
    { key: "cancelled", label: "Cancelled", status: "cancelled" },
    { key: "owing", label: "Owing", owing: true },
    { key: "all", label: "All", status: "" }
  ];
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

  // "Tomorrow, Thu 29 Oct" or just "Mon 2 Nov"
  function dayText(iso){
    const plain = fmt.date(iso, { plain: true }), near = fmt.date(iso);
    return near === plain ? plain : `${near}, ${plain}`;
  }

  // What the address asks for. No filters at all means upcoming bookings from today.
  function readQuery(){
    const q = new URLSearchParams(location.search);
    const f = {
      status: q.get("status") || "",
      from: isDate(q.get("from")) ? q.get("from") : "",
      to: isDate(q.get("to")) ? q.get("to") : "",
      q: (q.get("q") || "").trim(),
      owing: q.get("owing") === "1"
    };
    if (![...q.keys()].some(k => ["status", "from", "to", "q", "owing"].includes(k))) { f.status = "open"; f.from = fmt.todayISO(); }
    return f;
  }
  function writeQuery(f){
    const isDefault = f.status === "open" && f.from === fmt.todayISO() && !f.to && !f.q && !f.owing;
    const q = new URLSearchParams();
    if (!isDefault){
      if (f.status) q.set("status", f.status);
      if (f.from) q.set("from", f.from);
      if (f.to) q.set("to", f.to);
      if (f.owing) q.set("owing", "1");
      if (f.q) q.set("q", f.q);
    }
    const s = q.toString();
    history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
  }

  async function render(main, me, info){
    const f = readQuery();
    const slotIndex = id => { const i = (info.slots || []).findIndex(s => s.id === id); return i < 0 ? 99 : i; };
    const slotName = b => { const s = (info.slots || []).find(x => x.id === b.slot); return s ? `${s.label} · ${s.time}` : b.slotText; };

    const sub = el("div", { class: "sub" });
    main.append(el("div", { class: "o-title" },
      el("div", {}, el("h1", { text: "Bookings" }), sub),
      el("a", { class: "btn btn-primary", href: "staff-new.html" }, "+ New booking")));

    // filters
    const chips = el("div", { class: "chips", role: "group", "aria-label": "Show" });
    const search = el("input", { type: "search", placeholder: "Name, ref, phone, email or car", "aria-label": "Search bookings", value: f.q, enterkeyhint: "search" });
    const from = el("input", { type: "date", value: f.from });
    const to = el("input", { type: "date", value: f.to });
    const clearDates = el("button", { class: "link-btn bk-clear", type: "button", on: { click: () => { f.from = ""; f.to = ""; from.value = ""; to.value = ""; changed(); } } }, "Clear the dates");
    main.append(el("div", { class: "card" },
      chips,
      el("form", { class: "search", role: "search", on: { submit: e => { e.preventDefault(); clearTimeout(timer); f.q = search.value.trim(); changed(); } } }, search),
      el("div", { class: "bk-dates" }, Office.field("From", from), Office.field("To", to)),
      clearDates));

    const results = el("div", {});
    main.append(results);

    function drawChips(){
      clear(chips, CHIPS.map(c => {
        const on = c.owing ? f.owing : !f.owing && c.status === f.status;
        return el("button", { type: "button", class: on ? "on" : "", "aria-pressed": on ? "true" : "false", on: { click: () => pickChip(c) } }, c.label);
      }));
      clearDates.classList.toggle("hide", !f.from && !f.to);
    }
    function pickChip(c){
      f.owing = !!c.owing;
      f.status = c.owing ? "" : c.status;
      // Upcoming starts today; the others look at every date until a range is picked.
      f.from = c.key === "upcoming" ? fmt.todayISO() : "";
      f.to = "";
      from.value = f.from; to.value = f.to;
      changed();
    }

    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (search.value.trim() !== f.q) { f.q = search.value.trim(); changed(); } }, 300);
    });
    from.addEventListener("change", () => { f.from = from.value; changed(); });
    to.addEventListener("change", () => { f.to = to.value; changed(); });

    let ask = 0;
    async function changed(){
      drawChips();
      writeQuery(f);
      const mine = ++ask;
      Office.loading(results);
      let rows;
      try {
        rows = await rpc("staff_bookings", { from: f.from || undefined, to: f.to || undefined, status: f.status || undefined, q: f.q || undefined, owing: f.owing || undefined });
      } catch (e) {
        if (mine !== ask) return;
        clear(results, el("div", { class: "alert bad", text: e.message }));
        return;
      }
      if (mine !== ask) return;   // a newer search has started
      draw(rows);
    }

    function draw(rows){
      clear(results);
      const n = rows.length;
      sub.textContent = n === 1 ? "1 booking" : `${n}${n >= 300 ? "+" : ""} bookings`;
      if (!n){
        const what = f.q ? `No bookings match "${f.q}" here.` : "No bookings here.";
        const narrowed = f.status || f.owing || f.from || f.to;
        results.append(empty(what));
        if (narrowed) {
          results.append(el("div", { class: "acts" }, el("button", { class: "btn", type: "button", on: { click: () => {
            f.status = ""; f.owing = false; f.from = ""; f.to = ""; from.value = ""; to.value = ""; changed();
          } } }, f.q ? "Search every booking" : "Show every booking")));
        }
        return;
      }
      if (n >= 300) results.append(el("p", { class: "bk-count", text: "Showing the first 300. Search or pick dates to narrow it down." }));

      // Soonest first for what's coming up; newest first for the rest.
      const soonest = f.status === "open" || f.status === "requested" || (f.from && !f.to);
      rows.sort((a, b) => (soonest ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || slotIndex(a.slot) - slotIndex(b.slot));

      const days = new Map();
      for (const b of rows){
        if (!days.has(b.date)) days.set(b.date, []);
        days.get(b.date).push(b);
      }
      for (const [day, list] of days){
        results.append(el("h2", { class: "bk-day" }, dayText(day), el("small", { text: list.length === 1 ? "1 booking" : `${list.length} bookings` })));
        results.append(el("div", { class: "list" }, list.map(row)));
      }
    }

    function row(b){
      const mobile = (b.location || "").startsWith("Mobile");
      return el("a", { class: "item", href: `staff-booking.html?ref=${encodeURIComponent(b.ref)}` },
        el("div", { class: "item-top" },
          el("div", { style: "min-width:0" },
            el("div", { class: "slot-tag", text: slotName(b) }),
            el("h3", { text: b.name }),
            el("div", { class: "meta", text: `${b.package} · ${b.vehicle}` }),
            mobile ? el("div", { class: "meta dim", text: `Mobile${b.parish ? ": " + b.parish : ""}` }) : null),
          el("div", { class: "right" },
            pill(b.status),
            el("div", { class: "money", style: "margin-top:.4rem", text: fmt.money(b.total) }),
            b.status === "completed" && b.owing > 0 ? el("div", { class: "pill owing", style: "margin-top:.3rem", text: `Owes ${fmt.money(b.owing)}` }) : null)));
    }

    changed().catch(e => toast(e.message, true));
  }

  Office.start({ page: "bookings", title: "Bookings", render });
})();
