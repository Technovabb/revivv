/* Back office: Settings (staff-settings.html, owners only). Prices, hours,
   business details and emails, closed days, and whether emails are being sent.
   Each card saves on its own; the server checks what is sent and says what's wrong. */
(() => {
  const { el, clear, rpc, fmt, act, field, select, toast, empty } = Office;
  const VEHICLES = ["Car", "SUV", "Truck"];
  const SEAT = "Seat extraction shampoo";
  const WEEK = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];

  // Cards with changes not saved yet; leaving the page asks first.
  const dirty = new Set();
  window.addEventListener("beforeunload", e => { if (dirty.size) { e.preventDefault(); e.returnValue = ""; } });

  const stop = text => { throw new Error(text); };
  const box = (checked, label) => {
    const input = el("input", { type: "checkbox", checked: !!checked });
    return { input, node: el("label", { class: "check" }, input, label) };
  };
  const num = (value, { min, max, step = "1", label } = {}) =>
    el("input", { type: "number", inputmode: step === "1" ? "numeric" : "decimal", min: String(min), max: String(max), step, value: value == null ? "" : String(value), "aria-label": label || null });
  const wholeIn = (input, lo, hi, what) => {
    const v = input.value.trim();
    const n = Number(v);
    if (v === "" || !Number.isInteger(n) || n < lo || n > hi) stop(`${what}: enter a whole number from ${lo} to ${hi}.`);
    return n;
  };
  const priceIn = (input, what) => {
    const v = input.value.trim();
    const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < 0 || n > 10000) stop(`${what}: enter a price from 0 to 10,000.`);
    return Math.round(n * 100) / 100;
  };
  const cleanName = (s, max, what) => {
    const v = s.trim();
    if (!v) stop(`${what} can't be empty.`);
    if (v.length > max) stop(`${what} is too long (${max} letters at most).`);
    if (/[,×]/.test(v)) stop(`${what} can't have a comma or × in it.`);
    return v;
  };

  /* A card with its own Save button. collect() builds the value (or throws a
     plain message); the server's answer goes to saved(clean). */
  function card(id, key, title, hint, body, { collect, saved, label = "Save", done }){
    const msg = el("p", { class: done ? "msg ok" : "msg", role: "status", text: done || "" });
    const btn = el("button", { class: "btn btn-primary", type: "button" }, label);
    const c = el("div", { class: "card", id }, el("h2", {}, title, hint ? el("small", { text: hint }) : null), body,
      el("div", { class: "acts save-row" }, btn), msg);
    const changed = () => { dirty.add(key); msg.className = "msg warn"; msg.textContent = "Not saved yet."; };
    c.addEventListener("input", changed);
    c.addEventListener("change", changed);
    btn.addEventListener("click", async () => {
      msg.className = "msg"; msg.textContent = "";
      let value;
      try { value = collect(); } catch (e) { msg.className = "msg err"; msg.textContent = e.message; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const clean = await rpc("settings_save", { key, value });
        dirty.delete(key);
        toast("Saved");
        saved(clean, value);
      } catch (e) {
        msg.className = "msg err"; msg.textContent = e.message;
        btn.disabled = false; btn.textContent = label;
      }
    });
    return c;
  }

  /* ---------- prices ---------- */
  function pricesCard(catalog, done){
    const packs = catalog.packages.map(p => {
      const prices = Object.fromEntries(VEHICLES.map(t => [t, num(p.prices && p.prices[t], { min: 0, max: 10000, step: "0.01", label: `${p.name}, ${t} price` })]));
      const offered = box(p.active !== false, "Offered");
      const list = el("textarea", { rows: 7, "aria-label": `${p.name} job checklist` });
      list.value = (p.checklist || []).join("\n");
      return { p, prices, offered, list, node: el("div", { class: "set-block" },
        el("h3", { text: p.name }),
        el("div", { class: "grid3 prices" }, VEHICLES.map(t => field(`${t} $`, prices[t]))),
        offered.node,
        field("Job checklist", list, "One job per line. The crew tick these off on the job card.")) };
    });

    const rows = [];
    const addonList = el("div", { class: "addon-list" });
    function addonRow(a, isNew){
      const r = { a, isNew };
      r.price = num(a.price, { min: 0, max: 10000, step: "0.01", label: `${a.name || "New add-on"} price` });
      r.offered = box(a.active !== false, "Offered");
      if (isNew) r.name = el("input", { maxlength: 60, placeholder: "Name of the add-on", "aria-label": "Add-on name" });
      const seat = a.name === SEAT;
      r.node = el("div", { class: "set-block addon" },
        isNew ? field("Name", r.name) : el("h3", { text: a.name }),
        seat ? el("p", { class: "dim small", text: "Priced per row of seats (the customer picks 1 to 4 rows). This name can't change." }) : null,
        el("div", { class: "addon-line" },
          field(seat ? "Price per row $" : "Price $", r.price),
          r.offered.node,
          isNew ? el("button", { class: "btn btn-ghost", type: "button", on: { click: () => {
            rows.splice(rows.indexOf(r), 1);
            addonList.dispatchEvent(new Event("change", { bubbles: true }));   // counts as a change to save
            r.node.remove(); addBtn.disabled = rows.length >= 20;
          } } }, "Remove") : null));
      rows.push(r);
      addonList.append(r.node);
      return r;
    }
    catalog.addons.forEach(a => addonRow(a, false));
    const addBtn = el("button", { class: "btn", type: "button", disabled: rows.length >= 20, on: { click: () => {
      const r = addonRow({ name: "", price: "", active: true }, true);
      addonList.dispatchEvent(new Event("change", { bubbles: true }));
      addBtn.disabled = rows.length >= 20;
      r.name.focus();
    } } }, "+ Add an add-on");

    const body = [
      el("p", { class: "note", text: "The booking form on the website uses these prices straight away. The Packages page text is written in by hand: if you change a package price, ask Tech Nova to change that page too." }),
      packs.map(x => x.node),
      el("h3", { class: "set-sub", text: "Add-ons" }),
      el("p", { class: "dim small", text: "To stop offering an add-on, untick Offered. Names can't change once saved, because old bookings use them. To rename one, untick it and add a new one." }),
      addonList,
      el("div", { class: "acts" }, addBtn)
    ];

    const c = card("prices", "catalog", "Prices", "BBD", body, {
      label: "Save prices", done,
      collect(){
        const packages = packs.map(x => ({
          name: x.p.name,
          prices: Object.fromEntries(VEHICLES.map(t => [t, priceIn(x.prices[t], `${x.p.name} (${t})`)])),
          active: x.offered.input.checked,
          checklist: (() => {
            const lines = x.list.value.split("\n").map(s => s.trim()).filter(Boolean);
            if (lines.length > 20) stop(`${x.p.name} checklist: 20 lines at most.`);
            if (lines.some(s => s.length > 80)) stop(`${x.p.name} checklist: a line is too long (80 letters at most).`);
            return lines;
          })()
        }));
        const seen = new Set();
        const addons = rows.map(r => {
          const name = r.isNew ? cleanName(r.name.value, 60, "An add-on name") : r.a.name;
          if (seen.has(name.toLowerCase())) stop(`"${name}" is listed twice.`);
          seen.add(name.toLowerCase());
          return { name, price: priceIn(r.price, name), active: r.offered.input.checked };
        });
        if (addons.length > 20) stop("20 add-ons at most.");
        return { packages, addons };
      },
      saved(clean){
        const moved = clean.packages.some((p, i) => VEHICLES.some(t => Number(p.prices[t]) !== Number(catalog.packages[i].prices[t])));
        c.replaceWith(pricesCard(clean, moved
          ? "Saved. The booking form uses the new prices now. Ask Tech Nova to change the prices on the Packages page too."
          : "Saved."));
      }
    });
    return c;
  }

  /* ---------- hours ---------- */
  function hoursCard(hours, done){
    const slots = hours.slots.map(s => {
      const label = el("input", { maxlength: 40, value: s.label || "", "aria-label": "Slot name" });
      const time = el("input", { maxlength: 40, value: s.time || "", "aria-label": "Slot time" });
      const offered = box(s.active !== false, "Offered");
      const gold = box(!!s.goldOnly, "Gold members only");
      return { s, label, time, offered, gold, node: el("div", { class: "set-block" },
        el("h3", { text: s.label }),
        el("div", { class: "grid2" }, field("Name", label), field("Time", time, "As customers see it, e.g. 8:00am – 12:00pm")),
        el("div", { class: "checks" }, offered.node, gold.node),
        el("p", { class: "dim small", text: s.long
          ? "A long slot: every package fits."
          : "A short slot: only The Express Exterior and All-Around Express fit." })) };
    });
    const closed = new Set(hours.closedWeekdays || []);
    const days = WEEK.map(([d, name]) => ({ d, ...box(closed.has(d), name) }));
    const ahead = num(hours.bookAheadDays, { min: 7, max: 366, label: "Days ahead" });

    const body = [
      slots.map(x => x.node),
      el("h3", { class: "set-sub", text: "Closed every week on" }),
      el("div", { class: "days" }, days.map(x => x.node)),
      el("p", { class: "dim small", text: "Customers can't pick these days on the website. Staff can still book them." }),
      field("Take bookings up to this many days ahead", ahead, "From 7 to 366. 366 = a year.")
    ];
    const c = card("hours", "hours", "Hours", null, body, {
      label: "Save hours", done,
      collect(){
        const out = slots.map(x => ({
          id: x.s.id, label: cleanName(x.label.value, 40, "A slot name"), time: cleanName(x.time.value, 40, `${x.s.label} time`),
          active: x.offered.input.checked, goldOnly: x.gold.input.checked
        }));
        if (!out.some(x => x.active)) stop("Keep at least one slot offered.");
        const closedWeekdays = days.filter(x => x.input.checked).map(x => x.d);
        if (closedWeekdays.length === 7) stop("At least one day a week must be open.");
        return { slots: out, closedWeekdays, bookAheadDays: wholeIn(ahead, 7, 366, "Days ahead") };
      },
      saved(clean){ c.replaceWith(hoursCard(clean, "Saved. The website uses the new hours now.")); }
    });
    return c;
  }

  /* ---------- business details and emails ---------- */
  function businessCard(b, done){
    const text = (v, max, extra = {}) => el("input", { maxlength: max, value: v || "", ...extra });
    const phone = text(b.phone, 40, { type: "tel", autocomplete: "off" });
    const phone2 = text(b.phone2, 40, { type: "tel", autocomplete: "off" });
    const whatsapp = text(b.whatsapp, 20, { type: "tel", inputmode: "numeric", autocomplete: "off" });
    const instagram = text(b.instagram, 60, { autocomplete: "off" });
    const review = text(b.reviewUrl, 300, { type: "url", placeholder: "https://g.page/r/…", autocomplete: "off" });
    const hourLabel = h => h === 12 ? "12 noon" : h < 12 ? `${h}am` : `${h - 12}pm`;
    const hour = select(Array.from({ length: 15 }, (_, i) => [i + 6, hourLabel(i + 6)]), b.reminderHour);
    const nudge = num(b.nudgeAfterDays, { min: 0, max: 365, label: "Days after a detail" });
    const cancel = num(b.cancelHours, { min: 0, max: 168, label: "Hours before" });

    const body = [
      el("div", { class: "grid2" },
        field("Phone", phone),
        field("Second phone", phone2, "Leave empty if there isn't one."),
        field("WhatsApp number", whatsapp, "Numbers only, with 1246 in front, e.g. 12462608228."),
        field("Instagram", instagram, "Without the @, e.g. revivv.bb")),
      field("Google review link", review, "Shown in the thank-you email after a detail. Starts with https://. Leave empty until the Google page is ready."),
      el("div", { class: "grid3" },
        field("Reminder emails go out from", hour, "Reminders and \"next detail\" emails, Barbados time."),
        field("\"Time for your next detail\" after (days)", nudge, "0 = don't send it."),
        field("Customers can cancel online up to (hours before)", cancel, "24 = one day. 0 = right up to the slot."))
    ];
    const c = card("business", "business", "Business details and emails", null, body, {
      label: "Save details", done,
      collect(){
        const r = review.value.trim();
        if (r && !/^https:\/\//.test(r)) stop("The review link must start with https://");
        const wa = whatsapp.value.replace(/\D/g, "");
        if (whatsapp.value.trim() && !wa) stop("The WhatsApp number needs numbers in it.");
        return {
          phone: phone.value.trim(), phone2: phone2.value.trim(), whatsapp: wa,
          instagram: instagram.value.trim().replace(/^@/, ""), reviewUrl: r,
          reminderHour: Number(hour.value),
          nudgeAfterDays: wholeIn(nudge, 0, 365, "Next detail email"),
          cancelHours: wholeIn(cancel, 0, 168, "Cancel online")
        };
      },
      saved(clean){ c.replaceWith(businessCard(clean, "Saved.")); }
    });
    return c;
  }

  /* ---------- closed days ---------- */
  function closedCard(list){
    const c = el("div", { class: "card", id: "closed" });
    const warn = el("div");
    const listBox = el("div");
    const day = el("input", { type: "date", min: fmt.todayISO(), required: true, "aria-label": "Date" });
    const reason = el("input", { maxlength: 100, placeholder: "e.g. Public holiday", "aria-label": "Reason" });
    const msg = el("p", { class: "msg err", role: "alert" });

    async function refresh(){
      const s = await rpc("settings_get");
      list = s.closedDays || [];
      draw();
    }
    function draw(){
      if (!list.length) { clear(listBox, empty("No closed days coming up.")); return; }
      clear(listBox, el("div", { class: "list" }, list.map(d => el("div", { class: "closed-row" },
        el("div", {}, el("b", { text: fmt.date(d.day) }), el("div", { class: "dim small", text: d.reason || "No reason given" })),
        el("button", { class: "btn btn-ghost", type: "button", on: { click: async e => {
          await act(e.currentTarget, () => rpc("closed_day_remove", { day: d.day }), `${fmt.date(d.day, { plain: true })} is open again`)
            .then(refresh, () => {});
        } } }, "Remove")))));
    }
    const addBtn = el("button", { class: "btn btn-primary", type: "button", on: { click: async e => {
      msg.textContent = "";
      clear(warn);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.value)) { msg.textContent = "Pick a date."; return; }
      if (day.value < fmt.todayISO()) { msg.textContent = "Pick today or a later date."; return; }
      const picked = day.value;
      try {
        const out = await act(e.currentTarget, () => rpc("closed_day_add", { day: picked, reason: reason.value.trim() }), `${fmt.date(picked, { plain: true })} is closed`);
        day.value = ""; reason.value = "";
        if (out && out.bookingsThatDay > 0) {
          const n = out.bookingsThatDay;
          clear(warn, el("div", { class: "alert" },
            `There ${n === 1 ? "is 1 booking" : `are ${n} bookings`} on ${fmt.date(picked, { plain: true })}. Move or cancel ${n === 1 ? "it" : "them"} on the `,
            el("a", { href: `staff-bookings.html?from=${picked}&to=${picked}`, text: "Bookings page" }), "."));
        }
        await refresh();
      } catch (err) {
        msg.textContent = err.message;
      }
    } } }, "Close this day");

    c.append(el("h2", {}, "Closed days", el("small", { text: "holidays and days off" })),
      el("p", { class: "dim small", text: "Customers can't book a closed day on the website." }),
      warn, listBox,
      el("h3", { class: "set-sub", text: "Close a day" }),
      el("div", { class: "grid2" }, field("Date", day), field("Reason", reason, "Optional. Staff see it on the Today page.")),
      msg,
      el("div", { class: "acts" }, addBtn));
    draw();
    return c;
  }

  /* ---------- email status ---------- */
  function emailCard(s){
    let body;
    if (s.emailsHeld) {
      body = [
        el("div", { class: "alert", text: "Emails are not being sent yet." }),
        el("p", { text: "Revivv doesn't have its own mailbox yet. So booking emails, reminders and messages are kept on the Emails page and are not sent to anyone." }),
        el("p", { text: "You can read them there and pass the important ones on by WhatsApp." }),
        el("p", { text: "Once Revivv's mailbox is set up, new emails go out by themselves." }),
        el("div", { class: "acts" }, el("a", { class: "btn", href: "staff-outbox.html" }, "Open the Emails page"))
      ];
    } else if (s.mailReady) {
      body = [el("p", { class: "ok-line", text: "Emails are on. They go out by themselves." }),
        el("div", { class: "acts" }, el("a", { class: "btn", href: "staff-outbox.html" }, "See sent emails"))];
    } else {
      body = [el("p", { class: "muted", text: "This is a test server: emails are written to its log, not sent to anyone." }),
        el("div", { class: "acts" }, el("a", { class: "btn", href: "staff-outbox.html" }, "See the emails"))];
    }
    return el("div", { class: "card", id: "email" }, el("h2", { text: "Email" }), body);
  }

  /* ---------- the page ---------- */
  async function render(main){
    const s = await rpc("settings_get");
    const jump = el("nav", { class: "jump", "aria-label": "Settings sections" },
      [["prices", "Prices"], ["hours", "Hours"], ["business", "Details"], ["closed", "Closed days"], ["email", "Email"]]
        .map(([id, label]) => el("a", { href: `#${id}` }, label)));
    main.append(el("div", { class: "o-title" }, el("div", {}, el("h1", { text: "Settings" }),
      el("div", { class: "sub", text: "Prices, hours and closed days. The website uses them straight away." }))), jump);
    if (s.emailsHeld) {
      main.append(el("div", { class: "alert" }, "Emails are not being sent yet (no mailbox). ", el("a", { href: "#email", text: "Read why" })));
    }
    main.append(
      pricesCard(s.catalog),
      hoursCard(s.hours),
      businessCard(s.business),
      closedCard(s.closedDays || []),
      emailCard(s));
  }

  Office.start({ page: "settings", title: "Settings", owner: true, render });
})();
