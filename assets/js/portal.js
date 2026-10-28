
const sb = window.revivvApi || null;   // Revivv's own server: assets/js/api.js
const REWARD_OFF = 0.50;

/* Is the Revivv server reachable? If not, every call fails with status 0. Then sign-in is switched off with a plain message
   instead of raw errors. */
let offline=!sb;
const isDown=r=>!!(r&&r.error)&&(!r.status||r.status>=500);
const authDown=e=>!!e&&(e.name==="AuthRetryableFetchError"||!e.status||e.status>=500);
function goOffline(){
  offline=true;
  document.getElementById("portalOffline").classList.remove("hide");
  document.getElementById("signInBtn").disabled=true;
  document.getElementById("forgotBtn").disabled=true;
  const err=document.getElementById("portalErr");err.className="msg";err.textContent="";
}

const PACKAGES = {
  exterior:{label:"The Express Exterior",price:{car:90,suv:110,truck:130},tier:1,long:false},
  allround:{label:"All-Around Express",  price:{car:120,suv:150,truck:180},tier:2,long:false},
  interior:{label:"The Express Interior",price:{car:160,suv:190,truck:220},tier:2,long:true},
  supreme: {label:"Supreme Auto Valet",  price:{car:240,suv:270,truck:300},tier:3,long:true}
};
const CARS = {
  car:{label:"Car",d:"M18,138 L18,104 Q18,92 34,88 L96,76 L138,48 Q146,40 162,40 L246,40 Q264,40 274,50 L306,78 L366,90 Q382,94 382,106 L382,138 Z",wheels:[[100,132],[302,132]]},
  suv:{label:"SUV",d:"M16,138 L16,98 Q16,84 30,80 L64,72 L100,30 Q104,24 116,24 L298,24 Q312,24 318,32 L336,78 L372,84 Q386,88 386,100 L386,138 Z",wheels:[[92,132],[314,132]]},
  truck:{label:"Truck",d:"M16,138 L16,92 Q16,82 30,79 L82,70 L112,42 Q118,34 134,34 L212,34 Q226,34 230,44 L236,80 L368,80 L368,60 L384,60 L384,138 Z",wheels:[[92,130],[316,130]]}
};
const SWEEP={1:"4.6s",2:"3.4s",3:"2.2s"};
const SLOT_ID={"Priority slot":"priority","Morning":"morning","Afternoon":"afternoon","Late afternoon":"late"};
const slotIdFrom=l=>{const k=Object.keys(SLOT_ID).find(k=>l.startsWith(k));return k?SLOT_ID[k]:null;};

let customer=null;

/* ---------- account ---------- */
async function getAccount(){
  if(!sb||offline) return null;
  const {data:{session}}=await sb.auth.getSession();
  if(!session) return null;
  const res=await sb.rpc("my_account");
  if(isDown(res)){goOffline();return null;}
  const {data,error}=res;
  if(error||!data) return null;
  return {name:data.name,since:data.since,stamps:data.stamps,credit:Number(data.credit),
    referral:data.referral,tier:data.tier,discount:Number(data.discount),
    history:(data.history||[]).map(x=>({date:x.date,job:x.job,paid:Number(x.paid)})),
    next:data.next||null,unread:Number(data.unread)||0};
}
/* After signing in, go back to the My Revivv page that sent them here (?next=).
   Only my-*.html or portal.html on this site, never another address. */
