
/* Revivv's own server: assets/js/api.js */
const sb = window.revivvApi;

const SLOT_LABEL = {
  priority:"Priority · 7–9am", morning:"Morning · 8am–12pm",
  afternoon:"Afternoon · 12–4pm", late:"Late · 4–6pm"
};

const gate    = document.getElementById("gate");
const board   = document.getElementById("board");
const emailIn = document.getElementById("email");
const passIn  = document.getElementById("pass");
const gateBtn = document.getElementById("gateBtn");
const gateMsg = document.getElementById("gateMsg");
const jobsEl  = document.getElementById("jobs");
const datePick= document.getElementById("datePick");

let day = new Date();

const isoOf  = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const pretty = d => d.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});

/* ---------- sign in ----------
   Password, not an emailed code. Staff are a handful of known people with
   accounts you created by hand — there's no reason to make them wait on email,
   and it means the crew can sign in with no mail service configured at all. */
async function gateAction(){
  gateMsg.className = "msg"; gateMsg.textContent = "";
  gateBtn.disabled = true; gateBtn.textContent = "Signing in…";
  try{
    const { error } = await sb.auth.signInWithPassword({
      email: emailIn.value.trim(),
      password: passIn.value
    });
    if (error) throw new Error("Wrong email or password.");
    await enter();
  } catch(err){
    gateMsg.className = "msg err";
    gateMsg.textContent = err.message;
  } finally {
    gateBtn.disabled = false; gateBtn.textContent = "Sign in";
  }
}

gateBtn.addEventListener("click", gateAction);

const EYE_OPEN   = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
const EYE_CLOSED = '<path d="M2 12s3.6-7 10-7c2 0 3.7.7 5.1 1.6M22 12s-3.6 7-10 7c-2 0-3.7-.7-5.1-1.6"/><path d="m3 3 18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
document.getElementById("staffEye").addEventListener("click", e => {
  const btn = e.currentTarget, hidden = passIn.type === "password";
  passIn.type = hidden ? "text" : "password";
  btn.querySelector("svg").innerHTML = hidden ? EYE_CLOSED : EYE_OPEN;
  btn.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  passIn.focus();
});
emailIn.addEventListener("keydown", e => { if (e.key === "Enter") passIn.focus(); });
passIn .addEventListener("keydown", e => { if (e.key === "Enter") gateAction(); });

/* Being in the staff table is the ONLY thing that makes someone staff. */
async function enter(){
  const { data: staffRow } = await sb.staffMe();
  if (!staffRow){
    gateMsg.className = "msg err";
    gateMsg.textContent = "That account isn't staff. Ask to be added.";
    await sb.auth.signOut();
    return;
  }
  gate.classList.add("hide");
  board.classList.remove("hide");
  document.getElementById("hdRight").innerHTML =
    `<span class="who">${staffRow.name || "Staff"}</span> · <button class="link" id="out">Sign out</button>`;
  document.getElementById("out").addEventListener("click", async () => {
    await sb.auth.signOut(); location.reload();
  });
  load();
}

/* ---------- the day's jobs ---------- */
async function load(){
  const iso = isoOf(day);
  document.getElementById("dayLabel").textContent = pretty(day);
  datePick.value = iso;
  jobsEl.innerHTML = `<p class="empty">Loading…</p>`;

  const { data, error } = await sb.rpc("staff_day", { d: iso });
  if (error){
    jobsEl.innerHTML = `<div class="warn">Couldn't load: ${error.message}</div>`;
    return;
  }

  const jobs  = data || [];
  const live  = jobs.filter(j => j.status !== "cancelled");
  const done  = jobs.filter(j => j.status === "completed");
  const money = live.reduce((s,j) => s + Number(j.total), 0);

  document.getElementById("tJobs").textContent  = live.length;
  document.getElementById("tDone").textContent  = done.length;
  document.getElementById("tMoney").textContent = "$" + money.toFixed(0);

  if (!jobs.length){
    jobsEl.innerHTML = `<p class="empty">Nothing booked.</p>`;
    return;
  }

  jobsEl.innerHTML = jobs.map(j => {
    const isDone = j.status === "completed";
    const isOff  = j.status === "cancelled";
    const cls    = isDone ? " done" : isOff ? " cancelled" : "";
    const tag    = isDone ? `<span class="tag done">Done</span>`
                 : isOff  ? `<span class="tag cancelled">Cancelled</span>`
                 : `<span class="tag">${j.status}</span>`;
    const maps   = j.address
      ? `<a href="https://maps.google.com/?q=${encodeURIComponent(j.address + ", " + (j.parish||"") + ", Barbados")}" target="_blank" rel="noopener">${j.address}</a>`
      : "—";

    return `<article class="job${cls}" data-id="${j.id}">
      <div class="job-top">
        <div>
          <p class="slot">${SLOT_LABEL[j.slot] || j.slot}</p>
          <h3>${j.name}</h3>
          <p class="pkg">${j.package}${j.addons ? " + " + j.addons : ""}</p>
        </div>
        <div style="text-align:right">
          <p class="money">$${Number(j.total).toFixed(0)}</p>
          ${tag}
        </div>
      </div>
      <div class="rows">
        <p class="row"><span>Phone</span><a href="tel:${j.phone}">${j.phone}</a></p>
        <p class="row"><span>Vehicle</span><span>${j.vehicle || "—"}</span></p>
        <p class="row"><span>Where</span><span>${j.location || "—"}${j.parish ? " · " + j.parish : ""}</span></p>
        <p class="row"><span>Address</span><span>${maps}</span></p>
      </div>
      ${j.notes ? `<p class="note">${j.notes}</p>` : ""}
      ${(isDone || isOff) ? "" : `
      <div class="acts">
        <button class="done-btn"   data-act="complete" data-id="${j.id}">Mark complete</button>
        <button class="cancel-btn" data-act="cancel"   data-id="${j.id}">Cancel</button>
      </div>`}
    </article>`;
  }).join("");
}

