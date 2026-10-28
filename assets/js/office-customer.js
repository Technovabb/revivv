/* Back office: one customer (staff-customer.html?id=). Their details, cars,
   bookings and rewards. Owners also see spend and can adjust stamps or credit. */
(() => {
  const { el, clear, rpc, fmt, pill, act, empty, field, select, dialog, confirm, waLink, param, toast } = Office;

  const TZ = "America/Barbados";
  const PARISHES = ["St. Michael", "Christ Church", "St. James", "St. Thomas", "St. George", "St. Philip",
    "St. Peter", "St. Lucy", "St. Andrew", "St. Joseph", "St. John"];
  const FIRST_BOOKINGS = 8;

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const tel = phone => `tel:${String(phone).replace(/[^\d+]/g, "")}`;
  const since = ts => ts ? new Date(ts).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: TZ }) : "";

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

  // One "label: value" line. An empty value shows a dash.
  function kv(label, value){
    const v = value == null || value === "" ? el("span", { class: "dim", text: "—" })
      : value instanceof Node ? value : el("span", { text: String(value) });
    return el("div", {}, el("span", { text: label }), v);
  }
  const kpi = (value, label, cls) => el("div", { class: "kpi" + (cls ? ` ${cls}` : "") }, el("b", { text: value }), el("span", { text: label }));

  /* ---------- dialogs ---------- */
  async function editDetails(c){
    const name = el("input", { required: true, maxlength: 100, value: c.name || "", autocomplete: "off" });
    const phone = el("input", { type: "tel", maxlength: 40, value: c.phone || "", autocomplete: "off" });
    const email = el("input", { type: "email", value: c.email || "", autocomplete: "off" });
    const address = el("input", { maxlength: 300, value: c.address || "", autocomplete: "off" });
    const parish = parishSelect(c.parish);
    const notes = el("textarea", { maxlength: 2000 });
    notes.value = c.notes || "";
    const reminders = el("input", { type: "checkbox", checked: c.reminders !== false });
    return formDialog("Edit details", [
      field("Name", name),
      el("div", { class: "grid2" }, field("Phone", phone), field("Email", email)),
      field("Address", address, "For mobile jobs."),
      field("Parish", parish),
      field("Staff notes", notes, "Only staff see these."),
      el("label", { class: "check" }, reminders, "Send 'time for your next detail' emails")
    ], "Save", () => rpc("staff_customer_save", {
      id: c.id, name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(),
      address: address.value.trim(), parish: parish.value, notes: notes.value.trim(), reminders: reminders.checked
    }));
  }

  async function editCar(c, v, types){
    const type = select(types, v ? v.type : types[0]);
    const desc = el("input", { required: true, maxlength: 120, value: v ? v.description || "" : "", placeholder: "e.g. Toyota Corolla", autocomplete: "off" });
    const colour = el("input", { maxlength: 40, value: v ? v.colour || "" : "", autocomplete: "off" });
    const plate = el("input", { maxlength: 20, value: v ? v.plate || "" : "", autocomplete: "off", style: "text-transform:uppercase" });
    const notes = el("input", { maxlength: 300, value: v ? v.notes || "" : "", placeholder: "e.g. scratch on back door", autocomplete: "off" });
    return formDialog(v ? "Edit car" : "Add a car", [
      field("Type", type),
      field("Make and model", desc),
      el("div", { class: "grid2" }, field("Colour", colour), field("Plate", plate)),
      field("Notes", notes)
    ], v ? "Save" : "Add car", () => rpc("staff_vehicle_save", {
      customer_id: c.id, id: v ? v.id : undefined, type: type.value, description: desc.value.trim(),
      colour: colour.value.trim(), plate: plate.value.trim().toUpperCase(), notes: notes.value.trim()
    }));
  }

  async function adjustRewards(c){
    const stamps = el("input", { type: "number", min: 0, max: 6, step: 1, inputmode: "numeric", required: true, value: String(c.stamps) });
    const way = select([["add", "Add credit"], ["take", "Take credit off"]], "add");
    const amount = el("input", { type: "number", min: 0, step: "0.01", inputmode: "decimal", placeholder: "0" });
    const reason = el("input", { required: true, maxlength: 200, placeholder: "e.g. Stamp missed on 12 Oct", autocomplete: "off" });
    const tell = el("input", { type: "checkbox", checked: true });
    return formDialog("Adjust stamps or credit", [
      el("p", { class: "muted small", text: `Now: ${c.stamps}/6 stamps and ${fmt.money(c.credit)} credit.` }),
      field("Stamps (0 to 6)", stamps),
      el("div", { class: "grid2" }, field("Credit", way), field("Amount ($)", amount, "Leave empty for no change.")),
      field("Reason", reason, "Saved in the activity log."),
      el("label", { class: "check" }, tell, "Tell the customer (a note in their messages)")
    ], "Save", () => {
      const n = Number(stamps.value);
      const amt = Number(amount.value || 0);
      if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error("Stamps must be 0 to 6.");
      if (!(amt >= 0)) throw new Error("Type the amount without a minus sign. Pick 'Take credit off' instead.");
      if (n === c.stamps && !amt) throw new Error("Change the stamps or the credit first.");
      return rpc("owner_adjust", {
        customer_id: c.id, stamps: n, credit_change: amt ? (way.value === "take" ? -amt : amt) : null,
        reason: reason.value.trim(), tell: tell.checked
      });
    });
  }

  /* ---------- the page ---------- */
  function bookingRow(b, s){
    const slot = (s.slots || []).find(x => x.id === b.slot);
    const done = b.status === "completed";
    return el("a", { class: "item cu-row", href: `staff-booking.html?ref=${encodeURIComponent(b.ref)}` },
      el("div", { class: "item-top" },
        el("div", { class: "left" },
          el("div", { class: "slot-tag", text: `${fmt.date(b.date)} · ${slot ? slot.label : b.slotText}` }),
          el("h3", { text: b.package }),
          el("div", { class: "meta", text: [b.vehicle, b.ref].filter(Boolean).join(" · ") })),
        el("div", { class: "right" },
          pill(b.status),
          el("span", { class: "money", text: fmt.money(b.total) }),
          done && b.owing > 0 ? el("span", { class: "pill owing", text: `Owes ${fmt.money(b.owing)}` }) : null,
          done && b.owing <= 0 ? el("span", { class: "pill paid", text: "Paid" }) : null)));
  }

  async function render(main, me, s){
    const id = param("id");
    if (!/^\d+$/.test(id || "")) {
      main.append(el("div", { class: "alert", text: "No customer was picked." }), el("a", { class: "btn", href: "staff-customers.html" }, "See all customers"));
      return;
    }
    let c;
    try {
      c = await rpc("staff_customer", { id: Number(id) });
    } catch (e) {
      if (e.status !== 404) throw e;
      clear(main, el("div", { class: "alert", text: e.message }), el("a", { class: "btn", href: "staff-customers.html" }, "See all customers"));
      return;
    }
    const reload = async () => {
      const y = window.scrollY;
      try { await render(main, me, s); window.scrollTo(0, y); }
      catch (e) { toast(e.message, true); }
    };
    document.title = `${c.name} — Revivv Staff`;
    const types = (s.packages && s.packages[0] && Object.keys(s.packages[0].prices)) || ["Car", "SUV", "Truck"];
    const wa = waLink(c.phone);
    clear(main);

    /* header */
    main.append(
      el("a", { class: "back", href: "staff-customers.html" }, "← All customers"),
      el("div", { class: "o-title cu-title" },
        el("div", {},
          el("h1", {}, c.name, el("span", { class: "pill soft", text: c.tier })),
          el("div", { class: "sub", text: [c.since ? `Customer since ${since(c.since)}` : null,
            c.hasAccount ? "Has an online account" : "No online account"].filter(Boolean).join(" · ") }))),
      el("div", { class: "acts cu-acts" },
        el("a", { class: "btn btn-primary", href: `staff-new.html?customer=${c.id}` }, "New booking"),
        el("a", { class: "btn", href: `staff-messages.html?c=${c.id}` }, "Message"),
        c.phone ? el("a", { class: "btn", href: tel(c.phone) }, "Call") : null,
        wa ? el("a", { class: "btn", href: wa, target: "_blank", rel: "noopener" }, "WhatsApp") : null));

    const kpis = el("div", { class: "kpis" },
      kpi(`${c.stamps}/6`, "stamps"),
      kpi(String(c.visits), `${c.visits === 1 ? "visit" : "visits"} in the last year (${c.tier})`),
      kpi(fmt.money(c.credit), "credit"),
      kpi(fmt.money(c.owing), "owed on finished jobs", c.owing > 0 ? "warn" : ""));
    if (me.owner) kpis.append(kpi(fmt.money(c.spend), "spent with Revivv"));
    main.append(kpis);

    /* details */
    const details = el("div", { class: "card" },
      el("h2", { text: "Details" }),
      el("div", { class: "kv" },
        kv("Phone", c.phone ? el("a", { href: tel(c.phone), text: c.phone }) : null),
        kv("Email", c.email ? el("a", { href: `mailto:${c.email}`, text: c.email }) : null),
        kv("Address", c.address),
        kv("Parish", c.parish),
        kv("Reminders", c.reminders === false ? "Off: no 'next detail' emails" : "On: gets 'next detail' emails"),
        kv("Online account", c.hasAccount ? "Yes" : "No"),
        kv("Staff notes", c.notes ? el("span", { class: "cu-notes", text: c.notes }) : null)),
      el("div", { class: "acts" }, el("button", { class: "btn", type: "button", on: { click: async () => {
        if (await editDetails(c)) { toast("Saved."); reload(); }
      } } }, "Edit details")));

    /* bookings */
    const blist = el("div", { class: "list" });
    const drawBookings = all => {
      const shown = all ? c.bookings : c.bookings.slice(0, FIRST_BOOKINGS);
      clear(blist, shown.length ? shown.map(b => bookingRow(b, s)) : empty("No bookings yet."));
      if (shown.length < c.bookings.length) {
        blist.append(el("button", { class: "btn btn-ghost btn-block", type: "button", on: { click: () => drawBookings(true) } },
          `Show all ${c.bookings.length} bookings`));
      }
    };
    drawBookings(false);
    const bookingsCard = el("div", { class: "card" },
      el("h2", {}, "Bookings", el("small", { text: `${plural(c.details, "detail")} done` })), blist);

    /* cars */
    const cars = el("div", { class: "list" });
    if (!c.vehicles.length) cars.append(empty("No cars yet."));
    for (const v of c.vehicles) {
      cars.append(el("div", { class: "item cu-row" },
        el("div", { class: "item-top" },
          el("div", { class: "left" },
            el("h3", { text: v.description || v.type }),
            el("div", { class: "meta", text: [v.type, v.colour, v.plate].filter(Boolean).join(" · ") }),
            v.notes ? el("div", { class: "meta", text: v.notes }) : null),
          el("div", { class: "right" }, el("span", { class: "meta", text: plural(v.details || 0, "detail") }))),
        el("div", { class: "acts" },
          el("button", { class: "btn", type: "button", on: { click: async () => {
            if (await editCar(c, v, types)) { toast("Car saved."); reload(); }
          } } }, "Edit"),
          el("button", { class: "btn btn-danger", type: "button", on: { click: async e => {
            const btn = e.currentTarget;
            if (!await confirm("Remove this car?", `${v.description || v.type} comes off ${c.name}'s list. Past bookings keep it.`, "Remove", true)) return;
            await act(btn, () => rpc("staff_vehicle_archive", { id: v.id }), "Car removed.").catch(() => null);
            reload();
          } } }, "Remove"))));
    }
    const carsCard = el("div", { class: "card" },
      el("h2", { text: "Cars" }), cars,
      el("div", { class: "acts" }, el("button", { class: "btn", type: "button", on: { click: async () => {
        if (await editCar(c, null, types)) { toast("Car added."); reload(); }
      } } }, "+ Add a car")));

    /* rewards and referrals */
    const referred = c.referred.length
      ? el("ul", { class: "cu-ref" }, c.referred.map(r => el("li", {},
          el("a", { href: `staff-customer.html?id=${r.id}`, text: r.name }),
          el("span", { class: r.paidAt ? "pill paid" : "pill soft", text: r.paidAt ? "Credit paid" : "Waiting for first detail" }))))
      : el("p", { class: "dim small", style: "margin:.2rem 0 0", text: "No one yet." });
    const rewardsCard = el("div", { class: "card" },
      el("h2", { text: "Rewards" }),
      el("div", { class: "kv" },
        kv("Stamps", `${c.stamps} of 6`),
        kv("Credit", fmt.money(c.credit)),
        kv("Tier", `${c.tier} (${plural(c.visits, "visit")} in the last year)`),
        kv("Referral code", c.referralCode),
        kv("Referred by", c.referredBy ? el("a", { href: `staff-customer.html?id=${c.referredBy.id}`, text: c.referredBy.name }) : null)),
      el("div", { class: "cu-sub", text: "People they referred" }),
      referred,
      me.owner ? el("div", { class: "acts" }, el("button", { class: "btn", type: "button", on: { click: async () => {
        if (await adjustRewards(c)) { toast("Rewards updated."); reload(); }
      } } }, "Adjust stamps or credit")) : null);

    main.append(el("div", { class: "cols" },
      el("div", {}, details, bookingsCard),
      el("div", {}, carsCard, rewardsCard)));
  }

  Office.start({ page: "customers", title: "Customer", render });
})();
