/**
 * Trang điều khiển kiểu hộp thư: cột trái là danh sách phiên nhóm theo trạng thái, bên phải là chi tiết phiên đang chọn,
 * dưới cùng là log sự kiện. Điện thoại thành ba tab. Một file HTML tự chứa, không framework. Nghe bằng giọng trình duyệt.
 */

const LABELS = {
  vi: {
    title: 'Vi Voice Hub',
    groups: { need: 'Cần bạn', done: 'Vừa xong', working: 'Đang làm', idle: 'Rảnh' },
    tabs: { list: 'Danh sách', detail: 'Chi tiết', log: 'Log' },
    none: 'Chưa có phiên nào. Gõ gì đó trong Claude Code là phiên hiện ở đây.',
    pick: 'Chọn một phiên bên trái.',
    filter: 'Lọc workspace…',
    newDone: 'mới',
    autoRead: 'Tự đọc',
    stop: 'Dừng',
    listen: 'Nghe',
    seen: 'Đã xem',
    approve: 'Approve',
    deny: 'Từ chối',
    dangerous: 'Lệnh nguy hiểm, bấm tay trong VS Code',
    queue: 'Xếp hàng',
    queueHint: 'Chạy khi phiên xong lượt này',
    idleHint: 'Phiên đang rảnh, chạy khi có lượt mới',
    queued: 'Đang xếp hàng',
    answer: 'Gửi trả lời',
    freeAnswer: 'Hoặc trả lời tự do…',
    placeholder: 'Việc tiếp theo cho phiên này…',
    doing: 'Đang làm',
    asked: 'Bạn đã hỏi',
    spoken: 'Tóm tắt đọc',
    full: 'Câu trả lời đầy đủ',
    log: 'Log',
    logAll: 'Tất cả',
    logThis: 'Phiên này',
    back: 'Danh sách',
    states: { working: 'Đang làm', waiting_approve: 'Cần approve', waiting_answer: 'Cần trả lời', done: 'Xong' },
    kinds: { prompt: 'bạn gửi', done: 'xong', approve: 'cần approve', question: 'hỏi', decided: 'bạn quyết định', queued: 'xếp hàng', run: 'chạy lệnh xếp hàng' },
    needs: { waiting_approve: 'cần approve', waiting_answer: 'cần bạn trả lời' },
    doneSpeak: 'xong',
    sent: 'Đã gửi',
    now: 'vừa xong', min: ' phút', hour: ' giờ',
  },
  en: {
    title: 'Vi Voice Hub',
    groups: { need: 'Needs you', done: 'Just finished', working: 'Working', idle: 'Idle' },
    tabs: { list: 'Sessions', detail: 'Detail', log: 'Log' },
    none: 'No sessions yet. Type something in Claude Code and it shows up here.',
    pick: 'Pick a session on the left.',
    filter: 'Filter workspaces…',
    newDone: 'new',
    autoRead: 'Auto read',
    stop: 'Stop',
    listen: 'Listen',
    seen: 'Seen',
    approve: 'Approve',
    deny: 'Deny',
    dangerous: 'Dangerous command, confirm by hand in VS Code',
    queue: 'Queue',
    queueHint: 'Runs when this turn finishes',
    idleHint: 'Session is idle, runs on its next turn',
    queued: 'Queued',
    answer: 'Send answer',
    freeAnswer: 'Or answer freely…',
    placeholder: 'Next task for this session…',
    doing: 'Doing',
    asked: 'You asked',
    spoken: 'Spoken summary',
    full: 'Full reply',
    log: 'Log',
    logAll: 'All',
    logThis: 'This session',
    back: 'Sessions',
    states: { working: 'Working', waiting_approve: 'Needs approval', waiting_answer: 'Needs answer', done: 'Done' },
    kinds: { prompt: 'you sent', done: 'finished', approve: 'needs approval', question: 'asked', decided: 'you decided', queued: 'queued', run: 'running queued task' },
    needs: { waiting_approve: 'needs approval', waiting_answer: 'needs your answer' },
    doneSpeak: 'finished',
    sent: 'Sent',
    now: 'now', min: ' min', hour: ' h',
  },
};