/* Marking complete is what awards the stamp — a finished job, not a booking.
   Otherwise people farm free washes with bookings they never turn up to. */
jobsEl.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;

  if (act === "cancel" && !confirm("Cancel this booking? The slot goes back on sale.")) return;
  if (act === "complete" && !confirm("Mark complete? This awards the customer their stamp.")) return;

  btn.disabled = true;
  btn.textContent = "…";
  const fn = act === "complete" ? "complete_booking" : "cancel_booking";
  const { error } = await sb.rpc(fn, { p_booking: id });
  if (error){ alert(error.message); btn.disabled = false; }
  load();
});

/* ---------- month view ---------- */
const dayPane   = document.getElementById("dayPane");
const weekPane  = document.getElementById("weekPane");
const monthPane = document.getElementById("monthPane");
const vDay      = document.getElementById("vDay");
const vWeek     = document.getElementById("vWeek");
const vMonth    = document.getElementById("vMonth");
const wGrid     = document.getElementById("wGrid");
const mGrid     = document.getElementById("mGrid");

let wDate = new Date();   // any day inside the week being shown
let mDate = new Date();   // any day inside the month being shown

const SLOT_SHORT = { priority:"7–9am", morning:"8–12", afternoon:"12–4", late:"4–6" };

function showView(which){
  dayPane  .classList.toggle("hide", which !== "day");
  weekPane .classList.toggle("hide", which !== "week");
  monthPane.classList.toggle("hide", which !== "month");
  vDay  .classList.toggle("on", which === "day");
  vWeek .classList.toggle("on", which === "week");
  vMonth.classList.toggle("on", which === "month");
  if (which === "week")  loadWeek();
  if (which === "month") loadMonth();
}
vDay  .addEventListener("click", () => showView("day"));
vWeek .addEventListener("click", () => showView("week"));
vMonth.addEventListener("click", () => showView("month"));

/* Monday of whatever week the given date falls in */
function mondayOf(d){
  const m = new Date(d);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  m.setHours(0,0,0,0);
  return m;
}

async function loadWeek(){
  const mon = mondayOf(wDate);
  const sun = new Date(mon); sun.setDate(sun.getDate() + 6);

  document.getElementById("wLabel").textContent =
    mon.getMonth() === sun.getMonth()
      ? `${mon.getDate()}–${sun.getDate()} ${mon.toLocaleDateString("en-GB",{month:"long"})}`
      : `${mon.getDate()} ${mon.toLocaleDateString("en-GB",{month:"short"})} – ${sun.getDate()} ${sun.toLocaleDateString("en-GB",{month:"short"})}`;

  wGrid.innerHTML = `<p class="empty" style="grid-column:1/-1">Loading…</p>`;

  const { data, error } = await sb.rpc("staff_range", { d_from: isoOf(mon), d_to: isoOf(sun) });
  if (error){
    wGrid.innerHTML = `<div class="warn" style="grid-column:1/-1">${error.message}</div>`;
    return;
  }

  const byDay = {};
  (data || []).forEach(j => (byDay[j.booking_date] ||= []).push(j));

  const live = (data||[]).filter(j => j.status !== "cancelled");
  document.getElementById("wJobs").textContent  = live.length;
  document.getElementById("wDone").textContent  = (data||[]).filter(j => j.status === "completed").length;
  document.getElementById("wMoney").textContent = "$" + live.reduce((s,j) => s + Number(j.total), 0).toFixed(0);

  const todayIso = isoOf(new Date());
  let out = "";

  for (let i = 0; i < 7; i++){
    const d    = new Date(mon); d.setDate(d.getDate() + i);
    const iso  = isoOf(d);
    const jobs = byDay[iso] || [];
    const cls  = ["wcol"];
    if (iso === todayIso) cls.push("today");
    if (iso <  todayIso)  cls.push("past");

    const body = jobs.length
      ? jobs.map(j => `<div class="wjob ${j.status === "completed" ? "done" : j.status === "cancelled" ? "cancelled" : ""}" data-iso="${iso}">
            <b>${j.name}</b>
            <span>${SLOT_SHORT[j.slot] || j.slot} · $${Number(j.total).toFixed(0)}</span>
          </div>`).join("")
      : `<p class="wempty">—</p>`;

    out += `<div class="${cls.join(" ")}">
        <div class="whead" data-iso="${iso}">
          <p class="dw">${d.toLocaleDateString("en-GB",{weekday:"short"})}</p>
          <p class="dn">${d.getDate()}</p>
        </div>
        ${body}
      </div>`;
  }
  wGrid.innerHTML = out;
}

