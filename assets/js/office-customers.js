/* Back office: Customers (staff-customers.html). Search and filter the customer
   list, and add a new customer. Spend is shown to owners only. */
(() => {
  const { el, clear, rpc, fmt, empty, field, select, dialog, loading, param } = Office;

  const FILTERS = [["", "All"], ["upcoming", "Coming up"], ["due", "Due a detail"], ["owing", "Owe money"], ["top", "Best customers"]];
  const HINTS = {
    upcoming: "Customers with a booking coming up.",
    due: "No detail for a while, and nothing booked.",
    owing: "Money still owed on finished jobs.",
    top: "Customers who have spent the most."
  };
  const EMPTY = {
    "": "No customers yet.",
    upcoming: "No one has a booking coming up.",
    due: "No one is due a detail right now.",
    owing: "Nobody owes money.",
    top: "No payments taken yet."
  };
  const PARISHES = ["St. Michael", "Christ Church", "St. James", "St. Thomas", "St. George", "St. Philip",
    "St. Peter", "St. Lucy", "St. Andrew", "St. Joseph", "St. John"];

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function parishSelect(value){
    const list = !value || PARISHES.includes(value) ? PARISHES : [value, ...PARISHES];
    return select([["", "Not given"], ...list], value || "");
  }

  /* A dialog with a form. If saving fails, it opens again with the typing kept
     and the problem shown. Resolves with what save() returned, or null. */
  async function formDialog(title, body, okLabel, save){
    const msg = el("p", { class: "msg err", role: "alert" });
    for (;;){
      const v = await dialog(title, [body, msg], [{ label: okLabel, class: "btn-primary", value: "ok" }]);
      if (v !== "ok") return null;
      try { return await save(); }
      catch (e) { msg.textContent = e.message; }
    }
  }

  async function addCustomer(){
    const name = el("input", { required: true, maxlength: 100, autocomplete: "off" });
    const phone = el("input", { type: "tel", maxlength: 40, autocomplete: "off" });
    const email = el("input", { type: "email", autocomplete: "off" });
    const address = el("input", { maxlength: 300, autocomplete: "off" });
    const parish = parishSelect("");
    const notes = el("textarea", { maxlength: 2000 });
    const out = await formDialog("Add a customer", [
      field("Name", name),
      el("div", { class: "grid2" }, field("Phone", phone), field("Email", email)),
      el("p", { class: "dim small", style: "margin:-.4rem 0 .8rem", text: "Add a phone number, an email, or both." }),
      field("Address", address, "For mobile jobs."),
      field("Parish", parish),
      field("Staff notes", notes, "Only staff see these.")
    ], "Add customer", () => rpc("staff_customer_save", {
      name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(),
      address: address.value.trim(), parish: parish.value, notes: notes.value.trim()
    }));
    if (out && out.id) location.href = `staff-customer.html?id=${out.id}`;
  }

  function row(c, me, s){
    const slot = c.nextSlot ? (s.slots || []).find(x => x.id === c.nextSlot) : null;
    return el("a", { class: "item cu-row", href: `staff-customer.html?id=${c.id}` },
      el("div", { class: "item-top" },
        el("div", { class: "left" },
          el("h3", { text: c.name }),
          el("div", { class: "meta", text: c.phone || c.email || "No phone or email" }),
          el("div", { class: "meta", text: `${plural(c.visits, "visit")} in the last year · ${c.lastVisit ? `last ${fmt.date(c.lastVisit)}` : "no details yet"}` }),
          c.nextDate ? el("div", { class: "meta cu-next", text: `Next: ${fmt.date(c.nextDate)}${slot ? `, ${slot.label}` : ""}` }) : null),
        el("div", { class: "right" },
          el("span", { class: "pill soft", text: c.tier }),
          el("span", { class: "meta", text: `${c.stamps}/6 stamps` }),
          me.owner ? el("span", { class: "money", title: "Spent with Revivv", text: fmt.money(c.spend) }) : null,
          c.owing > 0 ? el("span", { class: "pill owing", text: `Owes ${fmt.money(c.owing)}` }) : null)));
  }

  async function render(main, me, s){
    const state = {
      q: param("q") || "",
      filter: FILTERS.some(([k]) => k && k === param("filter")) ? param("filter") : ""
    };

    const search = el("input", { type: "search", value: state.q, placeholder: "Name, phone, email, car or plate",
      "aria-label": "Search customers", autocomplete: "off", enterkeyhint: "search" });
    const chips = el("div", { class: "chips", role: "group", "aria-label": "Show" });
    const hint = el("p", { class: "cu-count" });
    const list = el("div", { class: "list", "aria-live": "polite" });

    main.append(
      el("div", { class: "o-title" },
        el("div", {}, el("h1", { text: "Customers" }), el("div", { class: "sub", text: "Tap a customer to see their cars, bookings and rewards." })),
        el("button", { class: "btn btn-primary", type: "button", on: { click: addCustomer } }, "+ Add customer")),
      el("form", { class: "search", role: "search", on: { submit: e => { e.preventDefault(); search.blur(); } } }, search),
      chips, hint, list);

    function drawChips(){
      clear(chips, FILTERS.map(([key, label]) => el("button", {
        type: "button", class: state.filter === key ? "on" : "", "aria-pressed": String(state.filter === key),
        on: { click: () => { if (state.filter === key) return; state.filter = key; drawChips(); loading(list); load(); } }
      }, label)));
    }

    let seq = 0;
    async function load(){
      const n = ++seq;
      const qs = new URLSearchParams();
      if (state.q) qs.set("q", state.q);
      if (state.filter) qs.set("filter", state.filter);
      history.replaceState(null, "", location.pathname + (qs.toString() ? `?${qs}` : ""));
      let rows;
      try {
        rows = await rpc("staff_customers", { q: state.q, filter: state.filter || undefined });
      } catch (e) {
        if (n === seq) { hint.textContent = ""; clear(list, el("div", { class: "alert bad", text: e.message })); }
        return;
      }
      if (n !== seq) return;   // a newer search has started
      const bits = [plural(rows.length, "customer")];
      if (rows.length >= 300) bits.push("showing the first 300, search to find more");
      if (HINTS[state.filter]) bits.push(HINTS[state.filter]);
      hint.textContent = bits.join(" · ");
      clear(list, rows.length ? rows.map(c => row(c, me, s))
        : empty(state.q ? `No customers match "${state.q}".` : EMPTY[state.filter]));
    }

    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = search.value.trim();
        if (q === state.q) return;
        state.q = q;
        load();
      }, 300);
    });

    drawChips();
    loading(list);
    await load();
  }

  Office.start({ page: "customers", title: "Customers", render });
})();