export function page(lang: 'vi' | 'en'): string {
  const L = LABELS[lang];
  const voiceLang = lang === 'en' ? 'en-US' : 'vi-VN';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0e1526">
<title>${L.title}</title>
<link rel="icon" href="data:,">
<style>
:root{--bg:#0e1526;--sur:#151d31;--sur2:#1c2640;--line:#27324f;--fg:#e8edf8;--mut:#8b97b8;--need:#ff6f59;--done:#3fd8a0;--work:#f6b73c;--idle:#5b6785;--acc:#7aa2ff}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;display:flex;flex-direction:column;overflow:hidden}
button{font:inherit;border:1px solid var(--line);background:var(--sur2);color:var(--fg);border-radius:10px;padding:8px 14px;min-height:40px;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button.ok{background:var(--done);border-color:var(--done);color:#062a1d;font-weight:700}button.no{background:transparent;border-color:var(--need);color:var(--need)}
button.acc{background:var(--acc);border-color:var(--acc);color:#06122e;font-weight:700}button.on{border-color:var(--acc);color:var(--acc)}button.sm{min-height:32px;padding:4px 10px;font-size:13px}
input{font:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);min-height:40px;flex:1 1 140px;min-width:0}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex:0 0 auto}
header h1{font-size:16px;font-weight:700;margin:0;flex:1 1 auto}header h1 small{color:var(--mut);font-weight:400;font-size:13px;margin-left:8px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--done)}.dot.off{background:var(--need)}
.app{flex:1 1 auto;display:grid;grid-template-columns:320px 1fr;grid-template-rows:1fr auto;min-height:0}
aside{grid-row:1/3;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.filter{padding:10px 12px;border-bottom:1px solid var(--line)}.filter input{width:100%}
.list{overflow:auto;flex:1 1 auto}
.grp{position:sticky;top:0;background:var(--bg);color:var(--mut);font-size:12px;font-weight:600;letter-spacing:.3px;padding:10px 12px 4px;display:flex;gap:8px;align-items:center;z-index:1}
.grp i{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--c)}.grp b{color:var(--fg)}
.grp.need{--c:var(--need)}.grp.done{--c:var(--done)}.grp.working{--c:var(--work)}.grp.idle{--c:var(--idle)}
.row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 12px;cursor:pointer;border-left:3px solid transparent}.row>div{min-width:0}
.row:hover{background:var(--sur)}.row.sel{background:var(--sur2);border-left-color:var(--acc)}
.row i{width:10px;height:10px;border-radius:50%;display:inline-block}.row .n{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .s{color:var(--mut);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .t{color:var(--mut);font-size:12px;text-align:right;white-space:nowrap}
.row.unseen .n::after{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--done);margin-left:6px;vertical-align:middle}
.row.need i{background:var(--need)}.row.done i{background:var(--done)}.row.working i{background:var(--work)}.row.idle i{background:var(--idle)}
.detail{overflow:auto;padding:16px 20px;min-height:0}
.dh{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}.dh .ws{font-size:28px;font-weight:800;letter-spacing:-.3px;line-height:1.1}
.pill{font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px;color:#06122e}.pill.need{background:var(--need)}.pill.done{background:var(--done)}.pill.working{background:var(--work)}.pill.idle{background:var(--idle);color:var(--fg)}
.meta{color:var(--mut);font-size:13px}
.act{background:var(--sur);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
.act.need{border-color:var(--need)}
.q{font-weight:600;font-size:17px;margin:0 0 8px}.code{font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:13px;background:var(--bg);border:1px solid var(--line);padding:8px 10px;border-radius:8px;word-break:break-all;margin:8px 0}
.opts{display:flex;flex-direction:column;gap:6px;margin:6px 0}.opts button{text-align:left}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.mini{color:var(--mut);font-size:13px;margin-top:6px}
h3{font-size:13px;font-weight:600;color:var(--mut);margin:18px 0 6px}
.say{white-space:pre-wrap;word-break:break-word;font-size:16px;line-height:1.55}
pre{white-space:pre-wrap;word-break:break-word;font:13.5px/1.55 ui-monospace,Consolas,"Cascadia Mono",monospace;background:var(--sur);border:1px solid var(--line);border-radius:10px;padding:12px;margin:0}
.empty{color:var(--mut);padding:40px 20px;text-align:center}
.log{grid-column:2;border-top:1px solid var(--line);display:flex;flex-direction:column;height:240px;min-height:0}
.log.closed{height:auto}.log.closed ol{display:none}
.lh{display:flex;align-items:center;gap:10px;padding:6px 14px;color:var(--mut);font-size:13px;flex:0 0 auto}.lh b{color:var(--fg);flex:1 1 auto}
.log ol{list-style:none;margin:0;padding:0 14px 10px;overflow:auto;flex:1 1 auto;min-height:0}.log li{display:grid;grid-template-columns:48px 130px 1fr;gap:10px;padding:4px 0;border-top:1px solid var(--line);font-size:13px}
.log time{color:var(--mut);font-variant-numeric:tabular-nums}.log .w{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.log .k{color:var(--mut)}.log li.sel{background:var(--sur)}
.tabs{display:none}
@media(max-width:800px){
  .app{grid-template-columns:1fr;grid-template-rows:1fr}aside,.detail,.log{display:none;grid-column:1;grid-row:1}
  .app[data-tab=list] aside,.app[data-tab=detail] .detail,.app[data-tab=log] .log{display:flex;flex-direction:column}
  .app[data-tab=detail] .detail{display:block}.app[data-tab=log] .log{height:100%;border-top:0}.log.closed ol{display:block}
  .tabs{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);flex:0 0 auto}
  .tabs button{border:0;border-radius:0;background:var(--bg);padding:10px 0;min-height:48px}.tabs button.on{color:var(--acc);border-top:2px solid var(--acc)}
  .dh .ws{font-size:24px}
}
.toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:999px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9}.toast.show{opacity:1}
@media(prefers-reduced-motion:reduce){.toast{transition:none}}
</style>
</head>
<body>
<header>
  <h1>${L.title}<small id="host"></small></h1>
  <button id="auto" class="sm">🔊 ${L.autoRead}</button>
  <button id="stopread" class="sm">${L.stop}</button>
  <span class="dot" id="dot"></span>
</header>
<div class="app" id="app" data-tab="list">
  <aside>
    <div class="filter"><input id="filter" placeholder="${L.filter}"></div>
    <div class="list" id="list"></div>
  </aside>
  <section class="detail" id="detail"></section>
  <section class="log" id="log"></section>
</div>
<nav class="tabs" id="tabs">
  <button data-tab="list" class="on">${L.tabs.list}</button>
  <button data-tab="detail">${L.tabs.detail}</button>
  <button data-tab="log">${L.tabs.log}</button>
</nav>
<div class="toast" id="toast"></div>
<script>
const L = ${JSON.stringify(L)};
const VOICE_LANG = ${JSON.stringify(voiceLang)};
const base = location.pathname.replace(/\\/+$/, '');
const $ = (id) => document.getElementById(id);
const IDLE_MS = 3600000;
let state = { sessions: [], events: [], now: Date.now() };
let selected = localStorage.getItem('hub.sel') || '';
let filterText = '';
let logAll = true;
let logOpen = localStorage.getItem('hub.logOpen') !== '0';
let auto = localStorage.getItem('hub.auto') === '1';
let seen = {};
try { seen = JSON.parse(localStorage.getItem('hub.seen') || '{}'); } catch {}
const known = new Map();
const drafts = new Map();

function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1600); }
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function ago(ms){ const s=Math.max(0,Math.floor(ms/1000)); if(s<45) return L.now; if(s<3600) return Math.floor(s/60)+L.min; return Math.floor(s/3600)+L.hour; }
function clock(ms){ const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function isUnseen(s){ return s.state==='done' && !!s.lastSpoken && seen[s.session] !== s.updatedAt; }
function markSeen(s){ seen[s.session]=s.updatedAt; localStorage.setItem('hub.seen', JSON.stringify(seen)); render(); }
function groupOf(s){ if(s.state.startsWith('waiting')) return 'need'; if(s.state==='working') return 'working'; return (state.now - s.updatedAt < IDLE_MS || isUnseen(s)) ? 'done' : 'idle'; }
function stamp(s){ return s.pending ? s.pending.since : s.updatedAt; }
function summary(s){
  if(s.pending&&s.pending.kind==='approve') return (s.pending.toolName||'')+(s.pending.summary?': '+s.pending.summary:'');
  if(s.pending&&s.pending.kind==='question') return s.pending.question||'';
  if(s.state==='working') return s.lastPrompt||'';
  return s.lastSpoken||s.lastPrompt||'';
}

function pickVoice(){ const vs=speechSynthesis.getVoices(); return vs.find(v=>v.lang===VOICE_LANG)||vs.find(v=>v.lang&&v.lang.startsWith(VOICE_LANG.slice(0,2)))||null; }
function speak(text){ if(!('speechSynthesis' in window)||!text) return; const u=new SpeechSynthesisUtterance(text); u.lang=VOICE_LANG; const v=pickVoice(); if(v) u.voice=v; speechSynthesis.speak(u); }
$('stopread').onclick=()=>speechSynthesis.cancel();
$('auto').onclick=()=>{ auto=!auto; localStorage.setItem('hub.auto',auto?'1':'0'); $('auto').classList.toggle('on',auto); if(auto) speak(L.title); };
$('auto').classList.toggle('on',auto);

async function api(path, body){
  const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||r.status); return j;
}

function announce(next){
  const first = known.size===0;
  for(const s of next.sessions){
    const prev=known.get(s.session)||{};
    const spokenKey = s.lastSpoken ? s.updatedAt+':'+s.lastSpoken.slice(0,40) : '';
    const pendingKey = s.pending ? s.pending.since : 0;
    if(!first && auto){
      if(spokenKey && spokenKey!==prev.spokenKey && s.state==='done') speak(s.workspace+' '+L.doneSpeak+': '+s.lastSpoken);
      if(pendingKey && pendingKey!==prev.pendingKey) speak(s.workspace+' '+(L.needs[s.state]||''));
    }
    known.set(s.session,{spokenKey,pendingKey});
  }
}

function select(id, goDetail){
  selected=id; localStorage.setItem('hub.sel',id);
  if(goDetail) setTab('detail');
  render();
}
function setTab(t){ $('app').dataset.tab=t; for(const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab===t); }

function renderList(){
  const q=filterText.trim().toLowerCase();
  const groups={need:[],done:[],working:[],idle:[]};
  for(const s of state.sessions){ if(q && !s.workspace.toLowerCase().includes(q)) continue; groups[groupOf(s)].push(s); }
  groups.need.sort((a,b)=>stamp(a)-stamp(b));
  groups.done.sort((a,b)=>(isUnseen(b)-isUnseen(a))||(b.updatedAt-a.updatedAt));
  groups.working.sort((a,b)=>b.updatedAt-a.updatedAt);
  groups.idle.sort((a,b)=>b.updatedAt-a.updatedAt);
  let html='';
  for(const g of ['need','done','working','idle']){
    if(!groups[g].length) continue;
    const unseen=g==='done'?groups[g].filter(isUnseen).length:0;
    html+='<div class="grp '+g+'"><i></i>'+L.groups[g]+' <b>'+(unseen?unseen+'/':'')+groups[g].length+'</b></div>';
    html+=groups[g].map(s=>'<div class="row '+g+(s.session===selected?' sel':'')+(isUnseen(s)?' unseen':'')+'" data-id="'+esc(s.session)+'"><i></i><div><div class="n">'+esc(s.workspace)+'</div><div class="s">'+esc(summary(s))+'</div></div><div class="t">'+ago(state.now-stamp(s))+'</div></div>').join('');
  }
  $('list').innerHTML=html||'<div class="empty">'+L.none+'</div>';
  const need=groups.need.length; document.title=(need?'('+need+') ':'')+L.title;
}

function renderDetail(){
  const s=state.sessions.find(x=>x.session===selected);
  if(!s){ $('detail').innerHTML='<div class="empty">'+(state.sessions.length?L.pick:L.none)+'</div>'; return; }
  const g=groupOf(s); const unseen=isUnseen(s);
  let html='<div class="dh"><div class="ws">'+esc(s.workspace)+'</div><span class="pill '+g+'">'+(L.states[s.state]||s.state)+'</span>'+(unseen?'<span class="pill done">'+L.newDone+'</span>':'')+'<span class="meta">'+ago(state.now-stamp(s))+' · '+clock(stamp(s))+'</span></div>';
  html+='<div class="meta">'+esc(s.cwd)+' · '+esc(s.session.slice(0,8))+'</div>';
  if(s.pending&&s.pending.kind==='approve'){
    html+='<div class="act need"><div class="q">'+esc(s.pending.toolName||'')+'</div>'+(s.pending.summary?'<div class="code">'+esc(s.pending.summary)+'</div>':'')+(s.pending.dangerous?'<div class="mini">⚠️ '+L.dangerous+'</div>':'')
      +'<div class="bar"><button class="ok" data-act="allow"'+(s.pending.dangerous?' disabled':'')+'>'+L.approve+'</button><button class="no" data-act="deny">'+L.deny+'</button></div></div>';
  } else if(s.pending&&s.pending.kind==='question'){
    const picks=drafts.get(s.session+':picks')||[];
    html+='<div class="act need"><div class="q">'+esc(s.pending.question||'')+'</div>';
    if(s.pending.options&&s.pending.options.length){
      html+='<div class="opts">'+s.pending.options.map((o,i)=>'<button data-act="pick" data-i="'+i+'"'+(picks.includes(i)?' class="on"':'')+'>'+(i+1)+'. '+esc(o)+'</button>').join('')+'</div>';
      if(s.pending.multiSelect) html+='<div class="bar"><button class="acc" data-act="answer-picks"'+(picks.length?'':' disabled')+'>'+L.answer+'</button></div>';
    }
    html+='<div class="bar"><input data-field="free" placeholder="'+L.freeAnswer+'" value="'+esc(drafts.get(s.session+':free')||'')+'"><button class="acc" data-act="answer-free">'+L.answer+'</button></div></div>';
  } else {
    html+='<div class="act"><div class="bar"><input data-field="send" placeholder="'+L.placeholder+'" value="'+esc(drafts.get(s.session+':send')||'')+'"><button class="acc" data-act="send">'+L.queue+'</button></div>'
      +'<div class="mini">'+(s.state==='done'?L.idleHint:L.queueHint)+(s.queued?' · ⏳ '+L.queued+': '+esc(s.queued):'')+'</div></div>';
  }
  if(s.state==='working'&&s.lastPrompt) html+='<h3>'+L.doing+'</h3><div class="say">'+esc(s.lastPrompt)+'</div>';
  if(s.lastSpoken){ html+='<h3>'+L.spoken+'</h3><div class="say">'+esc(s.lastSpoken)+'</div><div class="bar"><button class="sm" data-act="replay">🔊 '+L.listen+'</button>'+(unseen?'<button class="sm" data-act="seen">'+L.seen+'</button>':'')+'</div>'; }
  if(s.lastFull) html+='<h3>'+L.full+'</h3><pre>'+esc(s.lastFull)+'</pre>';
  if(s.state!=='working'&&s.lastPrompt) html+='<h3>'+L.asked+'</h3><div class="mini">'+esc(s.lastPrompt)+'</div>';
  $('detail').innerHTML=html;
}

function renderLog(){
  const ev=(state.events||[]).filter(e=>logAll||e.session===selected).slice(0,60);
  $('log').className='log'+(logOpen?'':' closed');
  $('log').innerHTML='<div class="lh"><b>'+L.log+' '+ev.length+'</b><button class="sm'+(logAll?' on':'')+'" data-log="all">'+L.logAll+'</button><button class="sm'+(!logAll?' on':'')+'" data-log="this">'+L.logThis+'</button><button class="sm" data-log="toggle">'+(logOpen?'▾':'▴')+'</button></div>'
    +'<ol>'+ev.map(e=>'<li'+(e.session===selected?' class="sel"':'')+' data-id="'+esc(e.session)+'"><time>'+clock(e.at)+'</time><span class="w">'+esc(e.workspace)+'</span><span><span class="k">'+(L.kinds[e.kind]||e.kind)+'</span>'+(e.text?' '+esc(e.text):'')+'</span></li>').join('')+'</ol>';
}

function render(){
  $('host').textContent=state.host||'';
  if(!state.sessions.find(s=>s.session===selected)){
    const need=state.sessions.find(s=>s.state.startsWith('waiting')); selected=need?need.session:(state.sessions[0]?state.sessions[0].session:'');
  }
  renderList(); renderDetail(); renderLog();
}

$('filter').addEventListener('input',(e)=>{ filterText=e.target.value; renderList(); });
$('list').addEventListener('click',(e)=>{ const row=e.target.closest('.row'); if(row) select(row.dataset.id,true); });
$('log').addEventListener('click',(e)=>{
  const b=e.target.closest('button'); if(b&&b.dataset.log){ if(b.dataset.log==='all') logAll=true; else if(b.dataset.log==='this') logAll=false; else { logOpen=!logOpen; localStorage.setItem('hub.logOpen',logOpen?'1':'0'); } renderLog(); return; }
  const li=e.target.closest('li'); if(li&&li.dataset.id) select(li.dataset.id,true);
});
$('tabs').addEventListener('click',(e)=>{ const b=e.target.closest('button'); if(b) setTab(b.dataset.tab); });
document.addEventListener('keydown',(e)=>{
  if(e.target.tagName==='INPUT') return;
  const rows=[...$('list').querySelectorAll('.row')].map(r=>r.dataset.id); const i=rows.indexOf(selected);
  if(e.key==='ArrowDown'&&rows.length){ select(rows[Math.min(rows.length-1,i+1)]); e.preventDefault(); }
  if(e.key==='ArrowUp'&&rows.length){ select(rows[Math.max(0,i-1)]); e.preventDefault(); }
});
$('detail').addEventListener('input',(e)=>{ const inp=e.target; if(inp.dataset&&inp.dataset.field) drafts.set(selected+':'+inp.dataset.field, inp.value); });
$('detail').addEventListener('keydown',(e)=>{ if(e.key!=='Enter') return; const inp=e.target; if(!inp.dataset||!inp.dataset.field) return; const btn=inp.parentElement.querySelector('button'); if(btn) btn.click(); });
$('detail').addEventListener('click',async(e)=>{
  const btn=e.target.closest('button'); if(!btn||!btn.dataset.act) return;
  const session=selected; const s=state.sessions.find(x=>x.session===session); if(!s) return; const act=btn.dataset.act;
  try{
    if(act==='replay'){ speak(s.lastSpoken); markSeen(s); }
    else if(act==='seen') markSeen(s);
    else if(act==='allow'||act==='deny'){ await api('/api/decide',{session,decision:act}); toast(L.sent); }
    else if(act==='pick'){ const i=Number(btn.dataset.i); if(s.pending.multiSelect){ const k=session+':picks'; const cur=drafts.get(k)||[]; drafts.set(k,cur.includes(i)?cur.filter(x=>x!==i):[...cur,i]); renderDetail(); } else { await api('/api/decide',{session,answer:[i]}); toast(L.sent); } }
    else if(act==='answer-picks'){ await api('/api/decide',{session,answer:drafts.get(session+':picks')||[]}); drafts.delete(session+':picks'); toast(L.sent); }
    else if(act==='answer-free'){ const t=(drafts.get(session+':free')||'').trim(); if(!t) return; await api('/api/decide',{session,answer:t}); drafts.delete(session+':free'); toast(L.sent); }
    else if(act==='send'){ const t=(drafts.get(session+':send')||'').trim(); if(!t) return; await api('/api/send',{session,text:t}); drafts.delete(session+':send'); toast(L.sent); }
  }catch(err){ toast(String(err.message||err)); }
});

function apply(next){ announce(next); state=next; render(); }
async function load(){ try{ apply(await (await fetch(base+'/api/state')).json()); }catch{} }
function connect(){ const es=new EventSource(base+'/api/events'); es.addEventListener('state',(ev)=>{ $('dot').classList.remove('off'); apply(JSON.parse(ev.data)); }); es.onerror=()=>$('dot').classList.add('off'); }
setInterval(()=>{ if(state.sessions.length){ state.now=Date.now(); renderList(); } },30000);
load(); connect();
</script>
</body>
</html>`;
}