function nextPage(){
  const n=new URLSearchParams(location.search).get("next")||"";
  return /^(?:my-[a-z]+(?:-[a-z]+)*|portal)\.html(?:\?[\w.~%=&+-]*)?(?:#[\w-]*)?$/.test(n)?n:null;
}
function tierOf(c){return {key:(c.tier||"Regular").toLowerCase(),label:c.tier||"Regular",off:c.discount||0};}

function renderAccount(){
  const t=tierOf(customer);
  document.getElementById("acctName").textContent=customer.name;
  document.getElementById("acctSince").textContent="Customer since "+customer.since;
  document.getElementById("acctCredit").textContent="$"+customer.credit;
  document.getElementById("acctRef").textContent=customer.referral;
  document.getElementById("acctDisc").textContent=t.off?Math.round(t.off*100)+"% off":"—";
  document.getElementById("stampCount").textContent=customer.stamps+" / 6";
  const b=document.getElementById("acctBadge");b.textContent=t.label;b.dataset.t=t.key;
  document.getElementById("stampRow").innerHTML=Array.from({length:6},(_,i)=>{
    if(i<customer.stamps) return '<span class="stamp on">✓</span>';
    if(i===5) return '<span class="stamp free">'+Math.round(REWARD_OFF*100)+'%</span>';
    return '<span class="stamp">'+(i+1)+'</span>';
  }).join("");
  const left=6-customer.stamps;
  document.getElementById("rewardHint").textContent = customer.stamps>=5
    ? "You've earned "+Math.round(REWARD_OFF*100)+"% off your next detail — any package."
    : "You're "+left+" detail"+(left===1?"":"s")+" from "+Math.round(REWARD_OFF*100)+"% off.";
  document.getElementById("acctHist").innerHTML=customer.history.length
    ? customer.history.map(x=>'<p class="h"><b>'+x.job+'</b><span>'+x.date+' · $'+x.paid+'</span></p>').join("")
    : '<p class="slot-empty">No completed details yet. Your first stamp lands once we have done the job.</p>';
  renderMine();
}

/* My Revivv bits (helpers from assets/js/my.js): text only, never HTML */
function renderMine(){
  const my=window.my;if(!my)return;
  const n=customer.unread||0,ul=document.getElementById("unreadLine");
  ul.classList.toggle("hide",!n);
  if(n)ul.replaceChildren(my.el("span",{class:"my-badge","aria-hidden":"true",text:n>99?"99+":n}),
    my.el("span",{text:(n===1?"1 new message":n+" new messages")+" from Revivv. Read "+(n===1?"it":"them")+" →"}));
  const nx=customer.next,nc=document.getElementById("nextCard");
  nc.classList.toggle("hide",!nx);
  if(nx){
    nc.href=my.bookingLink(nx.ref,nx.key);
    nc.replaceChildren(my.el("span",{class:"lbl",text:"Your next detail"}),
      my.el("span",{class:"when",text:nx.dateText+" · "+nx.slotText}),
      my.el("span",{class:"what",text:nx.package+" · "+my.carText(nx.vehicleType,nx.vehicleDesc)}),
      my.el("span",{class:"foot"},my.pill(nx.status,nx.statusLabel),my.el("span",{text:"See booking →"})));
  }
  my.markNav();my.showNav(true);my.setBadge(n);
}

function showAccount(){
  document.getElementById("signedOut").classList.add("hide");
  document.getElementById("signedIn").classList.remove("hide");
  document.getElementById("signOutBtn").classList.remove("hide");
  renderAccount(); update();
}

/* ---------- sign in (password) ---------- */
const emailIn=document.getElementById("emailIn"),passIn=document.getElementById("passIn"),
  pass2In=document.getElementById("pass2In"),pass2Field=document.getElementById("pass2Field"),
  passLabel=document.getElementById("passLabel"),portalSub=document.getElementById("portalSub"),
  signInBtn=document.getElementById("signInBtn"),modeBtn=document.getElementById("modeBtn"),
  portalErr=document.getElementById("portalErr");
let signUp=false;

function setMode(s){
  signUp=s;
  pass2Field.classList.toggle("hide",!s);
  passLabel.textContent=s?"Choose a password":"Password";
  signInBtn.textContent=s?"Create account":"Sign in";
  modeBtn.textContent=s?"Already have a password? Sign in":"First time? Create a password";
  portalSub.textContent=s?"Set a password using the email you booked with — your stamps are already waiting."
    :"Sign in to see your stamps and book your next detail.";
  portalErr.textContent="";
}
modeBtn.addEventListener("click",()=>setMode(!signUp));

async function doAuth(){
  if(offline) return;
  portalErr.className="msg";portalErr.textContent="";
  const email=emailIn.value.trim(),pass=passIn.value;
  if(!email.includes("@")){portalErr.className="msg err";portalErr.textContent="Enter your email.";return;}
  if(pass.length<8){portalErr.className="msg err";portalErr.textContent="Password must be at least 8 characters.";return;}
  if(signUp&&pass!==pass2In.value){portalErr.className="msg err";portalErr.textContent="Those passwords don't match.";return;}
  signInBtn.disabled=true;signInBtn.textContent=signUp?"Creating…":"Signing in…";
  try{
    const {error}=signUp?await sb.auth.signUp({email,password:pass}):await sb.auth.signInWithPassword({email,password:pass});
    if(error){
      if(authDown(error)){goOffline();return;}
      if(/already registered/i.test(error.message)) throw new Error("There's already a password on that email — sign in instead.");
      if(/invalid login/i.test(error.message)) throw new Error("Wrong email or password.");
      throw new Error(error.message);
    }
    const next=nextPage();
    if(next){location.replace(next);return;}
    const acct=await getAccount();
    if(!acct){if(offline)return;portalErr.className="msg err";portalErr.textContent="Signed in, but no bookings on that email yet. Book a detail and it'll link up.";return;}
    customer=acct;
    if(!document.getElementById("phone").value) document.getElementById("phone").value="";
    showAccount();
  }catch(err){portalErr.className="msg err";portalErr.textContent=err.message;}
  finally{signInBtn.disabled=offline;signInBtn.textContent=signUp?"Create account":"Sign in";}
}
signInBtn.addEventListener("click",doAuth);
emailIn.addEventListener("keydown",e=>{if(e.key==="Enter")passIn.focus();});
passIn.addEventListener("keydown",e=>{if(e.key==="Enter")signUp?pass2In.focus():doAuth();});
pass2In.addEventListener("keydown",e=>{if(e.key==="Enter")doAuth();});

document.getElementById("forgotBtn").addEventListener("click",async()=>{
  const email=emailIn.value.trim();portalErr.className="msg";
  if(offline) return;
  if(!email.includes("@")){portalErr.className="msg err";portalErr.textContent="Type your email above first.";return;}
  const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname.replace("portal.html","quote.html")+"#rewards"});
  if(error){if(authDown(error)){goOffline();return;}portalErr.className="msg err";portalErr.textContent=error.message;return;}
  portalErr.className="msg ok";portalErr.textContent="If that email has an account, a reset link is on its way.";
});

