/* ===== My account (my-account.html): details, reminders, password, sign out ===== */
(() => {
  "use strict";
  const M = window.my;
  const { el, $, say, call, errText } = M;
  const api = window.revivvApi;
  const root = $("myRoot");
  const PARISHES = ["St. Michael", "Christ Church", "St. James", "St. Thomas", "St. George", "St. Philip",
    "St. Peter", "St. Lucy", "St. Andrew", "St. Joseph", "St. John"];

  const field = (id, label, input, extra) => el("div", { class: "field" },
    el("label", { for: id }, label, extra ? el("span", { class: "optional", text: " " + extra }) : null), input);

  function detailsForm(a, email) {
    const name = el("input", { id: "aName", type: "text", maxlength: "100", autocomplete: "name", value: a.name || "" });
    const phone = el("input", { id: "aPhone", type: "tel", maxlength: "40", autocomplete: "tel", placeholder: "246 000 0000", value: a.phone || "" });
    const mail = el("input", { id: "aEmail", type: "email", value: email, readOnly: true, "aria-describedby": "aEmailHint" });
    const address = el("input", { id: "aAddress", type: "text", maxlength: "300", autocomplete: "street-address", placeholder: "Street, or a landmark", value: a.address || "" });
    const parish = el("select", { id: "aParish" },
      el("option", { value: "", text: "Pick a parish" }),
      PARISHES.concat(a.parish && !PARISHES.includes(a.parish) ? [a.parish] : [])
        .map(p => el("option", { value: p, text: p, selected: p === a.parish })));
    const reminders = el("input", { id: "aRemind", type: "checkbox", checked: a.reminders !== false });
    const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
    const save = el("button", { class: "btn btn-primary my-wide", type: "submit" }, "Save my details");

    const f = el("form", { class: "card my-form", novalidate: true, "aria-labelledby": "detailsTitle" },
      el("h2", { class: "card-h", id: "detailsTitle", text: "Your details" }),
      field("aName", "Name", name),
      field("aPhone", "Phone", phone),
      field("aEmail", "Email", mail),
      el("p", { class: "hint", id: "aEmailHint", text: "This is the email you sign in with. To change it, message us." }),
      field("aAddress", "Address for mobile visits", address, "(optional)"),
      field("aParish", "Parish", parish, "(optional)"),
      el("label", { class: "check", for: "aRemind" }, reminders,
        el("span", null, "Email me when it's time for my next detail",
          el("small", { text: "A short note some weeks after your last detail. Emails about your bookings still come either way." }))),
      msg, save);

    f.addEventListener("submit", async e => {
      e.preventDefault();
      if (!name.value.trim()) { say(msg, "Please enter your name.", "err"); name.focus(); return; }
      if (phone.value.trim() && phone.value.replace(/\D/g, "").length < 7) { say(msg, "That phone number looks too short.", "err"); phone.focus(); return; }
      save.disabled = true; say(msg, "Saving…");
      const r = await call("my_settings_save", {
        name: name.value.trim(), phone: phone.value.trim(), address: address.value.trim(),
        parish: parish.value, reminders: reminders.checked
      });
      save.disabled = false;
      say(msg, r.error ? errText(r) : "Saved.", r.error ? "err" : "ok");
    });
    return f;
  }

  function passwordForm() {
    const p1 = el("input", { id: "aPass", type: "password", autocomplete: "new-password", minlength: "8" });
    const p2 = el("input", { id: "aPass2", type: "password", autocomplete: "new-password", minlength: "8" });
    const show = el("input", { id: "aShow", type: "checkbox" });
    show.addEventListener("change", () => { p1.type = p2.type = show.checked ? "text" : "password"; });
    const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
    const save = el("button", { class: "btn btn-ghost my-wide", type: "submit" }, "Change password");
    const f = el("form", { class: "card my-form", novalidate: true, "aria-labelledby": "passTitle" },
      el("h2", { class: "card-h", id: "passTitle" }, "Change password", el("small", { text: "At least 8 characters." })),
      field("aPass", "New password", p1),
      field("aPass2", "Type it again", p2),
      el("label", { class: "check", for: "aShow" }, show, el("span", { text: "Show passwords" })),
      msg, save);
    f.addEventListener("submit", async e => {
      e.preventDefault();
      if (p1.value.length < 8) { say(msg, "Use at least 8 characters.", "err"); p1.focus(); return; }
      if (p1.value !== p2.value) { say(msg, "Those two passwords don't match.", "err"); p2.focus(); return; }
      save.disabled = true; say(msg, "Saving…");
      const r = await api.auth.updateUser({ password: p1.value });
      save.disabled = false;
      if (r.error) { say(msg, errText(r), "err"); return; }
      p1.value = p2.value = "";
      say(msg, "Password changed. Any other phones or computers you were signed in on are now signed out.", "ok");
    });
    return f;
  }

  function signOutCard() {
    const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
    const btn = el("button", { class: "btn btn-danger my-wide", type: "button" }, "Sign out");
    btn.addEventListener("click", async () => {
      btn.disabled = true; say(msg, "Signing out…");
      const r = await api.auth.signOut();
      if (r.error && M.isDown(r)) { btn.disabled = false; say(msg, errText(r), "err"); return; }
      location.href = "portal.html";
    });
    return el("section", { class: "card", "aria-labelledby": "outTitle" },
      el("h2", { class: "card-h", id: "outTitle", text: "Sign out" }),
      el("p", { class: "hint", text: "Sign out on a phone or computer you share with other people." }),
      btn, msg);
  }

  async function load() {
    const user = await M.start({ root, why: "Sign in to see your account." });
    if (!user) return;
    const r = await M.account();
    if (r.error) { root.replaceChildren(M.errorPanel(r)); return; }
    const a = r.data || {};      // null when this email hasn't booked yet; saving makes the record
    root.replaceChildren(
      el("div", { class: "my-head" },
        el("h1", { class: "title", text: "My account" }),
        el("p", { text: a.since ? "Customer since " + a.since + "." : "Your details help us reach you about your bookings." })),
      detailsForm(a, a.email || user.email || ""),
      passwordForm(),
      signOutCard());
  }

  load().catch(err => { console.error(err); root.replaceChildren(M.errorPanel({ error: { message: "Something went wrong. Please reload the page." }, status: 400 })); });
})();
