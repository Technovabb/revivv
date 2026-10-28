/* Back office: New booking (staff-new.html). For bookings taken by phone,
   WhatsApp, Instagram or at the door. Pick a customer we already have (or
   type a new one), a day and time, the car, the package and add-ons, and
   where. The server works out rewards, discount and credit when it saves.
   ?customer=<id> starts with that customer picked (also ?date= ?slot= ?source=). */
(() => {
  const { el, clear, rpc, fmt, field, select, toast, param, SOURCES } = Office;

  const MOBILE = "Mobile — we come to them", DROP = "Drop off — customer comes to us";
  const PARISHES = ["St. Michael", "Christ Church", "St. James", "St. Thomas", "St. George", "St. Philip", "St. Peter", "St. Lucy", "St. Andrew", "St. Joseph", "St. John"];
  const TYPES = ["Car", "SUV", "Truck"];
  const OPEN = ["requested", "confirmed", "on_the_way", "in_progress"];
  const TIER_OFF = { Gold: 0.10, Silver: 0.05 };   // the same as the server's rules
  const REWARD_AT = 5, REWARD_OFF = 0.5;
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

  function dayText(iso){
    const plain = fmt.date(iso, { plain: true }), near = fmt.date(iso);
    return near === plain ? plain : `${near}, ${plain}`;
  }
  function closedOn(day, info){
    const c = (info.closedDays || []).find(x => x.day === day);
    if (c) return { reason: c.reason || "" };
    const wd = new Date(day + "T00:00:00Z").getUTCDay();
    if ((info.closedWeekdays || []).includes(wd)) return wd === 0 ? { sunday: true } : { reason: "" };
    return null;
  }
  function closedText(c){
    if (!c) return "";
    if (c.sunday) return "Sunday is by appointment only. You can still book it.";
    return `Revivv is closed that day${c.reason ? ` (${c.reason})` : ""}. You can still book it.`;
  }
  // The slots already used that day. slots_taken shows every slot as taken on a
  // closed day, so on those days look at the day's real jobs instead.
  async function takenOn(day, info){
    const closed = closedOn(day, info);
    if (closed && !closed.sunday){
      const jobs = await rpc("staff_day", { d: day });
      return { closed, taken: new Set(jobs.filter(j => j.status !== "cancelled" && j.status !== "no_show").map(j => j.slot)) };
    }
    return { closed, taken: new Set(await rpc("slots_taken", { d: day })) };
  }

  // Tick boxes for the add-ons; the per-row one (seat shampoo) gets a 1–4 rows picker.
  function addonPicker(addons, onChange){
    const rows = addons.map(a => {
      const box = el("input", { type: "checkbox" });
      box.addEventListener("change", onChange);
      const label = el("label", { class: "check" }, box, el("span", { text: `${a.name} +${fmt.money(a.price)}${a.perRow ? " a row" : ""}` }));
      if (!a.perRow) return { a, box, node: label };
      const rowsSel = select([1, 2, 3, 4].map(n => [String(n), n === 1 ? "1 row" : `${n} rows`]), "1");
      rowsSel.setAttribute("aria-label", "Seat rows");
      rowsSel.addEventListener("change", () => { box.checked = true; onChange(); });
      return { a, box, rowsSel, node: el("div", { class: "nb-addon" }, label, rowsSel) };
    });
    const picked = () => rows.filter(r => r.box.checked).map(r => ({ a: r.a, n: r.a.perRow ? Number(r.rowsSel.value) : 1 }));
    return {
      node: el("div", {}, rows.map(r => r.node)),
      value: () => picked().map(({ a, n }) => (a.perRow ? `${a.name} ×${n}` : a.name)).join(", "),
      lines: () => picked().map(({ a, n }) => ({ label: a.perRow ? `${a.name} ×${n}` : a.name, amount: a.price * n }))
    };
  }

  async function render(main, me, info){
    const today = fmt.todayISO();
    const maxDay = fmt.addDays(today, info.bookAheadDays || 366);
    const st = { customer: null, taken: new Set(), closed: null, wantSlot: param("slot") };
    const currentPkg = () => (info.packages || []).find(p => p.name === pkg.value);

    main.append(el("div", { class: "o-title" },
      el("div", {}, el("h1", { text: "New booking" }), el("div", { class: "sub", text: "For phone, WhatsApp, Instagram and walk-in bookings." }))));

    /* ---------- the customer ---------- */
    const picked = el("div", { class: "nb-picked hide" });
    const search = el("input", { type: "search", placeholder: "Name, phone, email or car", autocomplete: "off", enterkeyhint: "search" });
    const results = el("div", { class: "nb-results" });
    const findBox = el("div", {}, field("Find a customer we have", search), results, el("p", { class: "nb-or", text: "Or type in a new customer" }));
    const name = el("input", { required: true, maxlength: 100, autocomplete: "off" });
    const phone = el("input", { type: "tel", maxlength: 40, autocomplete: "off" });
    const email = el("input", { type: "email", maxlength: 254, autocomplete: "off", placeholder: "Optional" });
    const pickedHint = el("p", { class: "dim small hide", style: "margin:-.3rem 0 .8rem", text: "Changes to the name, phone or email here are for this booking only." });
    const match = el("div", {});

    let findTimer, findToken = 0;
    async function find(){
      const q = search.value.trim(), mine = ++findToken;
      if (q.length < 2){ clear(results); return; }
      let rows;
      try { rows = await rpc("staff_customers", { q }); }
      catch (e) { if (mine === findToken) clear(results, el("p", { class: "msg err", text: e.message })); return; }
      if (mine !== findToken) return;
      if (!rows.length){ clear(results, el("p", { class: "dim small", text: "No one found. Type them in below as a new customer." })); return; }
      clear(results, rows.slice(0, 8).map(c => el("button", { type: "button", class: "item", on: { click: () => pick(c.id) } },
        el("b", { text: c.name }),
        el("span", { class: "meta", text: [c.phone, c.email].filter(Boolean).join(" · ") || "No phone or email" }),
        el("span", { class: "meta dim", text: [c.tier, `${c.stamps} of 6 stamps`, c.credit > 0 ? `${fmt.money(c.credit)} credit` : "", c.nextDate ? `booked ${fmt.date(c.nextDate)}` : ""].filter(Boolean).join(" · ") }))));
      if (rows.length > 8) results.append(el("p", { class: "dim small", text: `${rows.length - 8} more. Type more of the name to narrow it down.` }));
    }
    search.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(find, 300); });
    search.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); clearTimeout(findTimer); find(); } });

    async function pick(id){
      let c;
      try { c = await rpc("staff_customer", { id }); }
      catch (e) { toast(e.message, true); return; }
      st.customer = c;
      name.value = c.name || "";
      phone.value = c.phone || "";
      email.value = c.email || "";
      if (!address.value && c.address) address.value = c.address;
      if (!parish.value && c.parish) parish.value = c.parish;
      search.value = "";
      clear(results);
      clear(match);
      drawPicked();
      drawCars();
      emailChanged();
      slotNote();
      update();
    }
    function unpick(){
      st.customer = null;
      name.value = phone.value = email.value = "";
      drawPicked();
      drawCars();
      emailChanged();
      slotNote();
      update();
      search.focus();
    }
    function drawPicked(){
      const c = st.customer;
      picked.classList.toggle("hide", !c);
      findBox.classList.toggle("hide", !!c);
      pickedHint.classList.toggle("hide", !c);
      if (!c){ clear(picked); return; }
      clear(picked,
        el("div", { style: "min-width:0" },
          el("h3", { text: c.name }),
          el("div", { class: "meta", text: [c.phone, c.email].filter(Boolean).join(" · ") || "No phone or email" }),
          el("div", { class: "meta", text: [c.tier, `${c.stamps} of 6 stamps`, `${fmt.money(c.credit)} credit`].join(" · ") }),
          c.nextDate ? el("div", { class: "meta", text: `Already booked: ${dayText(c.nextDate)}` }) : null,
          el("a", { class: "small", href: `staff-customer.html?id=${c.id}`, text: "Open their page" })),
        el("button", { type: "button", class: "btn", on: { click: unpick } }, "Change"));
    }
    // A new customer whose phone or email we already have: offer to use that customer.
    async function lookup(q, what){
      if (st.customer || !q) return;
      let rows = [];
      try { rows = await rpc("staff_customers", { q }); } catch { return; }
      if (st.customer) return;
      if (!rows.length){ clear(match); return; }
      const some = rows.slice(0, 3);
      clear(match, el("div", { class: "alert" },
        some.length === 1 ? `${some[0].name} already has this ${what}.` : `These customers already have this ${what}:`,
        el("div", { class: "acts" }, some.map(c => el("button", { type: "button", class: "btn", on: { click: () => pick(c.id) } }, `Use ${c.name}`)))));
    }
    phone.addEventListener("change", () => { if (phone.value.replace(/\D/g, "").length >= 7) lookup(phone.value.trim(), "phone number"); });
    email.addEventListener("change", () => { if (email.value.includes("@")) lookup(email.value.trim(), "email"); });

    /* ---------- when ---------- */
    const startDay = isDate(param("date")) && param("date") >= today ? param("date") : fmt.addDays(today, 1);
    const date = el("input", { type: "date", required: true, min: today, max: maxDay, value: startDay });
    const dayHint = el("span", { class: "dim small" });
    const slot = el("select", { required: true });
    const dayWarn = el("p", { class: "nb-warn", role: "status" });
    const slotWarn = el("p", { class: "nb-warn", role: "status" });

    let dayToken = 0;
    async function refreshDay(){
      const day = date.value, mine = ++dayToken;
      st.taken = new Set();
      st.closed = null;
      dayHint.textContent = isDate(day) ? dayText(day) : "";
      dayWarn.textContent = "";
      if (!isDate(day)){ drawSlots(); return; }
      if (day < today){ dayWarn.textContent = "That date has passed. Pick another."; drawSlots(); return; }
      try {
        const t = await takenOn(day, info);
        if (mine !== dayToken) return;
        st.taken = t.taken;
        st.closed = t.closed;
        dayWarn.textContent = closedText(t.closed);
      } catch (e) {
        if (mine === dayToken) dayWarn.textContent = `Couldn't check the free times: ${e.message}`;
      }
      if (mine === dayToken) drawSlots();
    }
    function drawSlots(){
      const p = currentPkg();
      const keep = slot.value || st.wantSlot;
      clear(slot, el("option", { value: "", text: "Pick a time" }));
      for (const s of info.slots || []){
        const taken = st.taken.has(s.id), short = !!(p && p.long && !s.long);
        let label = `${s.label} (${s.time})`;
        if (taken) label += " — taken";
        else if (short) label += " — too short for this package";
        else if (s.goldOnly) label += " — Gold members";
        slot.append(el("option", { value: s.id, text: label, disabled: taken || short }));
      }
      const ok = [...slot.options].find(o => o.value && o.value === keep && !o.disabled);
      slot.value = ok ? keep : "";
      st.wantSlot = null;
      slotNote();
    }
    const isGold = () => !!(st.customer && st.customer.tier === "Gold");
    function slotNote(){
      const s = (info.slots || []).find(x => x.id === slot.value);
      const free = [...slot.options].some(o => o.value && !o.disabled);
      let t = "";
      if (isDate(date.value) && !free) t = "There's no free time that day for this package. Pick another date.";
      else if (s && s.goldOnly && !(isGold() && useRewards.checked)){
        if (me.owner) t = "This is the Gold members' slot. As an owner you can still give it out.";
        else if (isGold()) t = "Tick \"Use their rewards and credit\" to give this Gold member the priority slot.";
        else t = "This slot is for Gold members only. Pick another time.";
      }
      slotWarn.textContent = t;
    }
    date.addEventListener("change", refreshDay);
    slot.addEventListener("change", slotNote);

    /* ---------- the car and the job ---------- */
    const car = el("select");
    const carRow = el("div", { class: "hide" }, field("Their saved cars", car));
    const vtype = select([["", "Pick one"], ...TYPES.map(t => [t, t])], "");
    vtype.required = true;
    const vdesc = el("input", { maxlength: 120, placeholder: "e.g. Grey Toyota Corolla" });
    const pkg = el("select", { required: true });
    const pkgHint = el("p", { class: "dim small", style: "margin:-.4rem 0 .8rem" });
    const addons = addonPicker(info.addons || [], () => update());

    const savedCar = () => (st.customer && st.customer.vehicles || []).find(v => String(v.id) === car.value) || null;
    function drawCars(){
      const cars = (st.customer && st.customer.vehicles) || [];
      carRow.classList.toggle("hide", !cars.length);
      clear(car, el("option", { value: "", text: "A different car" }),
        cars.map(v => el("option", { value: String(v.id), text: [v.type, v.description, v.colour, v.plate].filter(Boolean).join(" · ") })));
      car.value = cars.length ? String(cars[0].id) : "";
      useCar();
    }
    function useCar(){
      const v = savedCar();
      if (v){ vtype.value = v.type; vdesc.value = v.description || ""; }
      drawPackages();
      update();
    }
    // Typing a different car un-picks the saved one.
    function carEdited(){
      const v = savedCar();
      if (v && (vtype.value !== v.type || vdesc.value.trim() !== (v.description || ""))) car.value = "";
    }
    car.addEventListener("change", useCar);
    vtype.addEventListener("change", () => { carEdited(); drawPackages(); update(); });
    vdesc.addEventListener("input", carEdited);

    function drawPackages(){
      const keep = pkg.value, t = vtype.value;
      clear(pkg, el("option", { value: "", text: "Pick a package" }), (info.packages || []).map(p => el("option", {
        value: p.name,
        text: `${p.name} — ${t ? fmt.money(p.prices[t]) : "from " + fmt.money(Math.min(...Object.values(p.prices)))}`
      })));
      pkg.value = keep;
    }
    pkg.addEventListener("change", () => {
      const p = currentPkg();
      pkgHint.textContent = p && p.long ? "This one takes longer, so it needs the morning or afternoon slot." : "";
      drawSlots();
      update();
    });

    /* ---------- where ---------- */
    const where = select([["", "Pick one"], [MOBILE, "Mobile (we go to them)"], [DROP, "Drop-off (they come to us)"]], "");
    where.required = true;
    const address = el("input", { maxlength: 300, placeholder: "Street, or landmark and workplace" });
    const parish = select([["", "Pick a parish"], ...PARISHES.map(p => [p, p])], "");
    const addrBox = el("div", { class: "hide" }, field("Address for the mobile job", address));
    where.addEventListener("change", () => {
      const m = where.value === MOBILE;
      addrBox.classList.toggle("hide", !m);
      address.required = m;
    });

    /* ---------- notes ---------- */
    const notes = el("textarea", { maxlength: 1000, placeholder: "e.g. gate code, dog in the yard" });
    const staffNotes = el("textarea", { maxlength: 2000 });

    /* ---------- the booking itself ---------- */
    const source = select(Object.entries(SOURCES).filter(([k]) => k !== "website"), SOURCES[param("source")] && param("source") !== "website" ? param("source") : "phone");
    const status = select([["confirmed", "Confirmed"], ["requested", "Requested (not confirmed yet)"]], "confirmed");
    const notify = el("input", { type: "checkbox", checked: true });
    const notifyRow = el("label", { class: "check" }, notify, el("span", { text: "Email the customer about this booking" }));
    const noEmail = el("p", { class: "dim small", text: "No email, so nothing is sent to the customer." });
    const useRewards = el("input", { type: "checkbox", checked: true });
    const rewardsRow = el("label", { class: "check" }, useRewards, el("span", { text: "Use their rewards and credit" }));
    useRewards.addEventListener("change", () => { slotNote(); update(); });
    const hasEmail = () => !!(email.value.trim() || (st.customer && st.customer.email));
    function emailChanged(){
      notifyRow.classList.toggle("hide", !hasEmail());
      noEmail.classList.toggle("hide", hasEmail());
    }
    email.addEventListener("input", emailChanged);

    let price = null, why = null;
    if (me.owner){
      price = el("input", { type: "number", inputmode: "decimal", min: "0", step: "0.01", placeholder: "Leave empty to work it out" });
      why = el("input", { maxlength: 200, placeholder: "e.g. two cars, family deal" });
      price.addEventListener("input", () => { why.required = price.value !== ""; update(); });
    }

    /* ---------- the price ---------- */
    const priceBox = el("div", { class: "nb-price", "aria-live": "polite" });
    function update(){
      const p = currentPkg(), t = vtype.value;
      clear(priceBox);
      if (!p || !t){ priceBox.append(el("p", { class: "dim small", text: "Pick the vehicle type and the package to see the price." })); return; }
      const line = (label, amount, cls) => el("div", { class: cls || "" }, el("span", { text: label }), el("span", { text: fmt.money(amount) }));
      const base = p.prices[t];
      let total = base;
      priceBox.append(line(`${p.name} (${t})`, base));
      for (const a of addons.lines()){ priceBox.append(line(a.label, a.amount)); total += a.amount; }
      const c = st.customer;
      if (c && useRewards.checked){
        const rewardInUse = (c.bookings || []).some(b => b.rewardApplied && OPEN.includes(b.status));
        if (c.stamps >= REWARD_AT && !rewardInUse){
          total -= base * REWARD_OFF;
          priceBox.append(line("6th detail: half price", -base * REWARD_OFF, "off"));
        } else if (TIER_OFF[c.tier]){
          total -= base * TIER_OFF[c.tier];
          priceBox.append(line(`${c.tier}: ${Math.round(TIER_OFF[c.tier] * 100)}% off the package`, -base * TIER_OFF[c.tier], "off"));
        }
        if (c.credit > 0 && total > 0){
          const used = Math.min(c.credit, total);
          total -= used;
          priceBox.append(line("Credit", -used, "off"));
        }
      }
      total = Math.max(0, Math.round(total));
      const byHand = price && price.value !== "" && Number.isFinite(Number(price.value)) ? Number(price.value) : null;
      if (byHand != null){
        priceBox.append(line("Worked out", total), line("Price by hand", byHand, "total"));
      } else {
        priceBox.append(line("Total", total, "total"));
      }
      priceBox.append(el("p", { class: "dim small", style: "margin-top:.3rem", text: c
        ? (useRewards.checked ? "Rewards and credit are checked again when you save." : "Their rewards and credit won't be used.")
        : "A new customer has no rewards yet. If the email is one we have, that customer's rewards are used." }));
    }

    /* ---------- saving ---------- */
    const msg = el("p", { class: "msg err", role: "alert" });
    const saveBtn = el("button", { class: "btn btn-primary btn-block", type: "submit" }, "Save booking");

    function problem(){
      if (!name.value.trim()) return ["Type the customer's name.", name];
      if (phone.value.replace(/\D/g, "").length < 7 && !hasEmail()) return ["Add a phone number (7 digits or more) or an email.", phone];
      if (!isDate(date.value)) return ["Pick a date.", date];
      if (date.value < today) return ["That date has passed. Pick another.", date];
      if (!slot.value) return ["Pick a time.", slot];
      if (!vtype.value) return ["Pick the vehicle type.", vtype];
      if (!pkg.value) return ["Pick a package.", pkg];
      if (!where.value) return ["Pick mobile or drop-off.", where];
      if (where.value === MOBILE && !address.value.trim()) return ["Add the address for the mobile job.", address];
      const s = (info.slots || []).find(x => x.id === slot.value);
      if (s && s.goldOnly && !me.owner && !(isGold() && useRewards.checked)) return ["The priority slot is for Gold members. Pick another time.", slot];
      if (price && price.value !== "" && !why.value.trim()) return ["Add a short reason for the price.", why];
      return null;
    }

    async function save(e){
      e.preventDefault();
      msg.textContent = "";
      const bad = problem();
      if (bad){ msg.textContent = bad[0]; toast(bad[0], true); bad[1].focus(); return; }
      const v = savedCar();
      const body = {
        customer_id: st.customer ? st.customer.id : undefined,
        name: name.value.trim(), phone: phone.value.trim() || undefined, email: email.value.trim() || undefined,
        date: date.value, slot: slot.value,
        vehicle_type: vtype.value, vehicle_desc: vdesc.value.trim() || undefined, vehicle_id: v ? v.id : undefined,
        package: pkg.value, addons: addons.value() || undefined,
        location: where.value, address: where.value === MOBILE ? address.value.trim() : undefined, parish: parish.value || undefined,
        notes: notes.value.trim() || undefined, staff_notes: staffNotes.value.trim() || undefined,
        source: source.value, status: status.value,
        notify: hasEmail() && notify.checked, use_rewards: useRewards.checked
      };
      if (price && price.value !== ""){ body.total = Number(price.value); body.price_note = why.value.trim(); }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const out = await rpc("staff_create_booking", body);
        toast(`Booked. Ref ${out.ref}`);
        location.href = `staff-booking.html?ref=${encodeURIComponent(out.ref)}`;
      } catch (err) {
        msg.textContent = err.message;
        toast(err.message, true);
        if (/slot|time/i.test(err.message)) refreshDay();
        saveBtn.disabled = false;
        saveBtn.textContent = "Save booking";
      }
    }

    const owner = me.owner ? [el("hr", { style: "border:none;border-top:1px solid var(--line);margin:.6rem 0 .9rem" }),
      el("p", { class: "muted small", style: "margin-bottom:.6rem", text: "Owners only: set the price yourself." }),
      el("div", { class: "grid2" }, field("Price by hand ($)", price), field("Reason for the price", why))] : null;

    main.append(el("form", { class: "nb-form", on: { submit: save } },
      el("div", { class: "card" }, el("h2", { text: "Customer" }),
        picked, findBox,
        el("div", { class: "grid2" }, field("Name", name), field("Phone", phone)),
        field("Email", email), pickedHint, match),
      el("div", { class: "card" }, el("h2", { text: "When" }),
        el("div", { class: "grid2" },
          el("div", { class: "field" }, el("label", { text: "Date" }), date, dayHint),
          field("Time", slot)),
        dayWarn, slotWarn),
      el("div", { class: "card" }, el("h2", { text: "The car and the job" }),
        carRow,
        el("div", { class: "grid2" }, field("Vehicle type", vtype), field("Make and model", vdesc)),
        field("Package", pkg), pkgHint,
        el("div", { class: "field" }, el("span", { class: "lbl", text: "Add-ons" }), addons.node)),
      el("div", { class: "card" }, el("h2", { text: "Where" }),
        el("div", { class: "grid2" }, field("Mobile or drop-off", where), field("Parish", parish)),
        addrBox),
      el("div", { class: "card" }, el("h2", { text: "Notes" }),
        field("Notes for the job", notes, "The customer can see these."),
        field("Staff notes", staffNotes, "Only staff see these.")),
      el("div", { class: "card" }, el("h2", { text: "Booking" }),
        el("div", { class: "grid2" }, field("How they booked", source), field("Status", status)),
        notifyRow, noEmail, rewardsRow, owner),
      el("div", { class: "card" }, el("h2", { text: "Price" }), priceBox),
      msg, saveBtn));

    drawPackages();
    emailChanged();
    update();
    refreshDay();
    const preset = Number(param("customer"));
    if (Number.isInteger(preset) && preset > 0) pick(preset);
  }

  Office.start({ page: "new", title: "New booking", render });
})();