wGrid.addEventListener("click", e => {
  const hit = e.target.closest("[data-iso]");
  if (!hit) return;
  day = new Date(hit.dataset.iso + "T00:00:00");
  showView("day");
  load();
});

document.getElementById("wPrev").addEventListener("click", () => {
  wDate.setDate(wDate.getDate() - 7); loadWeek();
});
document.getElementById("wNext").addEventListener("click", () => {
  wDate.setDate(wDate.getDate() + 7); loadWeek();
});
document.getElementById("wThis").addEventListener("click", () => {
  wDate = new Date(); loadWeek();
});

async function loadMonth(){
  const y = mDate.getFullYear(), m = mDate.getMonth();
  const first = new Date(y, m, 1);
  const last  = new Date(y, m + 1, 0);
  document.getElementById("mLabel").textContent =
    first.toLocaleDateString("en-GB",{month:"long", year:"numeric"});

  mGrid.innerHTML = `<p class="empty" style="grid-column:1/-1">Loading…</p>`;

  const { data, error } = await sb.rpc("staff_range", {
    d_from: isoOf(first), d_to: isoOf(last)
  });
  if (error){
    mGrid.innerHTML = `<div class="warn" style="grid-column:1/-1">${error.message}</div>`;
    return;
  }

  /* group by date so each cell only walks its own jobs */
  const byDay = {};
  (data || []).forEach(j => (byDay[j.booking_date] ||= []).push(j));

  const live  = (data||[]).filter(j => j.status !== "cancelled");
  const done  = (data||[]).filter(j => j.status === "completed");
  document.getElementById("mJobs").textContent  = live.length;
  document.getElementById("mDone").textContent  = done.length;
  document.getElementById("mMoney").textContent =
    "$" + live.reduce((s,j) => s + Number(j.total), 0).toFixed(0);

  const todayIso = isoOf(new Date());
  const offset   = (first.getDay() + 6) % 7;          // Monday-first
  let cells = ["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => `<div class="mdow">${d}</div>`).join("");

  for (let i = 0; i < offset; i++) cells += `<div class="mcell blank"></div>`;

  for (let d = 1; d <= last.getDate(); d++){
    const iso  = isoOf(new Date(y, m, d));
    const jobs = byDay[iso] || [];
    const cls  = ["mcell"];
    if (iso === todayIso) cls.push("today");
    if (iso < todayIso)   cls.push("past");

    const shown = jobs.slice(0,3).map(j =>
      `<span class="mjob ${j.status === "completed" ? "done" : j.status === "cancelled" ? "cancelled" : ""}">${j.name.split(" ")[0]}</span>`
    ).join("");
    const more = jobs.length > 3 ? `<span class="mmore">+${jobs.length - 3}</span>` : "";

    cells += `<button class="${cls.join(" ")}" data-iso="${iso}">
                <span class="n">${d}</span>${shown}${more}
              </button>`;
  }
  mGrid.innerHTML = cells;
}

/* tapping a day drops you into the day view for it */
mGrid.addEventListener("click", e => {
  const cell = e.target.closest(".mcell");
  if (!cell || cell.classList.contains("blank")) return;
  day = new Date(cell.dataset.iso + "T00:00:00");
  showView("day");
  load();
});

document.getElementById("mPrev").addEventListener("click", () => {
  mDate.setMonth(mDate.getMonth() - 1); loadMonth();
});
document.getElementById("mNext").addEventListener("click", () => {
  mDate.setMonth(mDate.getMonth() + 1); loadMonth();
});
document.getElementById("mToday").addEventListener("click", () => {
  mDate = new Date(); loadMonth();
});

/* ---------- customers ---------- */
const custSearch = document.getElementById("custSearch");
const custList   = document.getElementById("custList");
const dayView    = document.getElementById("dayView");
const custView   = document.getElementById("custView");
const tabDay     = document.getElementById("tabDay");
const tabCust    = document.getElementById("tabCust");

function showTab(which){
  const day = which === "day";
  dayView.classList.toggle("hide", !day);
  custView.classList.toggle("hide", day);
  tabDay.classList.toggle("on", day);
  tabCust.classList.toggle("on", !day);
  if (!day && !custList.innerHTML) findCustomers("");
}
tabDay .addEventListener("click", () => showTab("day"));
tabCust.addEventListener("click", () => showTab("cust"));

const SLOT_TIME = {
  priority:"7–9am", morning:"8am–12pm", afternoon:"12–4pm", late:"4–6pm"
};

/* Reminders are tap-to-send, not automated. For a small crew that's better:
   the message opens pre-written, you read it, you send it. Nothing can go
   out by mistake, and it costs nothing to run. */
function reminderText(c){
  if (c.next_date){
    const d = new Date(c.next_date + "T00:00:00")
      .toLocaleDateString("en-GB",{weekday:"long", day:"numeric", month:"long"});
    return `Hi ${c.name.split(" ")[0]}, this is Revivv — just confirming your detail on ${d}, ${SLOT_TIME[c.next_slot] || ""}. Anything you need us to know about the vehicle, let us know. See you then!`;
  }
  const left = 6 - c.stamps;
  if (c.stamps >= 5)
    return `Hi ${c.name.split(" ")[0]}, this is Revivv — you've earned 50% off your next detail — any package. Book in whenever suits.`;
  if (c.stamps > 0)
    return `Hi ${c.name.split(" ")[0]}, this is Revivv — you're ${left} detail${left===1?"":"s"} away from 50% off. Want to get booked in?`;
  return `Hi ${c.name.split(" ")[0]}, this is Revivv — it's been a while since we last had your vehicle in. Want to get something booked?`;
}

async function findCustomers(q){
  custList.innerHTML = `<p class="empty">Searching…</p>`;
  const { data, error } = await sb.rpc("staff_find_customers", { q });
  if (error){
    custList.innerHTML = `<div class="warn">${error.message}</div>`;
    return;
  }
  const list = data || [];
  if (!list.length){
    custList.innerHTML = `<p class="empty">${q ? "No one matching that." : "No customers yet."}</p>`;
    return;
  }

  custList.innerHTML = list.map(c => {
    const msg   = encodeURIComponent(reminderText(c));
    const wa    = c.phone.replace(/\D/g,"").replace(/^(?!1)/, "1");   // Barbados: +1
    const stamps = Array.from({length:6},(_,i) =>
      `<span class="st${i < c.stamps ? " on" : i===5 ? " free" : ""}"></span>`).join("");

    const next = c.next_date
      ? `<p class="next">Booked — ${new Date(c.next_date+"T00:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}, ${SLOT_TIME[c.next_slot]||c.next_slot}</p>`
      : c.stamps >= 5
        ? `<p class="next due">50% off earned — worth a nudge.</p>`
        : "";

    return `<article class="cust">
      <div class="cust-top">
        <div>
          <h3>${c.name}</h3>
          <p class="sub">${c.phone} · ${c.email}</p>
        </div>
        <span class="badge" data-t="${c.tier}">${c.tier}</span>
      </div>

      <div class="stamprow">${stamps}</div>

      <div class="stats">
        <span><b>${c.stamps}/6</b> stamps</span>
        <span><b>${c.visits}</b> visits (12mo)</span>
        <span><b>$${Number(c.credit).toFixed(0)}</b> credit</span>
        <span><b>${c.last_visit ? new Date(c.last_visit+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}) : "—"}</b> last in</span>
      </div>

      ${next}

      <div class="acts">
        <button onclick="location.href='tel:${c.phone}'">Call</button>
        <button onclick="window.open('https://wa.me/${wa}?text=${msg}','_blank')">WhatsApp</button>
        <button onclick="location.href='mailto:${c.email}?subject=${encodeURIComponent("Revivv Vehicle Detailing")}&body=${msg}'">Email</button>
      </div>
    </article>`;
  }).join("");
}

let searchTimer;
custSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => findCustomers(custSearch.value.trim()), 300);
});

/* ---------- date nav ---------- */
function shift(n){ day.setDate(day.getDate() + n); load(); }
document.getElementById("prev").addEventListener("click", () => shift(-1));
document.getElementById("next").addEventListener("click", () => shift(1));
document.getElementById("todayBtn").addEventListener("click", () => { day = new Date(); load(); });
datePick.addEventListener("change", () => {
  if (datePick.value){ day = new Date(datePick.value + "T00:00:00"); load(); }
});

/* already signed in? go straight in */
(async () => {
  const { data:{ session } } = await sb.auth.getSession();
  if (session) enter();
})();
