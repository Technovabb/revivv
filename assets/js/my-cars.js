/* ===== My cars (my-cars.html): saved vehicles, add / edit / remove ===== */
(() => {
  "use strict";
  const M = window.my;
  const { el, $, say, call, errText } = M;
  const root = $("myRoot");
  const TYPES = [["Car", "Sedan · hatch"], ["SUV", "4×4 · van"], ["Truck", "Pickup"]];

  let cars = [];
  let editing = null;      // the id of the car being edited, "new" while adding, or null
  let list, formSlot, addBtn, top;
  let n = 0;

  function field(id, label, input, optional) {
    return el("div", { class: "field" },
      el("label", { for: id }, label, optional ? el("span", { class: "optional", text: " (optional)" }) : null),
      input);
  }

  // The add / edit form. car = null for a new one.
  function form(car) {
    const id = "car" + (++n);
    const typeNow = car ? car.type : "Car";
    const types = el("fieldset", { class: "my-fieldset" },
      el("legend", { text: "Type" }),
      el("div", { class: "opts v3" },
        TYPES.map(([t, sub]) => el("label", { class: "opt" },
          el("input", { type: "radio", name: id + "-type", value: t, checked: t === typeNow }),
          el("span", null, t, el("em", { text: sub }))))));
    const val = k => (car && car[k]) || "";
    const desc = el("input", { id: id + "-desc", type: "text", maxlength: "120", autocomplete: "off", placeholder: "e.g. Toyota Corolla", value: val("description") });
    const colour = el("input", { id: id + "-colour", type: "text", maxlength: "40", autocomplete: "off", placeholder: "e.g. Silver", value: val("colour") });
    const plate = el("input", { id: id + "-plate", type: "text", maxlength: "20", autocomplete: "off", placeholder: "e.g. P 1234", value: val("plate") });
    const notes = el("textarea", { id: id + "-notes", maxlength: "300", placeholder: "e.g. Child seat in the back, roof rack", value: val("notes") });
    const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
    const save = el("button", { class: "btn btn-primary", type: "submit" }, car ? "Save changes" : "Save car");
    const cancel = el("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
    const f = el("form", { class: "card my-form", novalidate: true, "aria-label": car ? "Edit car" : "Add a car" },
      el("h2", { class: "card-h", text: car ? "Edit car" : "Add a car" }),
      types,
      field(id + "-desc", "Make and model", desc),
      field(id + "-colour", "Colour", colour, true),
      field(id + "-plate", "Number plate", plate, true),
      field(id + "-notes", "Notes for our team", notes, true),
      msg,
      el("div", { class: "my-actions" }, save, cancel));

    cancel.addEventListener("click", () => {
      const was = editing;
      editing = null;
      renderList();
      if (was === "new") addBtn.focus(); else focusCar(was);
    });
    f.addEventListener("submit", async e => {
      e.preventDefault();
      const checked = f.querySelector("input[type=radio]:checked");
      const description = desc.value.trim();
      if (!description) { say(msg, "Add the make and model, e.g. Toyota Corolla.", "err"); desc.focus(); return; }
      save.disabled = true; say(msg, "Saving…");
      const r = await call("my_vehicle_save", {
        id: car ? car.id : undefined, type: checked ? checked.value : "Car", description,
        colour: colour.value.trim(), plate: plate.value.trim(), notes: notes.value.trim()
      });
      save.disabled = false;
      if (r.error) { say(msg, errText(r), "err"); return; }
      editing = null;
      reload(car ? "Saved." : "Car added.");
    });
    setTimeout(() => desc.focus(), 0);
    return f;
  }

  function card(car) {
    const c = el("section", { class: "card car", "aria-label": car.description || car.type });
    const msg = el("p", { class: "msg", role: "status", "aria-live": "polite" });
    const meta = [car.type, car.colour, car.plate ? "Plate " + car.plate : ""].filter(Boolean).join(" · ");
    const count = Number(car.details) || 0;
    const actions = el("div", { class: "my-actions" });
    const editBtn = el("button", { class: "btn btn-ghost btn-sm2", type: "button" }, "Edit");
    const removeBtn = el("button", { class: "btn btn-danger btn-sm2", type: "button" }, "Remove");
    const normal = () => { actions.replaceChildren(editBtn, removeBtn); };

    editBtn.addEventListener("click", () => { editing = car.id; top.replaceChildren(); renderList(); });
    removeBtn.addEventListener("click", () => {
      actions.replaceChildren(
        el("p", { class: "my-wide", text: "Remove " + (car.description || "this car") + "? Your past bookings stay as they are." }),
        el("button", { class: "btn btn-danger solid btn-sm2", type: "button", on: { click: remove } }, "Yes, remove"),
        el("button", { class: "btn btn-ghost btn-sm2", type: "button", on: { click: () => { normal(); removeBtn.focus(); } } }, "Keep it"));
      actions.lastElementChild.focus();
    });
    async function remove(e) {
      actions.querySelectorAll("button").forEach(b => { b.disabled = true; });
      e.target.textContent = "Removing…";
      const r = await call("my_vehicle_remove", { id: car.id });
      if (r.error) { normal(); say(msg, errText(r), "err"); return; }
      reload("Removed " + (car.description || "the car") + ".");
    }

    normal();
    c.dataset.id = car.id;
    M.add(c, [
      el("p", { class: "car-name", text: car.description || car.type }),
      el("p", { class: "car-meta", text: meta }),
      car.notes ? el("p", { class: "car-notes", text: car.notes }) : null,
      el("p", { class: "hint", text: count ? count + " finished detail" + (count === 1 ? "" : "s") + " with us" : "No finished details yet" }),
      actions, msg]);
    return c;
  }

  function focusCar(id) {
    const b = list.querySelector('[data-id="' + Number(id) + '"] button');
    if (b) b.focus();
  }

  function renderList() {
    list.replaceChildren(...(cars.length
      ? cars.map(car => (editing === car.id ? form(car) : card(car)))
      : [el("p", { class: "my-empty", text: "No cars saved yet. Add one so we know what we're working on." })]));
    formSlot.replaceChildren(...(editing === "new" ? [form(null)] : []));
    addBtn.hidden = editing === "new";
  }

  async function reload(note) {
    const r = await call("my_vehicles");
    if (r.error) { top.replaceChildren(el("p", { class: "msg err", role: "status", text: errText(r) })); return; }
    cars = r.data || [];
    renderList();
    top.replaceChildren(...(note ? [el("p", { class: "my-alert ok", role: "status", text: note })] : []));
  }

  async function load() {
    const user = await M.start({ root, why: "Sign in to see your saved cars." });
    if (!user) return;
    const r = await call("my_vehicles");
    if (r.error) { root.replaceChildren(M.errorPanel(r)); return; }
    cars = r.data || [];

    top = el("div");
    list = el("div", { class: "car-list" });
    formSlot = el("div");
    addBtn = el("button", { class: "btn btn-primary my-wide", type: "button" }, "Add a car");
    addBtn.addEventListener("click", () => { editing = "new"; top.replaceChildren(); renderList(); });
    root.replaceChildren(
      el("div", { class: "my-head" },
        el("h1", { class: "title", text: "My cars" }),
        el("p", { text: "Save your cars here, so our team knows what we're working on." })),
      top, list, formSlot, el("div", { class: "my-actions" }, addBtn));
    renderList();
  }

  load().catch(err => { console.error(err); root.replaceChildren(M.errorPanel({ error: { message: "Something went wrong. Please reload the page." }, status: 400 })); });
})();
