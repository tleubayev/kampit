const tg = window.Telegram?.WebApp;
const el = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? `$${Number(value).toFixed(2)}` : '—';
const direction = value => value === 'LONG' ? 'UP' : value === 'SHORT' ? 'DOWN' : value;
const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let battleId, state, stream, accountInfo, requestBusy = false, serverOffset = 0, lastServerNow = 0;
let readyPaymentBusy = false;
let payInfo;
const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('tgWebAppStartParam');
const windowBattle = new URLSearchParams(location.search).get('battle');
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
async function openBattle(id, updateAddress=false) {
  if(!/^[a-f0-9]{16}$/.test(id))throw new Error('Open a battle link from your Telegram group.');
  stream?.close();stream=undefined;state=undefined;lastServerNow=0;battleId=id;
  if(updateAddress){const url=new URL(location.href);url.searchParams.set('battle',id);history.replaceState({},'',url);}
  const initial=await api(`/api/battles/${battleId}`); render(initial);
  if(initial.battle.mode==='USDC_TEST'){const [info,history]=await Promise.all([api('/api/pay'),api('/api/pay/history')]);payInfo={...info,...history};render(initial);}
  stream=new EventSource(`/api/battles/${battleId}/events`);
  stream.onmessage=event=>render(JSON.parse(event.data));
  stream.onerror=()=>{el('feedTime').textContent='RECONNECTING';};
}
async function action(name,data) {
  if(requestBusy)return;requestBusy=true;if(name==='ready'&&state?.battle?.mode==='USDC_TEST'){readyPaymentBusy=true;render(state);}
  try { const result=await api(`/api/battles/${battleId}/${name}`,'POST',data); if(name==='rematch') await openBattle(result.id,true); else { if(result.battle?.mode==='USDC_TEST'&&name==='ready'){const [info,history]=await Promise.all([api('/api/pay'),api('/api/pay/history')]);payInfo={...info,...history};} render(result); } }
  catch(error){if(tg?.showAlert)tg.showAlert(error.message);else alert(error.message);} finally {requestBusy=false;readyPaymentBusy=false;if(state)render(state);}
}
window.doAction=action;
window.claimTestUsdc=async()=>{if(requestBusy)return;requestBusy=true;try{const result=await api('/api/pay/faucet','POST');payInfo={...payInfo,balanceMinor:result.balanceMinor,faucet:{amountMinor:result.amountMinor,claimed:result.claimed,state:result.state,signature:result.signature,claimedAt:result.claimedAt},transactions:result.transactions};if(state)render(state);const message=result.claimed?'1 test USDC is now in your Kampit wallet.':'Claim is being processed.';if(tg?.showAlert)tg.showAlert(message);else alert(message);}catch(error){if(tg?.showAlert)tg.showAlert(error.message);else alert(error.message);}finally{requestBusy=false;}};
window.submitWithdrawal=async()=>{const recipient=el('withdrawAddress')?.value.trim(),amount=Number(el('withdrawAmount')?.value);if(!recipient||!Number.isFinite(amount))return;try{const result=await api('/api/pay/withdrawals','POST',{requestId:crypto.randomUUID().replaceAll('-',''),recipient,amountMinor:Math.round(amount*1e6)});payInfo={...payInfo,balanceMinor:result.balanceMinor,transactions:result.transactions};if(state)render(state);if(result.status==='approval_required'){const message='Withdrawal submitted for admin approval.';if(tg?.showAlert)tg.showAlert(message);else alert(message);}}catch(error){if(tg?.showAlert)tg.showAlert(error.message);else alert(error.message);}};
function payTools(){if(!payInfo)return'';const transactions=(payInfo.transactions||[]).slice(0,8),faucet=payInfo.faucet;const claim=faucet&&!faucet.claimed?`<button class="primary faucetClaim" onclick="claimTestUsdc()" ${faucet.state==='pending'||faucet.state==='signed'?'disabled':''}>${faucet.state==='pending'||faucet.state==='signed'?'CLAIM PROCESSING':'CLAIM 1 TEST USDC'}</button>`:`<div class="small green">✓ 1 test USDC welcome claim used</div>`;return `<div class="payTools"><div class="payTitle"><b>TEST USDC WALLET</b><span>${(payInfo.balanceMinor/1e6).toFixed(2)} USDC</span></div>${claim}<div class="small">Official Circle Devnet USDC · one welcome claim per Telegram account · no monetary value</div><div class="walletAddress">${safe(payInfo.walletAddress)}</div><div class="withdrawGrid"><input id="withdrawAddress" autocomplete="off" placeholder="Solana withdrawal address"><input id="withdrawAmount" inputmode="decimal" placeholder="USDC amount"><button class="secondary" onclick="submitWithdrawal()">WITHDRAW</button></div><div class="small">Limits: 0.10–20 USDC per withdrawal · 100 USDC per 24 hours</div><div class="txList">${transactions.length?transactions.map(tx=>`<div class="txRow"><span>${tx.id?.startsWith('faucet:')?'WELCOME CLAIM':safe(tx.kind).toUpperCase()} · ${(tx.amountMinor/1e6).toFixed(2)}</span><a class="${tx.state==='confirmed'?'green':tx.state==='failed'?'red':'purple'}" ${tx.explorerUrl?`href="${safe(tx.explorerUrl)}" target="_blank"`:''}>${safe(tx.state).toUpperCase()}</a></div>`).join(''):'<div class="small">No transactions yet.</div>'}</div></div>`;}
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
  if(data.serverNow !== lastServerNow){serverOffset=data.serverNow-Date.now();lastServerNow=data.serverNow;}state=data; const b=data.battle, now=Date.now()+serverOffset, remaining= b.status==='lobby'&&b.lobby_deadline?Math.max(0,b.lobby_deadline-now):b.status==='countdown'?Math.max(0,b.countdown_at-now):b.status==='live'?Math.max(0,b.end_at-now):0;
  const paid=b.mode==='USDC_TEST', stakeLabel=paid?`${(b.stakeMinor/1e6).toFixed(2)} TEST USDC`:`${b.stake} XP`;
  el('balance').textContent=paid&&payInfo?`${(payInfo.balanceMinor/1e6).toFixed(2)} tUSDC`:`${data.account.balance} XP`;
  el('price').textContent=money(data.quote?.price || b.end_price || b.start_price);el('startPrice').textContent=money(b.start_price);
  const change=b.start_price&&data.quote ? (data.quote.price/b.start_price-1)*100 : null;
  el('delta').textContent=change===null?'Waiting for market data':`${change>=0?'+':''}${change.toFixed(3)}% from round start`;
  el('delta').className='delta '+(change===null?'':change>=0?'green':'red');
  el('feedTime').textContent=data.quote?new Date(data.quote.at).toLocaleTimeString():'FEED PAUSED';
  el('timer').textContent=b.status==='countdown'?`STARTS IN ${Math.ceil(remaining/1000)}`:b.status==='live'?`00:${String(Math.ceil(remaining/1000)).padStart(2,'0')}`:b.status==='lobby'&&b.lobby_deadline?`LOBBY 00:${String(Math.ceil(remaining/1000)).padStart(2,'0')}`:b.status==='lobby'?'READY UP':b.status==='finished'?'FINISHED':'VOID';
  drawChart(data.chart,b.start_price);
  const mine=data.players.find(p=>p.isYou);
  let html='';
  if(b.status==='lobby') {
    const readyCount=data.players.filter(p=>p.ready).length, creator=b.isCreator;
    const action=!mine?'<button class="primary" onclick="doAction(\'join\')">JOIN BATTLE</button>':!mine.ready?`<button class="primary" onclick="doAction('ready')" ${readyPaymentBusy?'disabled':''}>${readyPaymentBusy?'CONFIRMING STAKE…':'I’M READY'}</button>`:'<button class="secondary" disabled>READY · WAITING FOR PLAYERS</button>';
    const start=creator&&readyCount>=2?'<button class="primary" onclick="doAction(\'start\')">START NOW</button>':'';
    const pool=readyCount*(b.stakeMinor||0),fee=Math.floor(pool*.01),prize=pool-fee;
    const terms=paid?`<div class="paymentSummary"><span>FUNDED PLAYERS <b>${data.paymentProgress?.fundedPlayers||0}/${b.maxPlayers}</b></span><span>POOL <b>${(pool/1e6).toFixed(2)} USDC</b></span><span>1% FEE <b>${(fee/1e6).toFixed(3)} USDC</b></span><span>WINNER POOL <b>${(prize/1e6).toFixed(3)} USDC</b></span></div>`:'';
    html=`<h1>${paid?'Devnet pay battle':'Join the battle'}</h1><p>${paid?'Test tokens have no monetary value. ':''}Stake ${stakeLabel} when you ready up. The 30-second lobby timer begins after the first stake confirms. Unfunded players are excluded. ${readyCount} ready.</p>${terms}${action}${start}${paid?payTools():''}`;
  }
  else if(b.status==='countdown') html='<h1>Get ready</h1><p>The round begins when a fresh market price is captured.</p>';
  else if(b.status==='live') {
    const locked=now>=b.lock_at;
    html=`<h1>${locked?'Picks are locked': 'Where will SOL finish?'}</h1><p>${mine?.prediction?`Your pick: ${direction(mine.prediction)}`:locked?'Watch the price until the finish.':'Choose in the first 10 seconds.'} · ${stakeLabel} stake</p><div class="choiceGrid"><button class="choice long ${mine?.prediction==='LONG'?'selected':''}" ${locked||mine?.prediction||!mine?'disabled':''} onclick="doAction('predict',{side:'LONG'})"><b>↑</b>UP</button><button class="choice short ${mine?.prediction==='SHORT'?'selected':''}" ${locked||mine?.prediction||!mine?'disabled':''} onclick="doAction('predict',{side:'SHORT'})"><b>↓</b>DOWN</button></div><div class="small">${locked?'Prediction window closed':`Picks lock in ${Math.max(0,Math.ceil((b.lock_at-now)/1000))}s`}</div>`;
  } else {const progress=data.paymentProgress,settlement=paid?(b.settlementStatus==='settled'?'Settlement complete.':`Settlement: ${progress?.confirmedSettlementPayments||0}/${progress?.expectedSettlementPayments||0} payments confirmed.${progress?.delayed?' Taking longer than expected; recovery remains active.':''}`):'';html=`<h1 class="result ${b.outcome?.toLowerCase()||''}">${b.status==='void'?'ROUND VOID':b.outcome==='TIE'?'IT’S A TIE':`${direction(b.outcome)} WINS`}</h1><p>${b.status==='void'?'All stakes refunded.':`${money(b.start_price)} → ${money(b.end_price)} · ${mine?.prediction?`Your pick: ${direction(mine.prediction)}`:'No pick'}. ${b.outcome==='HOUSE'?'The test house keeps the entire pool.':b.outcome==='TIE'?'All stakes refunded.':`Winners split the ${paid?'test-USDC pool after a 1% house fee':'XP pool'}.`}`} ${settlement}</p><button class="primary" onclick="doAction('rematch')">REMATCH · ${stakeLabel}</button>`;}
  el('content').innerHTML=html;
  el('playerCount').textContent=paid?`${data.players.length}/${b.maxPlayers} joined · ${data.paymentProgress?.fundedPlayers||0} funded`:`${data.players.length} / ${b.maxPlayers} joined`;
  el('players').innerHTML=data.players.length?data.players.map(p=>`<div class="row"><span>${safe(p.name)} ${p.isYou?'· YOU':''}</span><small class="${p.prediction==='LONG'?'green':p.prediction==='SHORT'?'red':''}">${direction(p.prediction)|| (p.ready?'READY':'JOINED')}</small></div>`).join(''):'<div class="empty">Waiting for players</div>';
  el('myStats').innerHTML=data.me?`<div><strong>${data.me.wins}</strong><small>WINS</small></div><div><strong>${data.me.losses}</strong><small>LOSSES</small></div><div><strong>${data.me.streak}</strong><small>STREAK</small></div><div><strong>${data.me.xp}</strong><small>NET XP</small></div>`:'<div class="empty">Play a round to record your stats.</div>';
  el('leaderboard').innerHTML=data.leaderboard.length?data.leaderboard.slice(0,5).map((p,i)=>`<div class="row"><span>${i+1}. ${safe(p.name)}</span><small>${p.xp} XP · ${p.wins}W</small></div>`).join(''):'<div class="empty">First result starts the leaderboard</div>';
}
async function boot(){
  tg?.ready();tg?.expand();
  if(!tg?.initData){document.body.classList.add('marketing');return;}
  try {
    const session=await api('/api/session','POST',{initData:tg.initData});
    showAccount(await api('/api/me'));
    setInterval(async()=>{try{showAccount(await api('/api/me'));}catch{}},30000);
    battleId=windowBattle||session.startParam||startParam;
    if(!battleId) { document.body.classList.add('home'); el('content').innerHTML='<h1>Ready to play?</h1><p>Add the bot to a group and send /battle to choose a stake. Share your invite link below for 100 XP per new friend.</p>'; return; }
    await openBattle(battleId);
    setInterval(()=>{if(state)render(state);},250);
  } catch(error){el('content').innerHTML=`<h1>Cannot open battle</h1><p>${safe(error.message)}</p>`;}
}
boot();
