
/* ===== YOUR TWO KEYS — paste them here =====
   Supabase → Project Settings → API
   The anon key is MEANT to be public. It is not a password.
   Never put the service_role key here. */
const SUPABASE_URL      = "https://mikotrcqvkfgvcnghskn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Eq-EhSVu-ph3DisH5pbKuw_40jOYDzp";

const LIVE = SUPABASE_URL.indexOf("supabase.co") > -1;

/* The 6th-stamp reward. Change this one number to change the offer
   everywhere — quote, stamp card and the rules copy read from it. */
const REWARD_OFF = 0.50;
const sb   = LIVE ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/* the site's slot labels <-> the database enum */
const SLOT_ID = { "Priority slot":"priority", "Morning":"morning",
                  "Afternoon":"afternoon", "Late afternoon":"late" };
const slotIdFrom = label => {
  const k = Object.keys(SLOT_ID).find(k => label.startsWith(k));
  return k ? SLOT_ID[k] : null;
};

/* ===== pricing — straight from the service list ===== */
const PACKAGES = {
  exterior: { label:"The Express Exterior", price:{car:90,  suv:110, truck:130}, tier:1, long:false },
  allround: { label:"All-Around Express",   price:{car:120, suv:150, truck:180}, tier:2, long:false },
  interior: { label:"The Express Interior", price:{car:160, suv:190, truck:220}, tier:2, long:true  },
  supreme:  { label:"Supreme Auto Valet",   price:{car:240, suv:270, truck:300}, tier:3, long:true  }
};

const CARS = {
  car:{ label:"Car",
    d:"M18,138 L18,104 Q18,92 34,88 L96,76 L138,48 Q146,40 162,40 L246,40 Q264,40 274,50 L306,78 L366,90 Q382,94 382,106 L382,138 Z",
    wheels:[[100,132],[302,132]] },
  suv:{ label:"SUV",
    d:"M16,138 L16,98 Q16,84 30,80 L64,72 L100,30 Q104,24 116,24 L298,24 Q312,24 318,32 L336,78 L372,84 Q386,88 386,100 L386,138 Z",
    wheels:[[92,132],[314,132]] },
  truck:{ label:"Truck",
    d:"M16,138 L16,92 Q16,82 30,79 L82,70 L112,42 Q118,34 134,34 L212,34 Q226,34 230,44 L236,80 L368,80 L368,60 L384,60 L384,138 Z",
    wheels:[[92,130],[316,130]] }
};
const SWEEP = {1:"4.6s",2:"3.4s",3:"2.2s"};

/* ===== customer accounts — real, from the database =====
   Sign-in is a one-time code by email. Not a phone lookup: behind this
   door is somebody's home address and when their car sits unattended. */
