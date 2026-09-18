const tg = window.Telegram?.WebApp;
const el = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? `$${Number(value).toFixed(2)}` : '—';
const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let battleId, user, state, stream, accountInfo, requestBusy = false, serverOffset = 0, lastServerNow = 0;
const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('tgWebAppStartParam');
function drawChart(points, startPrice) {
  const canvas = el('chart'), ctx = canvas.getContext('2d');
  const scale = devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * scale; canvas.height = height * scale; ctx.scale(scale, scale);
  ctx.clearRect(0,0,width,height);
  if (!points?.length) return;
  const values = points.map(p => p.price), low = Math.min(...values,startPrice || Infinity), high = Math.max(...values,startPrice || -Infinity), span = Math.max(high-low,.01), pad=15;
  const y = v => height-pad-(v-low)/span*(height-pad*2), x = i => points.length===1 ? width/2 : i/(points.length-1)*width;
  if (startPrice) { ctx.setLineDash([5,5]); ctx.strokeStyle='#7b85a4'; ctx.beginPath();ctx.moveTo(0,y(startPrice));ctx.lineTo(width,y(startPrice));ctx.stroke();ctx.setLineDash([]); }
  ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(x(i),y(p.price)):ctx.moveTo(x(i),y(p.price)));
  ctx.strokeStyle=values.at(-1)>=values[0]?'#76f1b0':'#ff758b';ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.stroke();
  ctx.lineTo(x(points.length-1),height);ctx.lineTo(x(0),height);ctx.closePath();const fill=ctx.createLinearGradient(0,0,0,height);fill.addColorStop(0,'#76f1b033');fill.addColorStop(1,'#76f1b000');ctx.fillStyle=fill;ctx.fill();
}
async function api(path, method='GET', data) {
  const res=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined});
  const json=await res.json();if(!res.ok)throw new Error(json.error||'Request failed');return json;
}
async function action(name,data) {
  if(requestBusy)return;requestBusy=true;
  try { const result=await api(`/api/battles/${battleId}/${name}`,'POST',data); if(name==='rematch') { tg?.openTelegramLink?.(result.url); } else render(result); }
  catch(error){if(tg?.showAlert)tg.showAlert(error.message);else alert(error.message);} finally {requestBusy=false;}
}
window.doAction=action;
function showAccount(info) {
  accountInfo=info;
  el('balance').textContent=`${info.account.balance} XP`;
  el('inviteLink').textContent=info.referralLink;
  el('referralCount').textContent=`${info.referralCount} friend${info.referralCount===1?'':'s'} invited`;
}
window.shareInvite=()=>{
  if(!accountInfo)return;
  const url=`https://t.me/share/url?url=${encodeURIComponent(accountInfo.referralLink)}&text=${encodeURIComponent('Join me for SOL Quick Battle!')}`;
  if(tg?.openTelegramLink)tg.openTelegramLink(url);else window.open(url,'_blank');
};
function render(data) {
  if(data.serverNow !== lastServerNow){serverOffset=data.serverNow-Date.now();lastServerNow=data.serverNow;}state=data; const b=data.battle, now=Date.now()+serverOffset, remaining= b.status==='countdown'?Math.max(0,b.countdown_at-now):b.status==='live'?Math.max(0,b.end_at-now):0;
  el('balance').textContent=`${data.account.balance} XP`;
  el('price').textContent=money(data.quote?.price || b.end_price || b.start_price);el('startPrice').textContent=money(b.start_price);
  const change=b.start_price&&data.quote ? (data.quote.price/b.start_price-1)*100 : null;
  el('delta').textContent=change===null?'Waiting for market data':`${change>=0?'+':''}${change.toFixed(3)}% from round start`;
  el('delta').className='delta '+(change===null?'':change>=0?'green':'red');
  el('feedTime').textContent=data.quote?new Date(data.quote.at).toLocaleTimeString():'FEED PAUSED';
  el('timer').textContent=b.status==='countdown'?`STARTS IN ${Math.ceil(remaining/1000)}`:b.status==='live'?`00:${String(Math.ceil(remaining/1000)).padStart(2,'0')}`:b.status==='lobby'?'READY UP':b.status==='finished'?'FINISHED':'VOID';
  drawChart(data.chart,b.start_price);
  const mine=data.players.find(p=>p.user_id===String(user.id));
  let html='';
  if(b.status==='lobby') html=`<h1>Join the battle</h1><p>Stake ${b.stake} XP when you ready up. Winners split the pool. Same start and end price: house wins and all stakes burn. Two players minimum.</p>${!mine?'<button class="primary" onclick="doAction(\'join\')">JOIN BATTLE</button>':!mine.ready?'<button class="primary" onclick="doAction(\'ready\')">I’M READY</button>':'<button class="secondary" disabled>READY · WAITING FOR PLAYERS</button>'}`;
  else if(b.status==='countdown') html='<h1>Get ready</h1><p>The round begins when a fresh market price is captured.</p>';
  else if(b.status==='live') {
    const locked=now>=b.lock_at;
    html=`<h1>${locked?'Picks are locked': 'Where will SOL finish?'}</h1><p>${mine?.prediction?`Your pick: ${mine.prediction}`:locked?'Watch the price until the finish.':'Choose in the first 10 seconds.'} · ${b.stake} XP stake</p><div class="choiceGrid"><button class="choice long ${mine?.prediction==='LONG'?'selected':''}" ${locked||mine?.prediction||!mine?'disabled':''} onclick="doAction('predict',{side:'LONG'})"><b>↑</b>LONG</button><button class="choice short ${mine?.prediction==='SHORT'?'selected':''}" ${locked||mine?.prediction||!mine?'disabled':''} onclick="doAction('predict',{side:'SHORT'})"><b>↓</b>SHORT</button></div><div class="small">${locked?'Prediction window closed':`Picks lock in ${Math.max(0,Math.ceil((b.lock_at-now)/1000))}s`}</div>`;
  } else html=`<h1 class="result ${b.outcome?.toLowerCase()||''}">${b.status==='void'?'ROUND VOID':b.outcome==='TIE'?'IT’S A TIE':`${b.outcome} WINS`}</h1><p>${b.status==='void'?'All stakes refunded.':`${money(b.start_price)} → ${money(b.end_price)} · ${mine?.prediction?`Your pick: ${mine.prediction}`:'No pick'}. ${b.outcome==='HOUSE'?'All staked XP burned.':b.outcome==='TIE'?'All stakes refunded.':'Winners split the XP pool.'}`}</p><button class="primary" onclick="doAction('rematch')">REMATCH · ${b.stake||10} XP</button>`;
  el('content').innerHTML=html;
  el('playerCount').textContent=`${data.players.length} joined`;
  el('players').innerHTML=data.players.length?data.players.map(p=>`<div class="row"><span>${safe(p.name)} ${p.user_id===String(user.id)?'· YOU':''}</span><small class="${p.prediction==='LONG'?'green':p.prediction==='SHORT'?'red':''}">${p.prediction|| (p.ready?'READY':'JOINED')}</small></div>`).join(''):'<div class="empty">Waiting for players</div>';
  el('myStats').innerHTML=data.me?`<div><strong>${data.me.wins}</strong><small>WINS</small></div><div><strong>${data.me.losses}</strong><small>LOSSES</small></div><div><strong>${data.me.streak}</strong><small>STREAK</small></div><div><strong>${data.me.xp}</strong><small>NET XP</small></div>`:'<div class="empty">Play a round to record your stats.</div>';
  el('leaderboard').innerHTML=data.leaderboard.length?data.leaderboard.slice(0,5).map((p,i)=>`<div class="row"><span>${i+1}. ${safe(p.name)}</span><small>${p.xp} XP · ${p.wins}W</small></div>`).join(''):'<div class="empty">First result starts the leaderboard</div>';
}
async function boot(){
  tg?.ready();tg?.expand();
  if(!tg?.initData){el('content').innerHTML='<h1>Open in Telegram</h1><p>Use the Join Battle button in your group chat.</p>';return;}
  try {
    const session=await api('/api/session','POST',{initData:tg.initData});user=session.user;
    showAccount(await api('/api/me'));
    setInterval(async()=>{try{showAccount(await api('/api/me'));}catch{}},30000);
    battleId=session.startParam||startParam;
    if(!battleId) { document.body.classList.add('home'); el('content').innerHTML='<h1>Ready to play?</h1><p>Add the bot to a group and send /battle to choose a stake. Share your invite link below for 100 XP per new friend.</p>'; return; }
    if(!/^[a-f0-9]{16}$/.test(battleId))throw new Error('Open a battle link from your Telegram group.');
    render(await api(`/api/battles/${battleId}`));
    stream=new EventSource(`/api/battles/${battleId}/events`);
    stream.onmessage=event=>render(JSON.parse(event.data));
    stream.onerror=()=>{el('feedTime').textContent='RECONNECTING';};
    setInterval(()=>{if(state)render(state);},250);
  } catch(error){el('content').innerHTML=`<h1>Cannot open battle</h1><p>${safe(error.message)}</p>`;}
}
boot();