document.getElementById("signOutBtn").addEventListener("click",async()=>{
  await sb.auth.signOut();customer=null;
  document.getElementById("signedIn").classList.add("hide");
  document.getElementById("signedOut").classList.remove("hide");
  document.getElementById("signOutBtn").classList.add("hide");
  emailIn.value="";passIn.value="";pass2In.value="";setMode(false);
});
document.getElementById("copyRef").addEventListener("click",e=>{
  navigator.clipboard.writeText(location.origin+location.pathname.replace("portal.html","quote.html")+"?ref="+customer.referral);
  e.target.textContent="Copied";setTimeout(()=>e.target.textContent="Copy link",1600);
});

/* eye toggles */
document.querySelectorAll(".peye").forEach(btn=>{
  btn.addEventListener("click",()=>{
    const i=document.getElementById(btn.dataset.for),h=i.type==="password";
    i.type=h?"text":"password";i.focus();
  });
});

/* ---------- quote ---------- */
const stage=document.getElementById("stage"),carPath=document.getElementById("carPath"),
  clipPath=document.getElementById("clipPath"),wheelsG=document.getElementById("wheels"),
  sheen=document.querySelector(".sheen");
const seatAddon=document.getElementById("seatAddon"),rowOut=document.getElementById("rowOut");
let seatRows=1,shown=0;

function drawCar(k){const c=CARS[k];carPath.setAttribute("d",c.d);clipPath.setAttribute("d",c.d);
  wheelsG.innerHTML=c.wheels.map(([x,y])=>'<circle class="wheel" cx="'+x+'" cy="'+y+'" r="19"/><circle class="rim" cx="'+x+'" cy="'+y+'" r="9"/>').join("");}