const RevivvDB = {
  async getAccount(){
    if (!sb) return null;
    const { data:{ session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.rpc("my_account");
    if (error || !data) return null;

    const history = data.history || [];
    const usual = history.length
      ? Object.entries(history.reduce((m,x) => {
          const p = x.job.split(" — ")[0]; m[p] = (m[p]||0)+1; return m; }, {}))
          .sort((a,b) => b[1]-a[1])[0][0]
      : "—";

    return {
      name:data.name, since:data.since, stamps:data.stamps,
      credit:Number(data.credit), referral:data.referral,
      tier:data.tier, discount:Number(data.discount), usual,
      history:history.map(x => ({ date:x.date, job:x.job, paid:Number(x.paid) }))
    };
  },
  async signOut(){ if (sb) await sb.auth.signOut(); }
};

/* Tier comes from the database — counted from the last 12 months,
   never a stored number that can drift. */
function tierOf(c){
  return { key:(c.tier||"Regular").toLowerCase(), label:c.tier||"Regular", off:c.discount||0 };
}

let customer = null;

/* WhatsApp — country code, no + and no spaces */
const WA_NUMBER = "12462608228";
const waBtn = document.getElementById("waBtn");

/* ===== quote ===== */
const stage    = document.getElementById("stage");
const carPath  = document.getElementById("carPath");
const clipPath = document.getElementById("clipPath");
const wheelsG  = document.getElementById("wheels");
const sheen    = document.querySelector(".sheen");
const rVehicle = document.getElementById("rVehicle");
const rPkg     = document.getElementById("rPkg");
const rBase    = document.getElementById("rBase");
const rAddons  = document.getElementById("rAddons");
const rTotal   = document.getElementById("rTotal");
const rDisc    = document.getElementById("rDisc");
const rCredit  = document.getElementById("rCredit");
const discLine   = document.getElementById("rDiscLine");
const creditLine = document.getElementById("rCreditLine");
const quoteField   = document.getElementById("quoteField");
const quoteSummary = document.getElementById("quoteSummary");

const seatAddon = document.getElementById("seatAddon");
const rowOut    = document.getElementById("rowOut");
let seatRows = 1;

let shown = 0;

function drawCar(key){
  const car = CARS[key];
  carPath.setAttribute("d", car.d);
  clipPath.setAttribute("d", car.d);
  wheelsG.innerHTML = car.wheels.map(([x,y]) =>
    `<circle class="wheel" cx="${x}" cy="${y}" r="19"/><circle class="rim" cx="${x}" cy="${y}" r="9"/>`).join("");
}

function countTo(target){
  const start = shown, diff = target - start, t0 = performance.now(), dur = 420;
  (function frame(now){
    const p = Math.min((now - t0)/dur, 1);
    rTotal.textContent = Math.round(start + diff * (1 - Math.pow(1-p,3)));
    if (p < 1) requestAnimationFrame(frame); else shown = target;
  })(performance.now());
}

function update(){
  const v   = document.querySelector('input[name="vehicle"]:checked').value;
  const key = document.querySelector('input[name="pkg"]:checked').value;
  const P   = PACKAGES[key];
  const base = P.price[v];

  /* package cards show the price for the vehicle currently chosen */
  document.querySelectorAll("[data-price-for]").forEach(el => {
    el.textContent = "$" + PACKAGES[el.dataset.priceFor].price[v];
  });

  const adds = [...document.querySelectorAll('input[name="addon"]:checked')];
  let addTotal = 0;
  const addNames = adds.map(a => {
    const unit = parseFloat(a.dataset.price);
    if (a.dataset.perRow){
      addTotal += unit * seatRows;
      return `${a.value} ×${seatRows}`;
    }
    addTotal += unit;
    return a.value;
  });

  let total = base + addTotal;
  let discNote = "", creditNote = "";

  if (customer){
    const t = tierOf(customer);
    /* Sixth stamp beats the tier discount — it doesn't stack with it. */
    if (customer.stamps >= 5){
      const off = base * REWARD_OFF;
      total -= off;
      discNote = `6th stamp — ${Math.round(REWARD_OFF*100)}% off ($${off.toFixed(0)})`;
    } else if (t.off > 0){
      const off = base * t.off;
      total -= off;
      discNote = `${t.label} — ${Math.round(t.off*100)}% off ($${off.toFixed(0)})`;
    }
    if (customer.credit > 0){
      const used = Math.min(customer.credit, total);
      total -= used;
      creditNote = "−$" + used.toFixed(0);
    }
  }
  total = Math.max(0, Math.round(total));

  drawCar(v);
  stage.dataset.tier = P.tier;
  sheen.style.setProperty("--sweep", SWEEP[P.tier]);

  rVehicle.textContent = CARS[v].label;
  rPkg.textContent     = P.label;
  rBase.textContent    = "$" + base;
  rAddons.textContent  = addNames.length ? addNames.join(", ") : "None";
  discLine.classList.toggle("hide", !discNote);
  creditLine.classList.toggle("hide", !creditNote);
  rDisc.textContent   = discNote;
  rCredit.textContent = creditNote;
  countTo(total);

  const summary = `${CARS[v].label} — ${P.label}` +
    (addNames.length ? ` + ${addNames.join(", ")}` : "") +
    (customer ? ` — Rewards: ${customer.name} (${tierOf(customer).label})` : "") +
    ` — BBD $${total}`;
  quoteField.value   = summary;
  quoteSummary.value = summary;
  document.getElementById("fVehicleType").value = CARS[v].label;
  document.getElementById("fPackage").value     = P.label;
  document.getElementById("fAddons").value      = addNames.join(", ");
  document.getElementById("fTotal").value       = total;

  const text = `Hi Revivv, I'd like to book a detail.%0A%0A${encodeURIComponent(summary)}%0A%0AName:%0APreferred date:%0ALocation:`;
  waBtn.href = `https://wa.me/${WA_NUMBER}?text=${text}`;

  if (selectedISO) renderSlots(selectedISO);
}

document.querySelectorAll('#vehicleOpts input, #packageOpts input, #addonOpts input')
  .forEach(el => el.addEventListener("change", update));

function setRows(n){
  seatRows = Math.min(4, Math.max(1, n));
  rowOut.textContent = seatRows + (seatRows === 1 ? " row" : " rows");
  if (!seatAddon.checked) seatAddon.checked = true;
  update();
}
document.getElementById("rowPlus").addEventListener("click",  e => { e.preventDefault(); setRows(seatRows + 1); });
document.getElementById("rowMinus").addEventListener("click", e => { e.preventDefault(); setRows(seatRows - 1); });

/* ===== portal ===== */
const signedOut = document.getElementById("signedOut");
const signedIn  = document.getElementById("signedIn");
const emailIn   = document.getElementById("emailIn");
const passIn    = document.getElementById("passIn");
const pass2In   = document.getElementById("pass2In");
const pass2Field= document.getElementById("pass2Field");
const passLabel = document.getElementById("passLabel");
const portalSub = document.getElementById("portalSub");
const signInBtn = document.getElementById("signInBtn");
const modeBtn   = document.getElementById("modeBtn");
const portalErr = document.getElementById("portalErr");
let signUpMode = false;

function renderAccount(){
  const t = tierOf(customer);
  document.getElementById("acctName").textContent   = customer.name;
  document.getElementById("acctSince").textContent  = "Customer since " + customer.since;
  document.getElementById("acctUsual").textContent  = customer.usual;
  document.getElementById("acctCredit").textContent = "$" + customer.credit;
  document.getElementById("acctRef").textContent    = customer.referral;
  document.getElementById("acctDisc").textContent   = t.off ? Math.round(t.off*100) + "% off" : "—";
  document.getElementById("stampCount").textContent = customer.stamps + " / 6";
  const badge = document.getElementById("acctBadge");
  badge.textContent = t.label; badge.dataset.t = t.key;

  document.getElementById("stampRow").innerHTML = Array.from({length:6},(_,i) => {
    if (i < customer.stamps) return `<span class="stamp on">✓</span>`;
    if (i === 5)             return `<span class="stamp free">${Math.round(REWARD_OFF*100)}%</span>`;
    return `<span class="stamp">${i+1}</span>`;
  }).join("");

  document.getElementById("acctHist").innerHTML = customer.history.length
    ? customer.history.map(x => `<p class="h"><b>${x.job}</b><span>${x.date} · $${x.paid}</span></p>`).join("")
    : `<p class="slot-empty">No completed details yet. Your first stamp lands once we've done the job.</p>`;
}

function showAccount(){
  signedOut.classList.add("hide");
  signedIn.classList.remove("hide");
  renderAccount();
  update();
}

function setMode(signUp){
  signUpMode = signUp;
  pass2Field.classList.toggle("hide", !signUp);
  passLabel.textContent   = signUp ? "Choose a password" : "Password";
  passIn.autocomplete     = signUp ? "new-password" : "current-password";
  signInBtn.textContent   = signUp ? "Create account" : "Sign in";
  modeBtn.textContent     = signUp ? "Already have a password? Sign in" : "First time? Create a password";
  portalSub.textContent   = signUp
    ? "Set a password using the email you booked with — your stamps and history are already waiting."
    : "Sign in to see your stamps, credit and history — and to have your discount applied to any quote you build.";
  portalErr.textContent = "";
}
modeBtn.addEventListener("click", () => setMode(!signUpMode));

/* show/hide password */
const EYE_OPEN   = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
const EYE_CLOSED = '<path d="M2 12s3.6-7 10-7c2 0 3.7.7 5.1 1.6M22 12s-3.6 7-10 7c-2 0-3.7-.7-5.1-1.6"/><path d="m3 3 18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
function bindEyes(){
document.querySelectorAll(".peye").forEach(btn => {
  btn.addEventListener("click", () => {
    const input  = document.getElementById(btn.dataset.for);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    btn.querySelector("svg").innerHTML = hidden ? EYE_CLOSED : EYE_OPEN;
    btn.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
    input.focus();
  }, { once:false });
});
}
bindEyes();

async function portalAction(){
  portalErr.textContent = ""; portalErr.style.color = "";
  if (!LIVE){ portalErr.textContent = "The portal isn't connected yet."; return; }

  const email = emailIn.value.trim();
  const pass  = passIn.value;

  if (!email.includes("@")){ portalErr.textContent = "Enter your email address."; return; }
  if (pass.length < 8){ portalErr.textContent = "Password must be at least 8 characters."; return; }
  if (signUpMode && pass !== pass2In.value){ portalErr.textContent = "Those passwords don't match."; return; }

  signInBtn.disabled = true;
  signInBtn.textContent = signUpMode ? "Creating…" : "Signing in…";

  try{
    const { error } = signUpMode
      ? await sb.auth.signUp({ email, password: pass })
      : await sb.auth.signInWithPassword({ email, password: pass });

    if (error){
      if (/already registered/i.test(error.message))
        throw new Error("There's already a password on that email — sign in instead.");
      if (/invalid login/i.test(error.message))
        throw new Error("Wrong email or password.");
      throw new Error(error.message);
    }

    const acct = await RevivvDB.getAccount();
    if (!acct){
      portalErr.textContent = "Signed in, but we can't find bookings on that email. Book a detail and it'll link up.";
      return;
    }
    customer = acct;
    showAccount();

  } catch(err){
    portalErr.textContent = err.message;
  } finally {
    signInBtn.disabled = false;
    signInBtn.textContent = signUpMode ? "Create account" : "Sign in";
  }
}

signInBtn.addEventListener("click", portalAction);
emailIn.addEventListener("keydown", e => { if (e.key === "Enter") passIn.focus(); });
passIn .addEventListener("keydown", e => { if (e.key === "Enter") signUpMode ? pass2In.focus() : portalAction(); });
pass2In.addEventListener("keydown", e => { if (e.key === "Enter") portalAction(); });

/* Change password — works without email, because they're already signed in. */
const pwPanel = document.getElementById("pwPanel");
const newPw   = document.getElementById("newPw");
const pwMsg   = document.getElementById("pwMsg");

document.getElementById("pwBtn").addEventListener("click", () => {
  pwPanel.classList.toggle("hide");
  if (!pwPanel.classList.contains("hide")) newPw.focus();
});

document.getElementById("pwSave").addEventListener("click", async () => {
  pwMsg.style.color = "#FF6B6B";
  if (newPw.value.length < 8){ pwMsg.textContent = "At least 8 characters."; return; }
  const { error } = await sb.auth.updateUser({ password: newPw.value });
  if (error){ pwMsg.textContent = error.message; return; }
  pwMsg.style.color = "var(--blue)";
  pwMsg.textContent = "Password changed.";
  newPw.value = "";
});

/* Forgot password — sends a reset link. Needs SMTP and a hosted site,
   so it stays honest about that rather than pretending to work. */
document.getElementById("forgotBtn").addEventListener("click", async () => {
  const email = emailIn.value.trim();
  portalErr.style.color = "";
  if (!email.includes("@")){
    portalErr.textContent = "Type your email above first, then tap Forgot password.";
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname + "#rewards"
  });
  if (error){ portalErr.textContent = error.message; return; }
  portalErr.style.color = "var(--blue)";
  portalErr.textContent = "If that email has an account, a reset link is on its way.";
});

/* Arriving back from a reset link? Let them set a new password straight away. */
if (location.hash.includes("type=recovery") || location.search.includes("type=recovery")){
  setTimeout(() => {
    signedOut.classList.add("hide");
    signedIn.classList.remove("hide");
    pwPanel.classList.remove("hide");
    newPw.focus();
  }, 400);
}

document.getElementById("signOutBtn").addEventListener("click", async () => {
  await RevivvDB.signOut();
  customer = null;
  signedIn.classList.add("hide");
  signedOut.classList.remove("hide");
  emailIn.value = ""; passIn.value = ""; pass2In.value = "";
  setMode(false);
  update();
});
document.getElementById("copyRef").addEventListener("click", e => {
  const link = location.origin + location.pathname + "?ref=" + customer.referral;
  navigator.clipboard.writeText(link);
  e.target.textContent = "Link copied";
  setTimeout(() => { e.target.textContent = "Copy"; }, 1600);
});

/* already signed in from last time? pick straight back up */
(async () => {
  if (!LIVE) return;
  const acct = await RevivvDB.getAccount();
  if (acct){ customer = acct; showAccount(); }
})();

/* ===== availability — read straight from the bookings table ===== */
const SLOTS = [
  { id:"priority",  label:"Priority slot",  time:"7:00am – 9:00am",  goldOnly:true,  long:false },
  { id:"morning",   label:"Morning",        time:"8:00am – 12:00pm", goldOnly:false, long:true  },
  { id:"afternoon", label:"Afternoon",      time:"12:00pm – 4:00pm", goldOnly:false, long:true  },
  { id:"late",      label:"Late afternoon", time:"4:00pm – 6:00pm",  goldOnly:false, long:false }
];
const RevivvSchedule = {
  async getTakenSlots(iso){
    if (!LIVE) return [];
    const { data, error } = await sb.rpc("slots_taken", { d: iso });
    if (error){ console.error(error); return []; }
    return (data || []).map(r => typeof r === "string" ? r : r.slots_taken);
  }
};

const calGrid  = document.getElementById("calGrid");
const calMonth = document.getElementById("calMonth");
const slotList = document.getElementById("slotList");
const fDate    = document.getElementById("fDate");
const fTime    = document.getElementById("fTime");

const today = new Date(); today.setHours(0,0,0,0);
let viewY = today.getFullYear(), viewM = today.getMonth(), selectedISO = null;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const isoOf  = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const pretty = d => d.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});

