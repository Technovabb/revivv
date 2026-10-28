/* Back office: one booking (staff-booking.html?ref=RV-…). Its steps and the
   buttons for the next one, move / change / cancel, the customer, money and
   payments, the crew's job card (checklist, notes, who's doing it), photos and
   the timeline. Every change reloads the booking from the server. */
(() => {
  const { el, clear, rpc, post, fmt, pill, steps, act, dialog, confirm, ask, viewer, field, select, waLink, toast, empty, param, SOURCES, METHODS, api } = Office;

  const MOBILE = "Mobile — we come to them", DROP = "Drop off — customer comes to us";
  const PARISHES = ["St. Michael", "Christ Church", "St. James", "St. Thomas", "St. George", "St. Philip", "St. Peter", "St. Lucy", "St. Andrew", "St. Joseph", "St. John"];
  const TYPES = ["Car", "SUV", "Truck"];
  const OPEN = ["requested", "confirmed", "on_the_way", "in_progress"];
  const KINDS = { before: "Before", after: "After", damage: "Damage" };
  // The next steps from where a booking is: [action, button, style, message when done]
  const NEXT = {
    requested: [["confirm", "Confirm", "btn-primary", "Booking confirmed"]],
    confirmed: [["on_the_way", "On the way", "", "Marked on the way"], ["start", "Start", "", "Job started"], ["complete", "Done", "btn-ok", "Job done"]],
    on_the_way: [["start", "Start", "", "Job started"], ["complete", "Done", "btn-ok", "Job done"]],
    in_progress: [["complete", "Done", "btn-ok", "Job done"]]
  };
  const EVENTS = {
    created: "Booked", confirm: "Confirmed", on_the_way: "On the way", start: "Started", complete: "Done", cancel: "Cancelled",
    no_show: "No-show", moved: "Moved", edited: "Changed", assigned: "Job given", payment: "Payment", refund: "Refund", photo: "Photo added"
  };

  const drafts = {};                                              // notes typed but not saved yet survive a reload
  const checks = { list: null, queue: Promise.resolve(), pending: 0 };  // checklist ticks are saved one after another

  /* ---------- small helpers ---------- */
  const first = n => String(n || "").trim().split(/\s+/)[0];
  const telHref = p => "tel:" + String(p).replace(/[^\d+]/g, "");
  const kv = (k, ...v) => el("div", {}, el("span", { text: k }), el("span", {}, ...v));
  function dayText(iso){
    const plain = fmt.date(iso, { plain: true }), near = fmt.date(iso);
    return near === plain ? plain : `${near}, ${plain}`;
  }
  // Run an action from a button; true if it worked (act already showed any error).
  async function run(button, fn, done){
    try { await act(button, fn, done); return true; } catch { return false; }
  }
  // A dialog with a form that stays open, with what was typed, when saving fails.
  async function formDialog(title, body, okLabel, save, danger){
    for (;;){
      const v = await dialog(title, body, [{ label: okLabel, class: danger ? "btn-danger" : "btn-primary", value: "ok" }]);
      if (v !== "ok") return false;
      try { await save(); return true; } catch (e) { toast(e.message, true); }
    }
  }

  // "Ceramic spray sealant, Seat extraction shampoo ×2" → Map { name → rows or null }
  function parseAddons(s){
    const m = new Map();
    for (const raw of String(s || "").split(",")){
      const item = raw.trim();
      if (!item) continue;
      const x = item.match(/^(.+?)\s*[×x]\s*([1-4])$/);
      m.set(x ? x[1] : item, x ? Number(x[2]) : null);
    }
    return m;
  }
  const sameAddons = (a, b) => {
    const norm = s => [...parseAddons(s)].map(([n, r]) => (r ? `${n} ×${r}` : n)).sort().join(", ");
    return norm(a) === norm(b);
  };
  // Tick boxes for the add-ons; the per-row one (seat shampoo) gets a 1–4 rows picker.
  function addonPicker(addons, current){
    const chosen = parseAddons(current);
    const items = addons.map(a => ({ name: a.name, price: a.price, perRow: !!a.perRow }));
    for (const [n, r] of chosen) if (!items.some(a => a.name === n)) items.push({ name: n, price: null, perRow: r != null });
    const rows = items.map(a => {
      const box = el("input", { type: "checkbox", checked: chosen.has(a.name) });
      const label = el("label", { class: "check" }, box,
        el("span", { text: a.price == null ? `${a.name} (no longer sold)` : `${a.name} +${fmt.money(a.price)}${a.perRow ? " a row" : ""}` }));
      if (!a.perRow) return { a, box, node: label };
      const rowsSel = select([1, 2, 3, 4].map(n => [String(n), n === 1 ? "1 row" : `${n} rows`]), String(chosen.get(a.name) || 1));
      rowsSel.setAttribute("aria-label", "Seat rows");
      rowsSel.addEventListener("change", () => { box.checked = true; });
      return { a, box, rowsSel, node: el("div", { class: "bk-addon" }, label, rowsSel) };
    });
    return {
      node: el("div", {}, rows.map(r => r.node)),
      value: () => rows.filter(r => r.box.checked).map(r => (r.a.perRow ? `${r.a.name} ×${r.rowsSel.value}` : r.a.name)).join(", ")
    };
  }

  // Closed days: from the settings (info). Sunday is "by appointment".
  function closedOn(day, info){
    const c = (info.closedDays || []).find(x => x.day === day);
    if (c) return { reason: c.reason || "" };
    const wd = new Date(day + "T00:00:00Z").getUTCDay();
    if ((info.closedWeekdays || []).includes(wd)) return wd === 0 ? { sunday: true } : { reason: "" };
    return null;
  }
  function closedText(c){
    if (!c) return "";
    if (c.sunday) return "Sunday is by appointment only. Staff can still book it.";
    return `Revivv is closed that day${c.reason ? ` (${c.reason})` : ""}. Staff can still book it.`;
  }
  // The slots already used that day. slots_taken shows every slot as taken on a
  // closed day, so on those days look at the day's real jobs instead.
  async function takenOn(day, info, exceptRef){
    const closed = closedOn(day, info);
    if (closed && !closed.sunday){
      const jobs = await rpc("staff_day", { d: day });
      return { closed, taken: new Set(jobs.filter(j => j.ref !== exceptRef && j.status !== "cancelled" && j.status !== "no_show").map(j => j.slot)) };
    }
    return { closed, taken: new Set(await rpc("slots_taken", { d: day })) };
  }

  /* ---------- the page ---------- */
  async function render(main, me, info){
    const ref = (param("ref") || "").trim().toUpperCase();
    const back = () => el("a", { class: "back", href: "staff-bookings.html" }, "← Bookings");
    if (!ref){
      main.append(back(), el("div", { class: "alert", text: "No booking was picked. Go back to Bookings and tap one." }));
      return;
    }
    const pg = { main, me, info, ref };
    pg.reload = async () => {
      try { draw(pg, await rpc("staff_booking", { ref })); }
      catch (e) { toast(e.message, true); }
    };
    let d;
    try { d = await rpc("staff_booking", { ref }); }
    catch (e) { main.append(back(), el("div", { class: "alert bad", text: e.message })); return; }
    draw(pg, d);
  }

  function draw(pg, d){
    const y = window.scrollY;
    document.title = `${d.name} — Revivv Staff`;
    if (checks.pending === 0) checks.list = (d.checklist || []).map(x => ({ item: x.item, done: !!x.done }));
    clear(pg.main,
      el("a", { class: "back", href: "staff-bookings.html" }, "← Bookings"),
      el("div", { class: "o-title" },
        el("div", {},
          el("h1", { text: d.name }),
          el("div", { class: "sub", text: `${dayText(d.date)} · ${d.slotText}` }),
          el("div", { class: "bk-ref", text: `Ref ${d.ref}` })),
        pill(d.status)),
      steps(d.steps, d.status),
      d.status === "cancelled" ? el("div", { class: "alert bad", style: "margin-top:.8rem", text: `Cancelled${d.cancelReason ? ": " + d.cancelReason : "."}` }) : null,
      actionsCard(pg, d),
      el("div", { class: "bk-cols" },
        el("div", { class: "bk-col" }, detailsCard(d), jobCard(pg, d), photosCard(pg, d)),
        el("div", { class: "bk-col" }, customerCard(d), moneyCard(pg, d), timelineCard(d))));
    window.scrollTo(0, y);
  }

  /* ---------- steps and the big buttons ---------- */
  function actionsCard(pg, d){
    const next = (NEXT[d.status] || []).filter(([a]) => a !== "on_the_way" || d.mobile)
      .map(([action, label, cls, done]) => el("button", { class: `btn ${cls}`, type: "button", on: { click: async e => {
        if (await run(e.currentTarget, () => rpc("staff_act", { ref: pg.ref, action }), done)) pg.reload();
      } } }, label));
    const more = [];
    if (d.status === "requested" || d.status === "confirmed") more.push(el("button", { class: "btn", type: "button", on: { click: () => moveDialog(pg, d) } }, "Move"));
    if (d.status !== "cancelled" && d.status !== "no_show") more.push(el("button", { class: "btn", type: "button", on: { click: () => editDialog(pg, d) } }, "Change details"));
    if (["requested", "confirmed", "on_the_way"].includes(d.status)) more.push(el("button", { class: "btn", type: "button", on: { click: e => noShow(pg, d, e.currentTarget) } }, "No-show"));
    if (OPEN.includes(d.status)) more.push(el("button", { class: "btn btn-danger", type: "button", on: { click: e => cancel(pg, d, e.currentTarget) } }, "Cancel booking"));
    if (!next.length && !more.length) return null;
    return el("div", { class: "card", style: "margin-top:1rem" },
      next.length ? el("div", { class: "acts bk-acts" }, next) : null,
      more.length ? el("div", { class: "acts bk-acts" }, more) : null);
  }

  async function cancel(pg, d, button){
    const reason = await ask("Cancel this booking", "Why is it cancelled?", { okLabel: "Next", hint: "The customer will see this in their messages." });
    if (!reason) return;
    let notify = false;
    if (d.email){
      const v = await dialog("Email the customer?", el("p", { class: "muted", text: `Send an email to ${d.email} to say the booking is cancelled?` }),
        [{ label: "Yes, email them", class: "btn-primary", value: "yes" }, { label: "No email", value: "no" }]);
      if (!v) return;
      notify = v === "yes";
    }
    if (await run(button, () => rpc("staff_act", { ref: pg.ref, action: "cancel", reason, notify }), "Booking cancelled")) pg.reload();
  }

  async function noShow(pg, d, button){
    const credit = d.creditUsed > 0 ? ` The ${fmt.money(d.creditUsed)} credit they used goes back on their account.` : "";
    if (!(await confirm("Mark as a no-show?", `Use this when ${first(d.name)} didn't turn up. The slot is freed.${credit}`, "Yes, no-show", true))) return;
    if (await run(button, () => rpc("staff_act", { ref: pg.ref, action: "no_show" }), "Marked as a no-show")) pg.reload();
  }

  async function moveDialog(pg, d){
    const { info } = pg;
    const today = fmt.todayISO();
    const pkg = (info.packages || []).find(p => p.name === d.package);
    const date = el("input", { type: "date", required: true, min: today, value: d.date >= today ? d.date : today });
    const slot = el("select", { required: true });
    const note = el("p", { class: "muted small", role: "status" });
    const notify = el("input", { type: "checkbox", checked: true });
    let token = 0;
    async function fill(){
      const day = date.value, mine = ++token;
      note.textContent = "";
      clear(slot, el("option", { value: "", text: day ? "Checking…" : "Pick a date first" }));
      if (!day) return;
      let t;
      try { t = await takenOn(day, info, d.ref); }
      catch (e) { if (mine === token) note.textContent = e.message; return; }
      if (mine !== token) return;
      clear(slot, el("option", { value: "", text: "Pick a time" }));
      for (const s of info.slots || []){
        const now = day === d.date && s.id === d.slot;
        const taken = !now && t.taken.has(s.id);
        const short = !!(pkg && pkg.long && !s.long);
        let label = `${s.label} (${s.time})`;
        if (now) label += " — booked now";
        else if (taken) label += " — taken";
        else if (short) label += " — too short for this package";
        else if (s.goldOnly) label += " — Gold members";
        slot.append(el("option", { value: s.id, text: label, disabled: now || taken || short }));
      }
      const free = [...slot.options].some(o => o.value && !o.disabled);
      note.textContent = [closedText(t.closed), free ? "" : "There's no free time that day. Pick another date."].filter(Boolean).join(" ");
    }
    date.addEventListener("change", fill);
    fill();
    const body = [
      el("p", { class: "muted small", text: `Now: ${dayText(d.date)}, ${d.slotText}.` }),
      field("New date", date), field("New time", slot), note,
      d.email ? el("label", { class: "check" }, notify, el("span", { text: "Email the customer the new time" })) : null
    ];
    const ok = await formDialog("Move the booking", body, "Move it", async () => {
      if (!slot.value) throw new Error("Pick a time.");
      try { await rpc("staff_move", { ref: pg.ref, date: date.value, slot: slot.value, notify: !!d.email && notify.checked }); }
      catch (e) { fill(); throw e; }
    });
    if (ok){ toast("Booking moved"); pg.reload(); }
  }

  async function editDialog(pg, d){
    const { info } = pg;
    const name = el("input", { required: true, maxlength: 100, autocomplete: "off", value: d.name || "" });
    const phone = el("input", { type: "tel", maxlength: 40, autocomplete: "off", value: d.phone || "" });
    const pkgNames = (info.packages || []).map(p => p.name);
    if (d.package && !pkgNames.includes(d.package)) pkgNames.push(d.package);
    const pkg = select(pkgNames, d.package);
    const type = select(TYPES, d.vehicleType);
    const desc = el("input", { maxlength: 120, value: d.vehicleDesc || "", placeholder: "e.g. Grey Toyota Corolla" });
    const addons = addonPicker(info.addons || [], d.addons);
    const where = select([...(d.location ? [] : [["", "Not set"]]), [MOBILE, "Mobile (we go to them)"], [DROP, "Drop-off (they come to us)"]], d.location || "");
    const address = el("input", { maxlength: 300, value: d.address || "", placeholder: "Street, or landmark" });
    const parish = select([["", "No parish"], ...PARISHES.map(p => [p, p])], d.parish || "");
    if (d.parish && !PARISHES.includes(d.parish)) parish.append(el("option", { value: d.parish, text: d.parish, selected: true }));
    const notes = el("textarea", { maxlength: 1000 });
    notes.value = d.notes || "";
    const needAddress = () => { address.required = where.value === MOBILE; };
    where.addEventListener("change", needAddress);
    needAddress();

    const body = [
      el("div", { class: "grid2" }, field("Name", name), field("Phone", phone)),
      field("Package", pkg),
      el("div", { class: "grid2" }, field("Vehicle type", type), field("Make and model", desc)),
      el("div", { class: "field" }, el("span", { class: "lbl", text: "Add-ons" }), addons.node),
      field("Where", where),
      el("div", { class: "grid2" }, field("Address", address), field("Parish", parish)),
      field("Notes for the job", notes, "The customer can see these.")
    ];
    let price = null, why = null;
    if (d.canEditPrice){
      price = el("input", { type: "number", inputmode: "decimal", min: "0", step: "0.01", placeholder: "Leave empty to work it out" });
      why = el("input", { maxlength: 200, placeholder: "e.g. friend of the business" });
      body.push(el("hr", { class: "bk-sep" }),
        el("p", { class: "muted small", text: `Owners only. The price now is ${fmt.money(d.total)}.` }),
        el("div", { class: "grid2" }, field("Price by hand ($)", price), field("Reason for the price", why)));
    }

    let result = null;
    const ok = await formDialog("Change details", body, "Save", async () => {
      const same = (a, b) => String(a || "").trim() === String(b || "").trim();
      const patch = {};
      if (!same(name.value, d.name)) patch.name = name.value.trim();
      if (!same(phone.value, d.phone)) patch.phone = phone.value.trim();
      if (pkg.value !== d.package) patch.package = pkg.value;
      if (type.value !== d.vehicleType) patch.vehicle_type = type.value;
      if (!same(desc.value, d.vehicleDesc)) patch.vehicle_desc = desc.value.trim();
      if (!sameAddons(addons.value(), d.addons)) patch.addons = addons.value();
      if (where.value !== (d.location || "")) patch.location = where.value;
      if (!same(address.value, d.address)) patch.address = address.value.trim();
      if (parish.value !== (d.parish || "")) patch.parish = parish.value;
      if (!same(notes.value, d.notes)) patch.notes = notes.value.trim();
      if (!name.value.trim()) throw new Error("The name can't be empty.");
      if (where.value === MOBILE && !address.value.trim()) throw new Error("Add the address for a mobile job.");
      if (price && price.value !== ""){
        if (!why.value.trim()) throw new Error("Add a short reason for the price.");
        patch.total = Number(price.value);
        patch.price_note = why.value.trim();
      }
      if (!Object.keys(patch).length){ result = "same"; return; }
      // Changing what's done works the price out again, which replaces a price set by hand.
      const repriced = patch.package !== undefined || patch.vehicle_type !== undefined || patch.addons !== undefined;
      if (repriced && d.priceNote && patch.total === undefined
        && !(await confirm("Work the price out again?", `The price (${fmt.money(d.total)}) was set by hand. Changing the package, vehicle type or add-ons works it out again from the price list.`, "Yes, change it"))){
        result = "kept";
        return;
      }
      result = await rpc("staff_edit", { ref: pg.ref, ...patch });
    });
    if (!ok) return;
    if (result === "same"){ toast("Nothing was changed."); return; }
    if (result === "kept"){ toast("Nothing was changed."); return; }
    toast(result && result.total !== d.total ? `Saved. The price is now ${fmt.money(result.total)}.` : "Saved");
    pg.reload();
  }

  /* ---------- the booking's details ---------- */
  function detailsCard(d){
    const where = d.mobile ? "Mobile (we go to them)" : d.location ? "Drop-off (they come to us)" : "Not set";
    const place = [d.address, d.parish].filter(Boolean).join(", ");
    const map = d.mobile && place ? `https://maps.google.com/?q=${encodeURIComponent(place + ", Barbados")}` : null;
    return el("div", { class: "card bk-o1" },
      el("h2", { text: "The job" }),
      el("div", { class: "kv" },
        kv("Package", d.package),
        kv("Add-ons", d.addons || "None"),
        kv("Vehicle", [d.vehicleType, d.vehicleDesc].filter(Boolean).join(" · ") || "—"),
        kv("Where", where),
        place ? kv("Address", place, map ? " · " : null, map ? el("a", { href: map, target: "_blank", rel: "noopener", text: "Map" }) : null) : null,
        kv("Booked", `${SOURCES[d.source] || d.source || "—"}, ${fmt.when(d.createdAt)}`),
        d.job && d.job.assignedName ? kv("Doing it", d.job.assignedName) : null),
      d.notes ? el("div", { class: "note" }, el("b", { text: "Notes: " }), d.notes) : null);
  }

  function customerCard(d){
    const c = d.customer;
    const phone = d.phone || c.phone;
    const wa = waLink(phone);
    const digits = s => String(s || "").replace(/\D/g, "");
    return el("div", { class: "card bk-o2" },
      el("h2", {}, "Customer", el("small", { text: c.tier !== "Regular" ? `${c.tier} member` : "" })),
      el("div", { class: "kv" },
        kv("Name", c.name),
        kv("Phone", phone || "—"),
        c.phone && d.phone && digits(c.phone) !== digits(d.phone) ? kv("Saved phone", c.phone) : null,
        kv("Email", d.email || c.email || "—"),
        kv("Stamps", `${c.stamps} of 6`),
        kv("Tier", c.discount ? `${c.tier} (${Math.round(c.discount * 100)}% off packages)` : c.tier),
        kv("Credit", fmt.money(c.credit))),
      c.notes ? el("div", { class: "note" }, el("b", { text: "About them: " }), c.notes) : null,
      el("div", { class: "acts" },
        phone ? el("a", { class: "btn btn-primary", href: telHref(phone) }, "Call") : null,
        wa ? el("a", { class: "btn", href: wa, target: "_blank", rel: "noopener" }, "WhatsApp") : null,
        el("a", { class: "btn btn-ghost", href: `staff-messages.html?c=${c.id}` }, "Messages"),
        el("a", { class: "btn btn-ghost", href: `staff-customer.html?id=${c.id}` }, "Customer page")));
  }

  /* ---------- money ---------- */
  function moneyCard(pg, d){
    let owing;
    if ((d.status === "cancelled" || d.status === "no_show") && d.paid === 0) owing = el("span", { class: "dim", text: `Nothing (${d.status === "cancelled" ? "cancelled" : "no-show"})` });
    else if (d.owing > 0) owing = el("b", { class: "bk-owing", text: fmt.money(d.owing) });
    else if (d.owing < 0) owing = el("b", { class: "bk-owing", text: `Paid ${fmt.money(-d.owing)} too much` });
    else owing = el("b", { class: "bk-paid", text: d.total > 0 ? "Nothing. Paid in full." : "Nothing" });
    const extras = [];
    if (d.quotedTotal != null && d.quotedTotal !== d.total) extras.push(kv("When booked", fmt.money(d.quotedTotal)));
    if (d.rewardApplied) extras.push(kv("Reward", "6th detail at half price"));
    if (d.creditUsed > 0) extras.push(kv("Credit used", fmt.money(d.creditUsed)));
    const pays = d.payments || [];
    const owner = pg.me.owner;
    return el("div", { class: "card bk-o5" },
      el("h2", { text: "Money" }),
      el("div", { class: "kv" }, kv("Price", el("b", { text: fmt.money(d.total) })), kv("Paid", fmt.money(d.paid)), kv("Owing", owing), extras),
      d.priceNote ? el("div", { class: "note", text: `Price set by hand: ${d.priceNote}` }) : null,
      pays.length ? el("div", { style: "margin-top:.8rem" }, pays.map(p => el("div", { class: "bk-pay" },
        el("div", {},
          el("div", { text: `${METHODS[p.method] || p.method}${p.amount < 0 ? " refund" : ""}` }),
          el("div", { class: "dim", text: [fmt.when(p.at), p.takenBy ? `taken by ${p.takenBy}` : ""].filter(Boolean).join(" · ") }),
          p.note ? el("div", { class: "dim", text: p.note }) : null),
        el("b", { class: p.amount < 0 ? "neg" : "", text: fmt.money(p.amount) })))) : el("p", { class: "dim small", style: "margin-top:.6rem", text: "No payments yet." }),
      el("div", { class: "acts" },
        el("button", { class: "btn btn-primary", type: "button", on: { click: () => paymentDialog(pg, d) } }, "Record payment"),
        owner && d.paid > 0 ? el("button", { class: "btn btn-danger", type: "button", on: { click: () => refundDialog(pg, d) } }, "Refund") : null));
  }

  async function paymentDialog(pg, d){
    const amount = el("input", { type: "number", inputmode: "decimal", min: "0.01", step: "0.01", required: true, value: d.owing > 0 ? String(d.owing) : "" });
    const method = select(Object.entries(METHODS), "cash");
    const code = el("input", { autocomplete: "off", autocapitalize: "characters", maxlength: 40, placeholder: "Code on the voucher" });
    const codeMsg = el("p", { class: "msg", role: "status" });
    const check = el("button", { class: "btn", type: "button", on: { click: async () => {
      codeMsg.className = "msg";
      codeMsg.textContent = "";
      if (!code.value.trim()){ codeMsg.className = "msg err"; codeMsg.textContent = "Type the code first."; return; }
      check.disabled = true;
      try {
        const v = await rpc("staff_voucher_check", { code: code.value.trim() });
        const amt = Number(amount.value) || 0;
        if (v.expired){ codeMsg.className = "msg err"; codeMsg.textContent = `This voucher ran out on ${fmt.date(v.expiresOn, { plain: true })}.`; }
        else if (v.balance <= 0){ codeMsg.className = "msg err"; codeMsg.textContent = "There's nothing left on this voucher."; }
        else {
          codeMsg.className = "msg ok";
          codeMsg.textContent = `${fmt.money(v.balance)} left${v.recipient ? ` (for ${v.recipient})` : ""}.`
            + (v.expiresOn ? ` Use by ${fmt.date(v.expiresOn, { plain: true })}.` : "")
            + (amt > v.balance ? ` That's less than ${fmt.money(amt)}, so make the amount ${fmt.money(v.balance)} and take the rest another way.` : "");
        }
      } catch (e) {
        codeMsg.className = "msg err";
        codeMsg.textContent = e.message;
      } finally { check.disabled = false; }
    } } }, "Check");
    const voucherRow = el("div", { class: "field" }, el("label", { text: "Voucher code" }), el("div", { class: "search", style: "margin-bottom:0" }, code, check), codeMsg);
    const showVoucher = () => { voucherRow.classList.toggle("hide", method.value !== "voucher"); code.required = method.value === "voucher"; };
    method.addEventListener("change", showVoucher);
    showVoucher();
    const note = el("input", { maxlength: 200, placeholder: "Optional" });
    const body = [
      el("p", { class: "muted small", text: `Price ${fmt.money(d.total)} · paid ${fmt.money(d.paid)} · owing ${fmt.money(Math.max(0, d.owing))}` }),
      field("Amount ($)", amount), field("How they paid", method), voucherRow, field("Note", note)
    ];
    const ok = await formDialog("Record a payment", body, "Save payment", () => rpc("staff_payment_add", {
      ref: pg.ref, amount: Number(amount.value), method: method.value,
      voucher_code: method.value === "voucher" ? code.value.trim() : undefined, note: note.value.trim() || undefined
    }));
    if (ok){ toast("Payment saved"); pg.reload(); }
  }

  async function refundDialog(pg, d){
    const amount = el("input", { type: "number", inputmode: "decimal", min: "0.01", max: String(d.paid), step: "0.01", required: true });
    const method = select(Object.entries(METHODS).filter(([k]) => k !== "voucher"), "cash");
    const note = el("input", { maxlength: 200, required: true, placeholder: "e.g. wheels not done" });
    const ok = await formDialog("Refund", [
      el("p", { class: "muted small", text: `Paid so far: ${fmt.money(d.paid)}. Type the amount you gave back.` }),
      field("Amount given back ($)", amount), field("How it went back", method), field("Why", note)
    ], "Save refund", () => rpc("staff_payment_add", { ref: pg.ref, amount: -Math.abs(Number(amount.value)), method: method.value, note: note.value.trim() }), true);
    if (ok){ toast("Refund saved"); pg.reload(); }
  }

  /* ---------- the crew's job card ---------- */
  function tick(pg, i, on, count){
    checks.list[i].done = on;
    count.textContent = `${checks.list.filter(x => x.done).length} of ${checks.list.length} done`;
    const payload = checks.list.map(x => ({ item: x.item, done: x.done }));
    checks.pending++;
    checks.queue = checks.queue
      .then(() => rpc("staff_job", { ref: pg.ref, checklist: payload }))
      .catch(e => toast(e.message, true))
      .finally(() => { if (--checks.pending === 0) pg.reload(); });
  }

  function jobCard(pg, d){
    const list = checks.list || [];
    const count = el("small", { text: list.length ? `${list.filter(x => x.done).length} of ${list.length} done` : "" });
    const boxes = el("div", { class: "checklist" }, list.map((x, i) => {
      const box = el("input", { type: "checkbox", checked: x.done });
      box.addEventListener("change", () => tick(pg, i, box.checked, count));
      return el("label", { class: "check" }, box, el("span", { text: x.item }));
    }));

    const unsaved = el("span", { class: "dim small", role: "status" });
    const cond = el("textarea", { maxlength: 2000, placeholder: "Scratches, dents or stains seen before starting" });
    const notes = el("textarea", { maxlength: 2000, placeholder: "Anything the team should know" });
    cond.value = drafts.cond ?? d.conditionNotes ?? "";
    notes.value = drafts.staff ?? d.staffNotes ?? "";
    const typed = () => {
      drafts.cond = cond.value;
      drafts.staff = notes.value;
      unsaved.textContent = cond.value !== (d.conditionNotes || "") || notes.value !== (d.staffNotes || "") ? "Not saved yet" : "";
    };
    cond.addEventListener("input", typed);
    notes.addEventListener("input", typed);
    if (drafts.cond !== undefined || drafts.staff !== undefined) typed();
    const save = el("button", { class: "btn btn-primary", type: "button", on: { click: async e => {
      const ok = await run(e.currentTarget, () => rpc("staff_job", { ref: pg.ref, condition_notes: cond.value, staff_notes: notes.value }), "Notes saved");
      if (ok){ delete drafts.cond; delete drafts.staff; pg.reload(); }
    } } }, "Save notes");

    const now = d.assignedTo ? String(d.assignedTo) : "";
    const who = select([["", "Nobody yet"], ...(d.staff || []).map(s => [String(s.user_id), s.name])], now);
    who.addEventListener("change", async () => {
      const label = who.value ? `Given to ${who.selectedOptions[0].text}` : "Nobody on it now";
      if (await run(who, () => rpc("staff_job", { ref: pg.ref, assigned_to: who.value ? Number(who.value) : null }), label)) pg.reload();
      else who.value = now;
    });

    return el("div", { class: "card bk-o3" },
      el("h2", {}, "Job card", count),
      field("Who's doing it", who),
      list.length ? boxes : el("p", { class: "dim small", text: "No checklist for this package." }),
      el("div", { style: "margin-top:1rem" },
        field("Condition before starting", cond, "Write down any damage, and add a damage photo below."),
        field("Staff notes", notes, "Only staff see these.")),
      el("div", { class: "acts", style: "align-items:center" }, save, unsaved));
  }

  /* ---------- photos ---------- */
  // Shrink a photo in the browser: at most 1600px on the long side, JPEG.
  function shrink(file, max = 1600, quality = 0.82){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name || "That file"} isn't a photo this phone can open.`)); };
      img.src = url;
    });
  }

  function photoTile(pg, ph){
    const src = api.photoUrl(ph.id);
    const open = () => viewer(src);
    return el("figure", { class: "bk-ph" },
      el("div", { class: "photo" },
        el("img", { src, alt: ph.caption || `${KINDS[ph.kind] || ph.kind} photo`, loading: "lazy", tabindex: "0", role: "button",
          on: { click: open, keydown: e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } } } }),
        el("span", { class: `tag ${ph.kind}`, text: KINDS[ph.kind] || ph.kind }),
        // owners, or whoever took it, can delete a photo
        pg.me.owner || ph.takenBy === pg.me.id ? el("button", { class: "del", type: "button", "aria-label": "Delete this photo", on: { click: async e => {
          if (!(await confirm("Delete this photo?", "It can't be brought back.", "Delete", true))) return;
          if (await run(e.currentTarget, () => rpc("staff_photo_delete", { id: ph.id }), "Photo deleted")) pg.reload();
        } } }, "Delete") : null),
      el("figcaption", { text: [ph.caption, fmt.when(ph.created_at)].filter(Boolean).join(" · ") }));
  }

  function photosCard(pg, d){
    const photos = d.photos || [];
    if (!pg.kind) pg.kind = d.status === "in_progress" || d.status === "completed" ? "after" : "before";
    const kind = select(Object.entries(KINDS), pg.kind);
    kind.addEventListener("change", () => { pg.kind = kind.value; });
    const caption = el("input", { maxlength: 120, placeholder: "Optional, e.g. scratch on back door" });
    const status = el("p", { class: "msg", role: "status" });
    const camera = el("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, class: "bk-file", tabindex: "-1", "aria-hidden": "true" });
    const gallery = el("input", { type: "file", accept: "image/*", multiple: true, class: "bk-file", tabindex: "-1", "aria-hidden": "true" });
    const take = el("button", { class: "btn btn-primary", type: "button", on: { click: () => camera.click() } }, "Take a photo");
    const choose = el("button", { class: "btn", type: "button", on: { click: () => gallery.click() } }, "Choose photos");

    async function upload(input){
      const files = [...input.files];
      input.value = "";
      if (!files.length) return;
      take.disabled = choose.disabled = true;
      let ok = 0;
      for (let i = 0; i < files.length; i++){
        status.className = "msg";
        status.textContent = files.length > 1 ? `Sending photo ${i + 1} of ${files.length}…` : "Sending the photo…";
        try {
          const data = await shrink(files[i]);
          await post("/photos", { ref: pg.ref, kind: kind.value, caption: caption.value.trim(), data });
          ok++;
        } catch (e) {
          toast(e.message || "That photo didn't send. Try again.", true);
        }
      }
      take.disabled = choose.disabled = false;
      status.textContent = "";
      if (ok){ toast(ok === 1 ? "Photo added" : `${ok} photos added`); pg.reload(); }
    }
    camera.addEventListener("change", () => upload(camera));
    gallery.addEventListener("change", () => upload(gallery));

    return el("div", { class: "card bk-o4" },
      el("h2", {}, "Photos", el("small", { text: photos.length ? `${photos.length}` : "" })),
      photos.length ? el("div", { class: "photos" }, photos.map(ph => photoTile(pg, ph))) : empty("No photos yet. Take before photos when you arrive."),
      el("div", { class: "bk-up" },
        el("div", { class: "grid2" }, field("Photo type", kind), field("Caption", caption)),
        el("div", { class: "acts" }, take, choose),
        camera, gallery, status));
  }

  /* ---------- timeline ---------- */
  function timelineCard(d){
    const events = d.events || [];
    return el("div", { class: "card bk-o6" },
      el("h2", { text: "Timeline" }),
      events.length ? el("ul", { class: "tl" }, events.map(e => el("li", {},
        el("time", { datetime: e.created_at, text: fmt.when(e.created_at) }),
        el("div", {},
          el("b", { text: EVENTS[e.kind] || e.kind }), e.actor_name ? ` · ${e.actor_name}` : "",
          e.detail ? el("div", { class: "dim small", text: e.detail }) : null)))) : empty("Nothing yet."));
  }

  Office.start({ page: "bookings", title: "Booking", render });
})();