function countTo(t){const s=shown,d=t-s,t0=performance.now();(function f(n){const p=Math.min((n-t0)/380,1);
  document.getElementById("rTotal").textContent=Math.round(s+d*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(f);else shown=t;})(performance.now());}

function update(){
  const v=document.querySelector('input[name="vehicle"]:checked').value;
  const key=document.querySelector('input[name="pkg"]:checked').value;
  const P=PACKAGES[key],base=P.price[v];
  document.querySelectorAll("[data-price-for]").forEach(el=>el.textContent="$"+PACKAGES[el.dataset.priceFor].price[v]);
  const adds=[...document.querySelectorAll('input[name="addon"]:checked')];
  let addTotal=0;const names=adds.map(a=>{const u=parseFloat(a.dataset.price);
    if(a.dataset.perRow){addTotal+=u*seatRows;return a.value+" ×"+seatRows;}addTotal+=u;return a.value;});
  let total=base+addTotal,disc="",cred="";
  if(customer){
    if(customer.stamps>=5){const off=base*REWARD_OFF;total-=off;disc="6th stamp — "+Math.round(REWARD_OFF*100)+"% off ($"+off.toFixed(0)+")";}
    else{const t=tierOf(customer);if(t.off>0){const off=base*t.off;total-=off;disc=t.label+" — "+Math.round(t.off*100)+"% off ($"+off.toFixed(0)+")";}}
    if(customer.credit>0){const u=Math.min(customer.credit,total);total-=u;cred="−$"+u.toFixed(0);}
  }
  total=Math.max(0,Math.round(total));
  drawCar(v);stage.dataset.tier=P.tier;sheen.style.setProperty("--sweep",SWEEP[P.tier]);
  document.getElementById("rBase").textContent="$"+base;
  document.getElementById("rAddons").textContent=names.length?names.join(", "):"None";
  document.getElementById("rDiscLine").classList.toggle("hide",!disc);
  document.getElementById("rCreditLine").classList.toggle("hide",!cred);
  document.getElementById("rDisc").textContent=disc;document.getElementById("rCredit").textContent=cred;
  countTo(total);
  window._quote={vehicle:CARS[v].label,vehicleType:v,package:P.label,addons:names.join(", "),total};
  if(selectedISO)renderSlots(selectedISO);
}
document.querySelectorAll('#vehicleOpts input,#packageOpts input,#addonOpts input').forEach(el=>el.addEventListener("change",update));
function setRows(n){seatRows=Math.min(4,Math.max(1,n));rowOut.textContent=seatRows+(seatRows===1?" row":" rows");if(!seatAddon.checked)seatAddon.checked=true;update();}
document.getElementById("rowPlus").addEventListener("click",e=>{e.preventDefault();setRows(seatRows+1);});
document.getElementById("rowMinus").addEventListener("click",e=>{e.preventDefault();setRows(seatRows-1);});

/* ---------- calendar ---------- */
const SLOTS=[
  {id:"priority",label:"Priority slot",time:"7:00am – 9:00am",goldOnly:true,long:false},
  {id:"morning",label:"Morning",time:"8:00am – 12:00pm",goldOnly:false,long:true},
  {id:"afternoon",label:"Afternoon",time:"12:00pm – 4:00pm",goldOnly:false,long:true},
  {id:"late",label:"Late afternoon",time:"4:00pm – 6:00pm",goldOnly:false,long:false}
];
async function slotsTaken(iso){const res=await sb.rpc("slots_taken",{d:iso});
  if(isDown(res))return null;const {data,error}=res;
  if(error)return[];return(data||[]).map(r=>typeof r==="string"?r:r.slots_taken);}

const calGrid=document.getElementById("calGrid"),calMonth=document.getElementById("calMonth"),
  slotList=document.getElementById("slotList");
const today=new Date();today.setHours(0,0,0,0);
let viewY=today.getFullYear(),viewM=today.getMonth(),selectedISO=null,selectedSlot=null;
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
const isoOf=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const pretty=d=>d.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});

function renderCalendar(){
  calMonth.textContent=MONTHS[viewM]+" "+viewY;
  document.getElementById("calPrev").disabled=(viewY===today.getFullYear()&&viewM===today.getMonth());
  calGrid.innerHTML=["Mo","Tu","We","Th","Fr","Sa","Su"].map(d=>'<div class="dow">'+d+'</div>').join("");
  const offset=(new Date(viewY,viewM,1).getDay()+6)%7,days=new Date(viewY,viewM+1,0).getDate();
  for(let i=0;i<offset;i++)calGrid.insertAdjacentHTML("beforeend",'<button class="day blank" disabled></button>');
  for(let d=1;d<=days;d++){const date=new Date(viewY,viewM,d),key=isoOf(date);
    const off=date<today||date.getDay()===0;const cls=["day"];
    if(key===isoOf(today))cls.push("today");if(key===selectedISO)cls.push("sel");
    calGrid.insertAdjacentHTML("beforeend",'<button class="'+cls.join(" ")+'" data-iso="'+key+'" '+(off?"disabled":"")+'>'+d+'</button>');
  }
}
async function renderSlots(key){
  const date=new Date(key+"T00:00:00");
  slotList.innerHTML='<p class="head" style="font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">'+pretty(date)+'</p><p class="slot-empty">Checking…</p>';
  const taken=await slotsTaken(key);
  if(!taken){slotList.innerHTML='<p class="slot-empty">We can’t check availability right now. Try again shortly, or call 1-246-260-8228.</p>';return;}
  const P=PACKAGES[document.querySelector('input[name="pkg"]:checked').value];
  const isGold=customer&&tierOf(customer).key==="gold";
  const rows=SLOTS.filter(s=>!s.goldOnly||isGold).map(s=>{
    let why=s.time,off=taken.includes(s.id);
    if(off)why="Booked";else if(P.long&&!s.long){off=true;why="Not enough time for this package";}
    return '<button class="slot'+(s.goldOnly?" gold":"")+'" data-slot="'+s.label+' ('+s.time+')" '+(off?"disabled":"")+'><span>'+s.label+(s.goldOnly?" · Gold":"")+'</span><em>'+why+'</em></button>';
  }).join("");
  slotList.innerHTML='<p style="font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.4rem">'+pretty(date)+'</p>'+rows;
}
calGrid.addEventListener("click",e=>{const b=e.target.closest(".day");if(!b||b.disabled)return;
  selectedISO=b.dataset.iso;selectedSlot=null;renderCalendar();renderSlots(selectedISO);});