function renderCalendar(){
  calMonth.textContent = `${MONTHS[viewM]} ${viewY}`;
  document.getElementById("calPrev").disabled =
    (viewY === today.getFullYear() && viewM === today.getMonth());

  calGrid.innerHTML = ["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => `<div class="dow">${d}</div>`).join("");
  const offset = (new Date(viewY, viewM, 1).getDay() + 6) % 7;
  const days   = new Date(viewY, viewM + 1, 0).getDate();

  for (let i = 0; i < offset; i++)
    calGrid.insertAdjacentHTML("beforeend", `<button class="day blank" disabled tabindex="-1"></button>`);

  for (let d = 1; d <= days; d++){
    const date = new Date(viewY, viewM, d);
    const key  = isoOf(date);
    const off  = date < today || date.getDay() === 0;   // past, or Sunday (by appointment)
    const cls  = ["day"];
    if (key === isoOf(today))  cls.push("today");
    if (key === selectedISO)   cls.push("sel");
    calGrid.insertAdjacentHTML("beforeend",
      `<button type="button" class="${cls.join(" ")}" data-iso="${key}" ${off ? "disabled" : ""}>${d}</button>`);
  }
}

async function renderSlots(key){
  const date = new Date(key + "T00:00:00");
  slotList.innerHTML = `<p class="head">${pretty(date)}</p><p class="slot-empty">Checking availability…</p>`;

  const taken  = await RevivvSchedule.getTakenSlots(key);
  const P      = PACKAGES[document.querySelector('input[name="pkg"]:checked').value];
  const isGold = customer && tierOf(customer).key === "gold";

  const rows = SLOTS.filter(s => !s.goldOnly || isGold).map(s => {
    let why = s.time, off = taken.includes(s.id);
    if (off) why = "Booked";
    else if (P.long && !s.long){ off = true; why = "Not enough time for this package"; }
    return `<button type="button" class="slot${s.goldOnly ? " gold" : ""}" data-slot="${s.label} (${s.time})" ${off ? "disabled" : ""}>
              <span>${s.label}${s.goldOnly ? " · Gold" : ""}</span><em>${why}</em></button>`;
  }).join("");

  slotList.innerHTML = `<p class="head">${pretty(date)}</p>${rows}` +
    (P.long ? `<p class="slot-empty">${P.label} needs a longer block, so only the full sessions are offered.</p>` : "");
}

calGrid.addEventListener("click", e => {
  const btn = e.target.closest(".day");
  if (!btn || btn.disabled) return;
  selectedISO = btn.dataset.iso;
  fDate.value = selectedISO;
  fTime.value = "";
  renderCalendar();
  renderSlots(selectedISO);
});
slotList.addEventListener("click", e => {
  const btn = e.target.closest(".slot");
  if (!btn || btn.disabled) return;
  slotList.querySelectorAll(".slot").forEach(s => s.classList.remove("sel"));
  btn.classList.add("sel");
  fTime.value = btn.dataset.slot;
});
document.getElementById("calPrev").addEventListener("click", () => {
  viewM--; if (viewM < 0){ viewM = 11; viewY--; } renderCalendar();
});
document.getElementById("calNext").addEventListener("click", () => {
  viewM++; if (viewM > 11){ viewM = 0; viewY++; } renderCalendar();
});

/* address only matters for a mobile visit */
const whereSel  = document.getElementById("where");
const addrField = document.getElementById("addrField");
const addrInput = document.getElementById("address");
function syncWhere(){
  const mobile = whereSel.value.startsWith("Mobile");
  addrField.classList.toggle("hide", !mobile);
  addrInput.required = mobile;
}
whereSel.addEventListener("change", syncWhere);
syncWhere();

/* ===== before / after ===== */
document.querySelectorAll(".ba").forEach(ba => {
  const range = ba.querySelector(".ba-range");
  ba.style.setProperty("--split", "50%");
  range.addEventListener("input", () => ba.style.setProperty("--split", range.value + "%"));
});

/* ===== booking form ===== */
const form = document.getElementById("bookingForm");
const msg  = document.getElementById("formMsg");
const submitBtn = document.getElementById("submitBtn");

form.addEventListener("submit", async e => {
  e.preventDefault();
  msg.className = ""; msg.style.color = "";

  if (!fDate.value || !fTime.value){
    msg.className = "err";
    msg.textContent = "Pick a date and a slot first.";
    document.querySelector(".sched").scrollIntoView({block:"center"});
    return;
  }
  if (!LIVE){
    msg.className = "err";
    msg.textContent = "Bookings aren't connected yet — call 1-246-260-8228 or use WhatsApp.";
    return;
  }

  msg.textContent = "Sending…";
  submitBtn.disabled = true;

  try{
    const f    = Object.fromEntries(new FormData(form));
    const slot = slotIdFrom(f.preferred_time || "");
    if (!slot) throw new Error("Pick a slot first.");

    const { error } = await sb.rpc("create_booking", {
      p_name:         f.name,
      p_email:        f.email,
      p_phone:        f.phone,
      p_date:         f.preferred_date,
      p_slot:         slot,
      p_vehicle_type: f.vehicle_type,
      p_vehicle_desc: f.vehicle_description,
      p_package:      f.package,
      p_addons:       f.addons || null,
      p_total:        Number(f.total),
      p_location:     f.service_location,
      p_parish:       f.parish,
      p_address:      f.address || null,
      p_notes:        f.notes || null,
      p_referral:     f.referral || null
    });

    if (error){
      // The database itself refused — somebody took the slot mid-form.
      if (/just taken|duplicate|unique/i.test(error.message))
        throw new Error("That slot was just taken. Please pick another.");
      throw new Error(error.message);
    }

    msg.className = "ok";
    msg.textContent = "Booking request sent. We'll confirm your slot shortly.";
    form.reset();
    selectedISO = null; fDate.value = ""; fTime.value = "";
    renderCalendar();
    slotList.innerHTML = `<p class="head">Available slots</p><p class="slot-empty">Pick a date to see what's open.</p>`;
    syncWhere(); update();

  } catch(err){
    msg.className = "err";
    msg.textContent = err.message || "Couldn't send that. Call 1-246-260-8228 or book on WhatsApp instead.";
    if (selectedISO) renderSlots(selectedISO);   // refresh — the slot may really have gone
  } finally {
    submitBtn.disabled = false;
  }
});

/* ===== referral codes ===== */
const refIn  = document.getElementById("refIn");
const refMsg = document.getElementById("refMsg");

/* A shared link like ...?ref=REVIVV-AB123 fills it in for them. */
const urlRef = new URLSearchParams(location.search).get("ref");
if (urlRef){
  refIn.value = urlRef.toUpperCase();
  document.getElementById("book").scrollIntoView({behavior:"smooth"});
}

let refTimer;
async function checkRef(){
  const code = refIn.value.trim();
  if (!code){
    refMsg.style.color = "var(--dim)";
    refMsg.textContent = "Got a code from a friend? You both get $25 once your first detail is done.";
    return;
  }
  if (!LIVE) return;
  const { data, error } = await sb.rpc("check_referral", { p_code: code });
  if (error || !data){
    refMsg.style.color = "#FF6B6B";
    refMsg.textContent = "We don't recognise that code — check it, or leave it blank.";
  } else {
    refMsg.style.color = "var(--blue)";
    refMsg.textContent = `Referred by ${data}. You'll both get $25 once this detail is done.`;
  }
}
refIn.addEventListener("input", () => { clearTimeout(refTimer); refTimer = setTimeout(checkRef, 400); });
if (urlRef) checkRef();

/* ===== app auto-update =====
   Registers the service worker and, when a new version is published,
   activates it and reloads once — so an installed app is never stale.
   Change APP_VERSION on every release; it also shows in the footer. */
const APP_VERSION = "1.0.0";
if ("serviceWorker" in navigator && location.protocol === "https:"){
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      // check for updates every time the app is opened
      reg.update();
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw && nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller){
            nw.postMessage("SKIP_WAITING");
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return; reloaded = true; location.reload();
      });
    } catch(err){ console.log("SW:", err); }
  });
}

