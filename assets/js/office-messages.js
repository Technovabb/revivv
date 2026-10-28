/* Back office: Messages (staff-messages.html, ?c=<customer id> opens one).
   One conversation per customer. Phones show the list OR the conversation;
   wide screens show both side by side. Refreshes every 20 seconds. */
(() => {
  const { el, clear, rpc, fmt, empty, loading, waLink, act, param, select, refreshBadge } = Office;
  const WIDE = window.matchMedia("(min-width: 900px)");
  const EVERY = 20_000;
  const tel = phone => `tel:${String(phone).replace(/[^\d+]/g, "")}`;

  async function render(main){
    let all = false;          // show booking updates in the list too
    let inbox = null;         // the list of conversations (null until loaded)
    let openId = null;        // the customer whose conversation is open
    let thread = null;        // { customer, messages, open }
    let shownSig = "";        // which messages are on screen, to skip redraws
    let sending = false;
    const drafts = {};        // unsent text, per customer

    const toggle = el("input", { type: "checkbox", on: { change: () => { all = toggle.checked; loadInbox(true); } } });
    const inboxList = el("div", { class: "list" });
    const inboxPane = el("section", { class: "m-inbox", "aria-label": "Conversations" },
      el("div", { class: "m-tools" },
        el("label", { class: "check" }, toggle, "Show booking updates too"),
        el("p", { class: "dim small", style: "margin:.2rem 0 .8rem" }, "To write to someone new, open them in ",
          el("a", { href: "staff-customers.html", text: "Customers" }), " and tap Message.")),
      inboxList);
    const convo = el("section", { class: "m-convo card", "aria-label": "Conversation" });
    const root = el("div", { class: "m-page" },
      el("div", { class: "o-title" },
        el("div", {}, el("h1", { text: "Messages" }), el("div", { class: "sub", text: "One conversation per customer." }))),
      el("div", { class: "m-cols" }, inboxPane, convo));
    main.append(root);

    // the composer is kept between conversations; its contents are swapped
    const box = el("textarea", { rows: 1, maxlength: 2000, placeholder: "Write a message…", "aria-label": "Your message", enterkeyhint: "send" });
    const sendBtn = el("button", { class: "btn btn-primary", type: "button", on: { click: () => send() } }, "Send");
    const msgs = el("div", { class: "thread", "aria-live": "polite" });
    let about = null;
    box.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    box.addEventListener("input", grow);
    function grow(){
      box.style.height = "auto";
      box.style.height = Math.min(Math.max(box.scrollHeight + 2, 48), 160) + "px";
    }

    /* ---------- the list ---------- */
    function inboxRow(t){
      const from = t.lastFrom === "staff" ? "Revivv: " : t.lastFrom === "system" ? "Update: " : "";
      const sel = t.customerId === openId;
      return el("a", {
        class: "item m-row" + (t.unread ? " unread" : "") + (sel ? " sel" : ""),
        href: `?c=${t.customerId}`, "aria-current": sel ? "true" : null,
        on: { click: e => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // let "open in new tab" work
          e.preventDefault();
          if (t.customerId !== openId) openThread(t.customerId, true);
          else if (!WIDE.matches) window.scrollTo(0, 0);
        } }
      },
        el("div", { class: "item-top" },
          el("h3", {}, t.name, t.unread ? el("span", { class: "badge", text: String(t.unread), "aria-label": `${t.unread} unread` }) : null),
          el("time", { text: fmt.when(t.at) })),
        el("div", { class: "meta prev", text: from + t.last }));
    }

    function drawInbox(){
      if (!inbox) return;     // still loading
      clear(inboxList, inbox.length ? inbox.map(inboxRow)
        : empty(all ? "No messages yet." : "No messages from customers yet. Tick 'Show booking updates too' to see booking news."));
    }

    let inboxSeq = 0;
    async function loadInbox(showLoading){
      const n = ++inboxSeq;
      if (showLoading) loading(inboxList);
      try {
        const rows = await rpc("staff_inbox", { all });
        if (n !== inboxSeq) return;
        inbox = rows;
        drawInbox();
      } catch (e) {
        if (n === inboxSeq && (showLoading || !inbox)) clear(inboxList, el("div", { class: "alert bad", text: e.message }));
      }
    }

    /* ---------- one conversation ---------- */
    function backButton(){
      return el("button", { class: "btn btn-ghost m-back", type: "button", on: { click: goBack } }, "← All messages");
    }

    function bubble(m){
      const cls = m.sender === "staff" ? "me" : m.sender === "customer" ? "them" : "sys";
      return el("div", { class: `bubble ${cls}` },
        m.body,
        el("small", {},
          cls === "me" && m.name ? [el("span", { class: "who", text: m.name }), " · "] : null,
          fmt.when(m.at),
          m.ref ? [" · ", el("a", { href: `staff-booking.html?ref=${encodeURIComponent(m.ref)}`, text: m.ref })] : null));
    }

    function drawMessages(force){
      const list = thread.messages;
      const sig = `${list.length}:${list.length ? list[list.length - 1].id : 0}`;
      if (!force && sig === shownSig) return;
      shownSig = sig;
      const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
      clear(msgs, list.length ? list.map(bubble) : empty("No messages yet. Write the first one below."));
      if (force || nearBottom) msgs.scrollTop = msgs.scrollHeight;
    }

    function drawConvo(){
      const c = thread.customer;
      const wa = waLink(c.phone);
      about = thread.open.length
        ? select([["", "Not about a booking"], ...thread.open.map(b => [b.ref, b.text])], "")
        : null;
      box.value = drafts[c.id] || "";
      clear(convo,
        backButton(),
        el("div", { class: "m-head" },
          el("div", { style: "min-width:0" },
            el("h2", {}, el("a", { href: `staff-customer.html?id=${c.id}`, text: c.name })),
            c.phone ? el("div", { class: "meta small muted", text: c.phone }) : null),
          el("div", { class: "acts" },
            c.phone ? el("a", { class: "btn", href: tel(c.phone) }, "Call") : null,
            wa ? el("a", { class: "btn", href: wa, target: "_blank", rel: "noopener" }, "WhatsApp") : null)),
        msgs,
        about ? el("div", { class: "field m-about" }, el("label", { text: "About booking" }), about) : null,
        el("div", { class: "composer" }, box, sendBtn),
        el("p", { class: "dim small m-note", text: c.email
          ? "They get an email when you write, at most one every 10 minutes."
          : "They have no email on file, so they won't be told about this. Call or WhatsApp them too." }));
      shownSig = "";
      drawMessages(true);
      grow();
    }

    function closeThread(){
      if (openId) drafts[openId] = box.value;
      openId = null;
      thread = null;
      root.classList.remove("open");
      clear(convo, el("p", { class: "m-pick", text: "Pick a conversation." }));
      drawInbox();
    }

    let threadSeq = 0;
    async function openThread(id, push){
      id = Number(id);
      if (openId) drafts[openId] = box.value;
      if (push) {
        const url = `${location.pathname}?c=${id}`;
        if (WIDE.matches && history.state && history.state.c) history.replaceState({ c: id }, "", url);
        else history.pushState({ c: id }, "", url);
      }
      openId = id;
      thread = null;
      const n = ++threadSeq;
      root.classList.add("open");
      drawInbox();
      clear(convo, backButton(), el("p", { class: "loading", text: "Loading…" }));
      if (!WIDE.matches) window.scrollTo(0, 0);
      let t;
      try {
        t = await rpc("staff_thread", { customer_id: id });
      } catch (e) {
        if (n === threadSeq) clear(convo, backButton(), el("div", { class: "alert bad", text: e.message }));
        return;
      }
      if (n !== threadSeq) return;   // another conversation was picked meanwhile
      thread = t;
      drawConvo();
      if (WIDE.matches) box.focus();
      const row = inbox && inbox.find(x => x.customerId === id);
      if (row && row.unread) { row.unread = 0; drawInbox(); }
      refreshBadge();
    }

    function goBack(){
      if (history.state && history.state.c) history.back();   // we opened it from the list
      else { history.replaceState(null, "", location.pathname); closeThread(); }
    }
    window.addEventListener("popstate", () => {
      const c = param("c");
      if (/^\d+$/.test(c || "")) { if (Number(c) !== openId) openThread(c, false); }
      else closeThread();
    });

    async function send(){
      const body = box.value.trim();
      if (!body) { box.focus(); return; }
      if (sending || !thread) return;
      sending = true;
      const id = openId;
      try {
        const out = await act(sendBtn, () => rpc("staff_send", { customer_id: id, body, ref: (about && about.value) || undefined }));
        drafts[id] = "";
        if (openId !== id) return;
        box.value = "";
        grow();
        thread.messages = out.messages;
        drawMessages(true);
        box.focus();
        loadInbox();
      } catch { /* act() has shown the problem; the text stays in the box */ }
      finally { sending = false; }
    }

    /* ---------- keep it fresh ---------- */
    let polling = false;
    async function poll(){
      if (polling || document.visibilityState !== "visible") return;
      polling = true;
      try {
        if (openId && thread) {
          const id = openId;
          const t = await rpc("staff_thread", { customer_id: id }).catch(() => null);
          if (t && openId === id && thread) {
            const before = shownSig;
            thread.messages = t.messages;
            drawMessages(false);
            if (shownSig !== before) refreshBadge();
          }
        }
        await loadInbox();
      } finally {
        polling = false;
      }
    }
    setInterval(poll, EVERY);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });

    /* ---------- start ---------- */
    loading(inboxList);
    const first = param("c");
    if (/^\d+$/.test(first || "")) await openThread(first, false);
    else closeThread();
    await loadInbox();
  }

  Office.start({ page: "messages", title: "Messages", render });
})();
