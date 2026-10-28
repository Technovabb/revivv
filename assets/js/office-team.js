/* Back office: Staff (staff-team.html, owners only). Who can sign in, their
   role, password links, and the activity log of who changed what. */
(() => {
  const { el, clear, rpc, fmt, act, empty, field, select, dialog, confirm, toast } = Office;

  const ROLE = { owner: "Owner", crew: "Crew" };
  const ROLE_HINT = {
    owner: "Owners see everything.",
    crew: "Crew see jobs, customers and messages, not money, reports or settings."
  };
  const ACTIONS = {
    "staff.added": "Added staff",
    "staff.updated": "Changed staff",
    "staff.removed": "Removed staff",
    "staff.link": "Made a password link",
    "customer.added": "Added a customer",
    "customer.updated": "Changed a customer",
    "rewards.adjusted": "Changed stamps or credit",
    "voucher.sold": "Sold a gift voucher",
    "voucher.voided": "Cancelled a gift voucher",
    "closed_day.added": "Marked a day closed",
    "closed_day.removed": "Opened a closed day",
    "email.retried": "Sent an email again",
    "settings.catalog": "Changed prices and packages",
    "settings.hours": "Changed opening hours and times",
    "settings.business": "Changed business details"
  };
  const LOG_STEP = 40;

  // "staff.added" → "Added staff"; anything new still reads sensibly.
  function readable(action){
    if (ACTIONS[action]) return ACTIONS[action];
    const [thing, verb] = String(action || "").split(".");
    if (thing === "settings") return "Changed settings";
    const s = [verb, thing].filter(Boolean).join(" ").replace(/_/g, " ").trim();
    return s ? s[0].toUpperCase() + s.slice(1) : "Made a change";
  }
  // "Today, 3:00pm" reads better as "today, 3:00pm" in the middle of a sentence.
  const lowerDay = s => s.replace(/^(Today|Yesterday|Tomorrow)/, w => w.toLowerCase());

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

  async function editPerson(p){
    const isNew = !p;
    const email = el("input", { type: "email", required: true, autocomplete: "off", value: p ? p.email : "" });
    const name = el("input", { required: true, maxlength: 60, autocomplete: "off", value: p ? p.name : "" });
    const role = select([["crew", "Crew"], ["owner", "Owner"]], p ? p.role : "crew");
    const roleHint = el("span", { class: "dim small", text: ROLE_HINT[role.value] });
    const alerts = el("input", { type: "checkbox", checked: p ? !!p.alerts : false });
    let touched = !isNew;
    alerts.addEventListener("change", () => { touched = true; });
    role.addEventListener("change", () => {
      roleHint.textContent = ROLE_HINT[role.value];
      if (!touched) alerts.checked = role.value === "owner";
    });
    return formDialog(isNew ? "Add someone" : `Edit ${p.name}`, [
      field("Email", email, "They sign in with this."),
      field("Name", name),
      el("div", { class: "field" }, el("label", { text: "Role" }), role, roleHint),
      el("label", { class: "check" }, alerts, "Email me new bookings and messages")
    ], isNew ? "Add" : "Save", () => rpc("team_save", {
      id: p ? p.id : undefined, email: email.value.trim(), name: name.value.trim(), role: role.value, alerts: alerts.checked
    }));
  }

  async function passwordLink(p){
    let out;
    try { out = await act(null, () => rpc("team_link", { id: p.id })); }
    catch { return; }
    const link = el("textarea", { class: "t-link", readonly: true, rows: 4, "aria-label": "Password link",
      on: { focus: e => e.target.select() } });
    link.value = out.link;
    const copy = el("button", { class: "btn btn-primary btn-block", type: "button", on: { click: async () => {
      try {
        await navigator.clipboard.writeText(out.link);
        copy.textContent = "Copied";
        toast("Link copied.");
      } catch {
        link.focus();
        link.select();
        toast("Couldn't copy. Press and hold the link, then copy it.", true);
      }
    } } }, "Copy link");
    await dialog(`Password link for ${p.name}`, [
      el("div", { class: "alert", text: "Send it to them privately. It works once, for 7 days." }),
      el("p", { class: "muted small", text: p.hasPassword
        ? "They already have a password. This link lets them pick a new one."
        : "They open it, pick a password, and then they can sign in." }),
      link, copy
    ], []);
  }

  function personRow(p, me, reload){
    const isMe = !!(p.email && me.email && p.email.toLowerCase() === me.email.toLowerCase());
    return el("div", { class: "item t-row" },
      el("div", { class: "item-top" },
        el("div", { class: "left" },
          el("h3", { text: p.name + (isMe ? " (you)" : "") }),
          el("div", { class: "meta", text: p.email }),
          el("div", { class: "meta", text: p.lastSignIn ? `Last signed in ${lowerDay(fmt.when(p.lastSignIn))}` : "Has not signed in yet" }),
          el("div", { class: "meta", text: p.alerts ? "Gets emails about new bookings and messages" : "No emails about bookings or messages" })),
        el("div", { class: "right" },
          el("span", { class: p.role === "owner" ? "pill st-confirmed" : "pill soft", text: ROLE[p.role] || p.role }),
          p.hasPassword ? null : el("span", { class: "pill owing", text: "No password yet" }))),
      el("div", { class: "acts" },
        el("button", { class: "btn", type: "button", on: { click: async () => {
          if (await editPerson(p)) { toast("Saved."); reload(); }
        } } }, "Edit"),
        el("button", { class: "btn", type: "button", on: { click: () => passwordLink(p) } }, "Password link"),
        isMe ? null : el("button", { class: "btn btn-danger", type: "button", on: { click: async e => {
          const btn = e.currentTarget;
          if (!await confirm(`Remove ${p.name}?`, "They won't be able to sign in to the back office any more. What they did stays in the records.", "Remove", true)) return;
          try { await act(btn, () => rpc("team_remove", { id: p.id }), `${p.name} removed.`); }
          catch { return; }
          reload();
        } } }, "Remove")));
  }

  function logItem(a){
    return el("li", {},
      el("time", { text: fmt.when(a.created_at) }),
      el("div", {},
        el("div", { class: "what", text: readable(a.action) }),
        el("div", { class: "dim small detail", text: [a.detail, a.actor_name ? `by ${a.actor_name}` : null].filter(Boolean).join(" · ") })));
  }

  async function render(main, me){
    const [team, log] = await Promise.all([rpc("team_list"), rpc("audit_list")]);
    const reload = async () => {
      const y = window.scrollY;
      try { await render(main, me); window.scrollTo(0, y); }
      catch (e) { toast(e.message, true); }
    };
    clear(main);

    main.append(el("div", { class: "o-title" },
      el("div", {}, el("h1", { text: "Staff" }), el("div", { class: "sub", text: "Who can sign in to the back office." })),
      el("button", { class: "btn btn-primary", type: "button", on: { click: async () => {
        const out = await editPerson(null);
        if (!out) return;
        toast("Added.");
        await reload();
        const fresh = await rpc("team_list").catch(() => []);
        const p = fresh.find(x => x.id === out.id);
        if (p && !p.hasPassword && await confirm("Make a password link now?", `${p.name} needs one to sign in.`, "Make link")) {
          await passwordLink(p);
          reload();
        }
      } } }, "+ Add someone")));

    main.append(el("div", { class: "card" },
      el("h2", { text: "Who sees what" }),
      el("ul", { class: "t-roles" },
        el("li", {}, el("b", { text: "Owners: " }), "see everything."),
        el("li", {}, el("b", { text: "Crew: " }), "see jobs, customers and messages, not money, reports or settings."))));

    const people = el("div", { class: "list" });
    if (!team.length) people.append(empty("No one yet."));
    team.forEach(p => people.append(personRow(p, me, reload)));
    main.append(el("div", { class: "card" },
      el("h2", {}, "People", el("small", { text: `${team.length} ${team.length === 1 ? "person" : "people"}` })), people));

    const tl = el("ul", { class: "tl t-log" });
    const more = el("button", { class: "btn btn-ghost btn-block", type: "button", style: "margin-top:.8rem" }, "Show more");
    let shown = 0;
    const showMore = () => {
      log.slice(shown, shown + LOG_STEP).forEach(a => tl.append(logItem(a)));
      shown = Math.min(log.length, shown + LOG_STEP);
      more.classList.toggle("hide", shown >= log.length);
    };
    more.addEventListener("click", showMore);
    showMore();
    main.append(el("div", { class: "card" },
      el("h2", {}, "Activity", el("small", { text: "who changed what" })),
      log.length ? tl : empty("Nothing yet. Changes to staff, customers, rewards, vouchers and settings show here."),
      log.length ? more : null));
  }

  Office.start({ page: "team", title: "Staff", owner: true, render });
})();