const installBar = document.getElementById("installBar");
let deferredPrompt = null;

/* Chrome/Android/desktop: the browser tells us when it's installable. */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  installBar.classList.add("show");
});

document.getElementById("installGo").addEventListener("click", async () => {
  if (deferredPrompt){
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBar.classList.remove("show");
  }
});

document.getElementById("installNo").addEventListener("click", () => {
  installBar.classList.remove("show");
});

/* iOS: Safari never fires beforeinstallprompt. Detect it and offer instructions,
   but only if they haven't already installed it. */
/* iOS: Apple gives no install API, so the only honest thing is to show
   exactly where the button is — and to say "Safari", because no other
   iPhone browser can do this. */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isSafari = isIOS && !/crios|fxios|edgios|opios/i.test(navigator.userAgent);
const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;

if (isIOS && !standalone && location.protocol === "https:"){
  const share = `<svg class="share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0L8 7m4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  document.getElementById("installMsg").innerHTML = isSafari
    ? `Add Revivv to your home screen — tap ${share} <b>Share</b>, then <b>Add to Home Screen</b>.`
    : `To install Revivv, open this page in <b>Safari</b>, then tap ${share} <b>Share → Add to Home Screen</b>.`;
  document.getElementById("installGo").style.display = "none";
  installBar.classList.add("ios");
  setTimeout(() => installBar.classList.add("show"), 3000);
}

document.getElementById("yr").textContent  = new Date().getFullYear();
document.getElementById("yr2").textContent = new Date().getFullYear();
renderCalendar();
update();