slotList.addEventListener("click",e=>{const b=e.target.closest(".slot");if(!b||b.disabled)return;
  slotList.querySelectorAll(".slot").forEach(s=>s.classList.remove("sel"));b.classList.add("sel");selectedSlot=b.dataset.slot;});
document.getElementById("calPrev").addEventListener("click",()=>{viewM--;if(viewM<0){viewM=11;viewY--;}renderCalendar();});
document.getElementById("calNext").addEventListener("click",()=>{viewM++;if(viewM>11){viewM=0;viewY++;}renderCalendar();});

/* where toggle */
const whereSel=document.getElementById("where"),addrField=document.getElementById("addrField");
function syncWhere(){addrField.classList.toggle("hide",!whereSel.value.startsWith("Mobile"));}
whereSel.addEventListener("change",syncWhere);syncWhere();

/* ---------- book ---------- */
const bookMsg=document.getElementById("bookMsg"),bookBtn=document.getElementById("bookBtn");
bookBtn.addEventListener("click",async()=>{
  bookMsg.className="msg";
  const phone=document.getElementById("phone").value.trim();
  const vdesc=document.getElementById("vehicleDesc").value.trim();
  if(!selectedISO||!selectedSlot){bookMsg.className="msg err";bookMsg.textContent="Pick a date and a slot.";return;}
  if(!phone||!vdesc){bookMsg.className="msg err";bookMsg.textContent="Add your phone and vehicle.";return;}
  const where=whereSel.value,addr=document.getElementById("address").value.trim();
  if(where.startsWith("Mobile")&&!addr){bookMsg.className="msg err";bookMsg.textContent="Add the address for the mobile visit.";return;}
  bookMsg.textContent="Sending…";bookBtn.disabled=true;
  try{
    const q=window._quote;
    const {data:{session}}=await sb.auth.getSession();
    const res=await sb.rpc("create_booking",{
      p_name:customer.name,
      p_email:session?.user?.email,
      p_phone:phone,p_date:selectedISO,p_slot:slotIdFrom(selectedSlot),
      p_vehicle_type:q.vehicle,p_vehicle_desc:vdesc,p_package:q.package,
      p_addons:q.addons||null,p_total:Number(q.total),
      p_location:where,p_parish:document.getElementById("parish").value,
      p_address:addr||null,p_notes:document.getElementById("notes").value.trim()||null,
      p_referral:null
    });
    if(isDown(res))throw new Error("We couldn't reach the booking system just now. Try again shortly, or call 1-246-260-8228.");
    const {error}=res;
    if(error){if(/just taken|duplicate|unique/i.test(error.message))throw new Error("That slot was just taken. Pick another.");throw new Error(error.message);}
    bookMsg.className="msg ok";bookMsg.textContent="Booking sent! We'll confirm your slot shortly.";
    selectedISO=null;selectedSlot=null;renderCalendar();
    slotList.innerHTML='<p class="slot-empty">Pick a date to see what is open.</p>';
  }catch(err){bookMsg.className="msg err";bookMsg.textContent=err.message;if(selectedISO)renderSlots(selectedISO);}
  finally{bookBtn.disabled=false;}
});

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

/* ---------- boot ---------- */
renderCalendar();
(async()=>{
  if(!offline){
    const res=await Promise.race([sb.rpc("slots_taken",{d:isoOf(today)}),
      new Promise(r=>setTimeout(()=>r({error:{message:"timed out"},status:0}),8000))]);
    if(isDown(res))offline=true;
  }
  if(offline){goOffline();return;}
  if(nextPage()){const {data:{session}}=await sb.auth.getSession();if(session){location.replace(nextPage());return;}}
  const acct=await getAccount();if(acct){customer=acct;showAccount();}
})();
