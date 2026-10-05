/* Savius Account Monitor. Static, read-only snapshot consumer. */
'use strict';
const $ = (id) => document.getElementById(id);
const OFFLINE_MODE = document.querySelector('meta[name="snapshot-mode"]')?.content==='offline';
const STORAGE_KEY = 'savius-account-monitor-view-v1';
const COLUMNS = [
  {key:'customer',label:'Customer'}, {key:'email',label:'Email'},
  {key:'size',label:'Account size'}, {key:'count',label:'Same-size active'},
  {key:'accounts',label:'Account numbers'}, {key:'progress',label:'Highest progress'},
  {key:'risk',label:'Payout proximity'}, {key:'failed',label:'Confirmed failures'},
  {key:'payout',label:'Completed payout accounts'}, {key:'total',label:'All active accounts'}
];
const BAND_LABEL = {green:'Below 80%',orange:'80% to below 86%',red:'86% or higher',unknown:'Unavailable'};
const RISK_LABEL = {green:'Lower',orange:'Watch',red:'High',unknown:'Incomplete'};
const RISK_RANK = {red:3,orange:2,unknown:1,green:0};
const DEFAULT = {search:'',size:'all',count:'all',progress:'all',risk:'all',dense:false,sort:'risk',direction:'desc',columns:COLUMNS.map(c=>c.key),hidden:[],page:1};
let view = {...DEFAULT, columns:[...DEFAULT.columns],hidden:[]};
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (stored && typeof stored === 'object') {
    view = {...view,...stored,page:1};
    view.columns = [...new Set([...(Array.isArray(stored.columns)?stored.columns:[]),...DEFAULT.columns])].filter(k=>DEFAULT.columns.includes(k));
    view.hidden = (Array.isArray(stored.hidden)?stored.hidden:[]).filter(k=>DEFAULT.columns.includes(k) && k!=='customer');
  }
} catch (_) { /* Local settings are optional. */ }
for(const [key,options] of Object.entries({size:['all','150000','300000'],count:['all','3','4','5'],progress:['all','green','orange','red','unknown'],risk:['all','green','orange','red','unknown'],sort:DEFAULT.columns,direction:['asc','desc']}))if(!options.includes(view[key]))view[key]=DEFAULT[key];
view.search=typeof view.search==='string'?view.search:'';
let snapshot=null, refreshStatus=null, statusFailed=false, rows=[], filtered=[], expanded=new Set(), loading=false, loadFailed=false, dragKey=null, toastTimer;
const PAGE_SIZE=20;
const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const countText = v => number(v)===null ? 'Unknown' : v.toLocaleString('en-US');
const percent = v => number(v)===null ? 'Unavailable' : `${v.toLocaleString('en-US',{maximumFractionDigits:1})}%`;
const escapeHTML = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = escapeHTML;
const band = v => number(v)===null ? 'unknown' : v>=86 ? 'red' : v>=80 ? 'orange' : 'green';
const money = v => number(v)!==null ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v) : (typeof v==='string' && v.trim() ? v : 'Unknown');
function dateText(v, includeTime=true){
  if(!v) return 'Not available';
  const date=new Date(v); if(Number.isNaN(date.getTime())) return String(v);
  return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',...(includeTime?{hour:'2-digit',minute:'2-digit',timeZoneName:'short'}:{}),timeZone:'Europe/Berlin'}).format(date);
}
function berlinParts(timestamp){
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(timestamp).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
function berlinNine(year,month,day){
  const desired=Date.UTC(year,month-1,day,9);let guess=desired;
  for(let i=0;i<3;i++){const p=berlinParts(guess);guess+=desired-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);}
  return guess;
}
function freshness(data,now=Date.now(),status=null){
  const source=Date.parse(data?.asOf),p=berlinParts(now);
  const grace=number(status?.schedule?.graceMinutes??data?.schedule?.graceMinutes)??60;
  let due=berlinNine(p.year,p.month,p.day);
  if(now<due+Math.max(0,grace)*60000){const previous=new Date(Date.UTC(p.year,p.month-1,p.day-1));due=berlinNine(previous.getUTCFullYear(),previous.getUTCMonth()+1,previous.getUTCDate());}
  return {stale:!Number.isFinite(source)||source<due,due,graceMinutes:Math.max(0,grace)};
}
function validateSnapshot(data){
  if(!data||data.schemaVersion!==1||!Array.isArray(data.customers)||!['ready','pending','partial','historical_partial'].includes(data.status))throw new Error('Unsupported snapshot format');
  if(data.status==='pending'){if(data.customers.length)throw new Error('Pending snapshot contains customer records');return;}
  if(!Number.isFinite(Date.parse(data.asOf)))throw new Error('Snapshot capture time is missing');
  const customers=new Set(),accounts=new Set(),numbers=new Set();
  for(const customer of data.customers){
    const id=String(customer.customerId??'').trim();
    if(!id||customers.has(id)||!Array.isArray(customer.groups))throw new Error('Customer identity is missing or duplicated');
    customers.add(id);const sizes=new Set();
    for(const group of customer.groups){
      const size=Number(group.accountSize);
      if(![150000,300000].includes(size)||sizes.has(size)||!Array.isArray(group.accounts))throw new Error('Invalid or repeated size group');
      sizes.add(size);
      for(const account of group.accounts){
        const accountId=String(account.accountId??account.accountNumber??'').trim(),accountNumber=String(account.accountNumber??'').trim();
        if(!accountId||accounts.has(accountId)||(accountNumber&&numbers.has(accountNumber)))throw new Error('Account identity is missing or duplicated');
        accounts.add(accountId);if(accountNumber)numbers.add(accountNumber);
        if(account.status!==undefined&&String(account.status).toLowerCase()!=='active')throw new Error('Non-active account in active scope');
        for(const key of ['progressPct','balance','profit','targetAmount','qualifyingProfit'])if(account[key]!==null&&account[key]!==undefined&&number(account[key])===null)throw new Error('Invalid account number field');
      }
    }
    for(const key of ['totalActiveAccounts','failedAccounts','payoutAccounts'])if(customer[key]!==null&&customer[key]!==undefined&&(!Number.isInteger(customer[key])||customer[key]<0))throw new Error('Invalid customer count');
  }
}
function persist(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(view));}catch(_){}}
function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.add('visible');toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),2400);}
function copyButton(value, type='', label=null){
  if(value===null || value===undefined || value==='') return '<span class="muted">Unknown</span>';
  return `<button type="button" class="copy-button ${attr(type)}" data-copy="${attr(value)}" title="Copy ${attr(value)}" aria-label="Copy ${attr(value)}"><span class="copy-value">${escapeHTML(label??value)}</span><span class="copy-icon" aria-hidden="true">⧉</span></button>`;
}
function makeRows(data){
  const result=[];
  for(const customer of (Array.isArray(data?.customers)?data.customers:[])){
    for(const group of (Array.isArray(customer.groups)?customer.groups:[])){
      const size=Number(group.accountSize); if(![150000,300000].includes(size)) continue;
      const accounts=Array.isArray(group.accounts)?group.accounts:[];
      const seen=new Set();
      const unique=accounts.filter(a=>{const key=String(a.accountId??a.accountNumber??''); if(!key || seen.has(key))return false; seen.add(key);return true;});
      if(unique.length!==accounts.length) console.warn('Duplicate or missing account identity excluded from a group.');
      if(unique.length<3 || unique.length>5) continue;
      const known=unique.map(a=>number(a.progressPct)).filter(v=>v!==null);
      const max=known.length ? Math.max(...known) : null;
      const missing=known.length!==unique.length;
      const risk=max!==null&&max>=86?'red':max!==null&&max>=80?'orange':missing?'unknown':'green';
      const identity=String(customer.customerId??customer.email??customer.name??'unknown');
      result.push({key:`${identity}:${size}`,identity,customer,group,accounts:unique,size,count:unique.length,max,missing,risk,
        search:[customer.name,customer.email,...unique.map(a=>a.accountNumber)].join(' ').toLowerCase()});
    }
  }
  return result;
}
function activeColumns(){return view.columns.filter(k=>!view.hidden.includes(k));}
function metric(label,value,sub,extra=''){return `<article class="metric ${extra}"><div class="metric-label">${label}<span class="metric-mark" aria-hidden="true"></span></div><strong>${value}</strong><small>${sub}</small></article>`;}
function totals(list){const accounts=list.flatMap(r=>r.accounts);const counts={green:0,orange:0,red:0,unknown:0};accounts.forEach(a=>counts[band(a.progressPct)]++);return {accounts,counts,total:accounts.length,customers:new Set(list.map(r=>r.identity)).size};}
function renderOverview(){
  const visible=filteredRows(),t=totals(visible),known=t.total-t.counts.unknown;
  const hasData=!!snapshot && snapshot.status!=='pending';
  $('headlineMetrics').innerHTML=metric('Customers in scope',hasData?countText(t.customers):'—','Unique customers across both sizes')+
    metric('Active accounts in scope',hasData?countText(t.total):'—','Held in same-size groups of 3, 4 or 5','cyan')+
    metric('At 86% or above',hasData?countText(t.counts.red):'—',hasData?`${percent(t.total?t.counts.red/t.total*100:0)} of in-scope accounts`:'Verified target progress only','red')+
    metric('Progress verified',hasData?`${countText(known)} / ${countText(t.total)}`:'—',hasData&&t.counts.unknown?`${countText(t.counts.unknown)} accounts still unavailable`:'Evidence coverage, not trading status');
  $('sizeOverview').innerHTML=[150000,300000].map(size=>{
    const scope=visible.filter(r=>r.size===size),total=totals(scope);
    return `<article class="size-card"><div class="size-card-head"><h3 class="size-number">${size/1000}K<span>${size===150000?'TOMCAT':'THUNDERBOLT'}</span></h3><div class="size-total"><strong>${hasData?countText(total.total):'—'}</strong> active accounts<br>${hasData?countText(total.customers):'—'} customers</div></div><div class="cohort-counts">${[3,4,5].map(c=>`<button type="button" class="cohort-count" data-cohort="${size}:${c}" aria-label="Show ${size/1000}K customers with ${c} accounts"><span class="cohort-label">${c} active accounts</span><strong>${hasData?countText(scope.filter(r=>r.count===c).length):'—'}</strong><small>customers</small></button>`).join('')}</div><div class="target-area"><div class="target-title"><span>Profit-target progress</span><span>${hasData?total.total:'—'} accounts · current view</span></div><div class="stacked-bar" role="group" aria-label="${attr(hasData?Object.keys(total.counts).map(k=>`${BAND_LABEL[k]}: ${total.counts[k]} accounts`).join(', '):'Snapshot not yet available')}">${Object.keys(total.counts).filter(k=>total.counts[k]>0).map(k=>`<button type="button" class="bar-segment ${k}" data-band="${size}:${k}" style="width:${total.counts[k]/total.total*100}%" title="${attr(BAND_LABEL[k])}: ${total.counts[k]} accounts (${percent(total.counts[k]/total.total*100)})" aria-label="Filter ${size/1000}K: ${attr(BAND_LABEL[k])}"></button>`).join('')}</div><div class="bar-legend">${Object.keys(total.counts).map(k=>`<div class="legend-item"><span class="legend-dot ${k}"></span>${k==='orange'?'80–85%':BAND_LABEL[k]}<strong>${hasData?total.counts[k]:'—'}<span>${hasData?percent(total.total?total.counts[k]/total.total*100:0):'—'}</span></strong></div>`).join('')}</div></div></article>`;
  }).join('');
}
function sortValue(row,key){
  switch(key){case 'customer':return row.customer.name??'';case 'email':return row.customer.email??'';case 'size':return row.size;case 'count':return row.count;case 'accounts':return row.accounts.map(a=>String(a.accountNumber??'')).sort().join(' ');case 'progress':return row.max;case 'risk':return RISK_RANK[row.risk];case 'failed':return number(row.customer.failedAccounts);case 'payout':return number(row.customer.payoutAccounts);case 'total':return number(row.customer.totalActiveAccounts);default:return '';}
}
function filteredRows(){
  const query=String(view.search??'').trim().toLowerCase();
  return rows.filter(r=>(!query||r.search.includes(query)) && (view.size==='all'||r.size===Number(view.size)) && (view.count==='all'||r.count===Number(view.count)) && (view.risk==='all'||r.risk===view.risk) && (view.progress==='all'||r.accounts.some(a=>band(a.progressPct)===view.progress))).sort((a,b)=>{
    const av=sortValue(a,view.sort),bv=sortValue(b,view.sort);
    if(av===null&&bv!==null)return 1;if(bv===null&&av!==null)return -1;
    const cmp=typeof av==='number'&&typeof bv==='number'?av-bv:String(av??'').localeCompare(String(bv??''),'en',{numeric:true});
    return (view.direction==='asc'?cmp:-cmp)||a.key.localeCompare(b.key);
  });
}
function progressMarkup(value,missing=false){
  if(value===null)return '<span class="muted">Unavailable</span>';
  const b=band(value);
  return `<div class="progress-cell"><span class="progress-value">${percent(value)}</span>${missing?'<span class="inline-warning" title="Some account progress is not verified"> *</span>':''}<div class="mini-progress" aria-hidden="true"><span class="${b}" style="width:${Math.max(0,Math.min(100,value))}%"></span></div></div>`;
}
function cell(row,key){
  switch(key){
    case 'customer':return copyButton(row.customer.name,'customer-name');
    case 'email':return copyButton(row.customer.email,'email');
    case 'size':return `<span class="size-chip">${row.size/1000}K</span>`;
    case 'count':return `<span class="numeric">${row.count}</span><span class="secondary-number">accounts</span>`;
    case 'accounts':return `<div class="account-numbers">${row.accounts.map(a=>copyButton(a.accountNumber)).join('')}</div>`;
    case 'progress':return progressMarkup(row.max,row.missing);
    case 'risk':return `<span class="badge ${row.risk}">${RISK_LABEL[row.risk]}</span>`;
    case 'failed':return `<span class="${number(row.customer.failedAccounts)===null?'muted':'numeric'}">${countText(row.customer.failedAccounts)}</span>`;
    case 'payout':return `<span class="${number(row.customer.payoutAccounts)===null?'muted':'numeric'}">${countText(row.customer.payoutAccounts)}</span>`;
    case 'total':return `<span class="${number(row.customer.totalActiveAccounts)===null?'muted':'numeric'}">${countText(row.customer.totalActiveAccounts)}</span>`;
    default:return '';
  }
}
function accountDates(a){
  const fields=[];
  if(a.openedAt&&Number.isFinite(Date.parse(a.openedAt)))fields.push(`<dt>Opened</dt><dd>${escapeHTML(dateText(a.openedAt,false))}</dd>`);
  const isoUpdated=typeof a.updatedAt==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(a.updatedAt)&&Number.isFinite(Date.parse(a.updatedAt));
  const sourceDisplay=a.sourceUpdatedDisplay??a.updatedDisplay;
  if(isoUpdated)fields.push(`<dt>Source updated</dt><dd>${escapeHTML(dateText(a.updatedAt))}</dd>`);
  else if(typeof sourceDisplay==='string'&&sourceDisplay.trim()&&!/^(?:unknown|n\/a|[-—])$/i.test(sourceDisplay.trim()))fields.push(`<dt>Source updated (source time)</dt><dd>${escapeHTML(sourceDisplay)}</dd>`);
  return fields.join('');
}
function accountDetail(a,size){
  const b=band(a.progressPct),progress=number(a.progressPct);
  return `<article class="account-card"><div class="account-card-top">${copyButton(a.accountNumber)}<span class="badge ${b}">${progress===null?'Unavailable':percent(progress)}</span></div><div class="mini-progress" aria-hidden="true"><span class="${b}" style="width:${progress===null?100:Math.max(0,Math.min(100,progress))}%"></span></div><dl><dt>Account size</dt><dd>${size/1000}K</dd><dt>Current balance</dt><dd>${escapeHTML(money(a.balance))}</dd><dt>${a.qualifyingProfit!=null?'Qualifying profit':'Current profit (source)'}</dt><dd>${escapeHTML(money(a.qualifyingProfit??a.profit))}</dd><dt>Product payout target</dt><dd>${escapeHTML(money(a.targetAmount))}</dd><dt>Account status</dt><dd>${escapeHTML(a.status??'Active')}</dd>${accountDates(a)}</dl>${a.progressNote?`<p class="detail-notes">${escapeHTML(a.progressNote)}</p>`:''}</article>`;
}
function detail(row,colspan){return `<tr class="detail-row" id="detail-${attr(row.key)}"><td colspan="${colspan}"><div class="detail-content"><div class="detail-heading"><div><h3>${escapeHTML(row.customer.name??'Customer')} · ${row.size/1000}K accounts</h3><p>${row.count} accounts in this group · ${countText(row.customer.totalActiveAccounts)} currently active across all sizes</p></div><span class="badge ${row.risk}">${RISK_LABEL[row.risk]} payout proximity</span></div><div class="account-detail-grid">${row.accounts.map(a=>accountDetail(a,row.size)).join('')}</div><p class="detail-notes">${row.missing?'* At least one account has unverified target progress. ':''}${row.customer.historyComplete===true?'Customer history is verified for this snapshot.':'Historical failed/payout outcomes are only shown where verified; unknown is not zero.'}${row.customer.historyNote?' '+escapeHTML(row.customer.historyNote):''}</p></div></td></tr>`;}
function renderTable(){
  renderOverview();
  filtered=filteredRows();const cols=activeColumns();const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));view.page=Math.max(1,Math.min(Number(view.page)||1,pages));
  const visible=filtered.slice((view.page-1)*PAGE_SIZE,view.page*PAGE_SIZE);
  $('customerTable').classList.toggle('dense',!!view.dense);
  $('tableHead').innerHTML='<tr><th scope="col" class="expander-cell"><span class="sr-only">Expand</span></th>'+cols.map(key=>{const col=COLUMNS.find(c=>c.key===key),selected=view.sort===key;return `<th scope="col" draggable="true" data-column="${key}" aria-sort="${selected?(view.direction==='asc'?'ascending':'descending'):'none'}"><button type="button" data-sort="${key}" title="Sort ${attr(col.label)}; drag header to rearrange">${escapeHTML(col.label)}<span class="sort-indicator" aria-hidden="true">${selected?(view.direction==='asc'?'↑':'↓'):'↕'}</span></button></th>`;}).join('')+'</tr>';
  if(visible.length){
    $('tableBody').innerHTML=visible.map(row=>`<tr class="customer-row ${expanded.has(row.key)?'expanded':''}"><td class="expander-cell"><button type="button" class="expand-button" data-expand="${attr(row.key)}" aria-expanded="${expanded.has(row.key)}" aria-controls="detail-${attr(row.key)}" aria-label="${expanded.has(row.key)?'Collapse':'Expand'} ${attr(row.customer.name??'customer')} ${row.size/1000}K accounts">${expanded.has(row.key)?'⌄':'›'}</button></td>${cols.map(key=>`<td>${cell(row,key)}</td>`).join('')}</tr>${expanded.has(row.key)?detail(row,cols.length+1):''}`).join('');
  } else {
    const title=loading&&!snapshot?'Loading account snapshot':loadFailed&&!snapshot?'Snapshot could not be loaded':!snapshot||snapshot.status==='pending'?'The first verified snapshot is pending':rows.length?'No customers match this view':'No qualifying customers in this snapshot';
    const description=loadFailed&&!snapshot?'Try refreshing. No account data has been replaced or assumed.':rows.length?'Try a different name, account size or progress filter.':snapshot?.status==='pending'?'Customer data will appear after the read-only collection has completed.':'The scope is customers with exactly 3, 4 or 5 active accounts of the same size.';
    $('tableBody').innerHTML=`<tr><td class="empty-cell" colspan="${cols.length+1}"><div class="empty-icon" aria-hidden="true">◈</div><strong>${title}</strong><p>${description}</p></td></tr>`;
  }
  const unique=new Set(filtered.map(r=>r.identity)).size,accts=filtered.reduce((n,r)=>n+r.count,0);
  $('resultCount').textContent=`${filtered.length} size groups · ${unique} customers · ${accts} accounts`;
  $('pageInfo').textContent=`${view.page} / ${pages}`;$('prevPage').disabled=view.page<=1;$('nextPage').disabled=view.page>=pages;
  $('exportBtn').disabled=!filtered.length;
  $('tableFootnote').textContent=view.progress==='all'?'Click a name, email or account number to copy it.':'Progress filter matches any account; the full customer size group stays visible.';
  persist();
}
function renderMetadata(){
  const pending=!snapshot||snapshot.status==='pending';
  const {stale,due,graceMinutes}=freshness(snapshot,Date.now(),refreshStatus);
  const historical=snapshot?.status==='historical_partial'||snapshot?.historical===true;
  const partial=snapshot?.status==='partial'||historical;
  const refreshFailed=refreshStatus?.state==='failed';
  $('asOf').textContent=snapshot?.asOf?dateText(snapshot.asOf):'Awaiting verified data';
  $('freshnessText').textContent=pending?'Collection pending':historical?'Historical snapshot':refreshFailed?'Update delayed':stale?'Older snapshot':partial?'Partial evidence':'Snapshot available';
  $('freshnessDot').className=`status-dot ${pending?'unknown':stale||partial||refreshFailed?'orange':''}`;
  const messages=[];
  if(OFFLINE_MODE)messages.push('Saved offline snapshot. This file does not collect source data or update automatically.');
  if(pending)messages.push('The first verified snapshot is pending. No customer figures are assumed.');
  else if(historical)messages.push('This is a historical snapshot, not a current collection.');
  if(!pending&&stale)messages.push(OFFLINE_MODE?'This saved capture is older than the latest daily 09:00 Europe/Berlin reference time.':`No newer source capture is available for the ${dateText(due)} collection (${graceMinutes}-minute grace period). The previous snapshot remains visible.`);
  if(partial)messages.push('Some evidence is incomplete. Unverified progress and historical outcomes are marked as unavailable.');
  if(refreshFailed)messages.push(`The last collection attempt failed${refreshStatus.attemptedAt?' at '+dateText(refreshStatus.attemptedAt):''}. ${typeof refreshStatus.errorSummary==='string'?refreshStatus.errorSummary:'The previous successful snapshot is retained.'}`);
  if(statusFailed)messages.push('Current collection status could not be checked.');
  if(loadFailed)messages.push('Refresh failed. The last loaded snapshot has been retained.');
  $('dataNotice').textContent=messages.join(' ');$('dataNotice').hidden=!messages.length;$('dataNotice').classList.toggle('error',loadFailed||refreshFailed);
  $('sourceFoot').textContent=snapshot?.sourceLabel||'Read-only observations from Savius Admin';
  $('scheduleText').textContent=OFFLINE_MODE?'Offline snapshot · no automatic updates':refreshStatus?.schedule?.label||snapshot?.schedule?.label||'Daily collection planned · 09:00 Europe/Berlin';
  for(const [id,key] of [['progressMethod','progress'],['historyMethod','history'],['refreshMethod','refresh']]){
    const element=$(id);if(!element.dataset.defaultText)element.dataset.defaultText=element.textContent;
    element.textContent=snapshot?.methodology?.[key]||element.dataset.defaultText;
  }
  if(OFFLINE_MODE)$('refreshMethod').textContent='This file contains the saved read-only Savius capture shown above. Reload saved snapshot restores that same embedded dataset and does not contact Savius or collect new data. All filters, column controls, copy actions and CSV export work locally. No automatic refresh is connected to this offline copy.';
  const notes=(Array.isArray(snapshot?.notes)?snapshot.notes:[]).map(n=>typeof n==='string'?n:n.text).filter(Boolean);
  $('extraNotes').innerHTML=notes.length?'<h3>Snapshot notes</h3>'+notes.map(n=>`<p>${escapeHTML(n)}</p>`).join(''):'';
}
function controlsFromView(){
  $('search').value=view.search||'';$('sizeFilter').value=view.size;$('countFilter').value=view.count;$('progressFilter').value=view.progress;$('riskFilter').value=view.risk;$('denseMode').checked=!!view.dense;
}
function render(){renderMetadata();renderTable();}
function endpointURL(metaName,fallback){
  const configured=document.querySelector(`meta[name="${metaName}"]`)?.content?.trim()||fallback;
  if(!configured)return null;
  const url=new URL(configured,document.baseURI);url.searchParams.set('t',Date.now());return url;
}
async function fetchJSON(url){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`Snapshot HTTP ${response.status}`);return response.json();}
async function loadData(){
  if(loading)return;loading=true;$('refreshBtn').disabled=true;$('refreshBtn').innerHTML='<span aria-hidden="true">↻</span> Loading…';
  if(!snapshot)renderTable();
  try{
    const data=OFFLINE_MODE?JSON.parse($('embeddedSnapshot')?.textContent||'null'):await fetchJSON(endpointURL('snapshot-url','./data.json'));
    validateSnapshot(data);
    if(snapshot&&snapshot.status!=='pending'&&data.status==='pending')throw new Error('Published data is temporarily unavailable');
    if(snapshot?.asOf&&data.asOf&&Date.parse(data.asOf)<Date.parse(snapshot.asOf))throw new Error('Older snapshot was not applied');
    const nextRows=makeRows(data);snapshot=data;rows=nextRows;refreshStatus=data.refresh??null;loadFailed=false;
  }catch(error){loadFailed=true;console.warn('Snapshot unavailable:',error.message);}
  try{
    const statusURL=OFFLINE_MODE?null:endpointURL('refresh-status-url',null);
    if(statusURL){const nextStatus=await fetchJSON(statusURL);if(!nextStatus||typeof nextStatus!=='object'||Array.isArray(nextStatus))throw new Error('Invalid collection status');refreshStatus=nextStatus;}
    statusFailed=false;
  }catch(error){statusFailed=true;console.warn('Collection status unavailable:',error.message);}
  finally{loading=false;$('refreshBtn').disabled=false;$('refreshBtn').innerHTML=`<span aria-hidden="true">↻</span> ${OFFLINE_MODE?'Reload saved snapshot':'Refresh snapshot'}`;$('refreshBtn').title=OFFLINE_MODE?'Reload this file’s embedded data; no new source collection.':'Read the latest published dashboard snapshot.';render();}
}
function showColumns(){
  $('columnList').innerHTML=view.columns.map((key,i)=>{const col=COLUMNS.find(c=>c.key===key);return `<div class="column-setting" draggable="true" data-column="${key}"><span class="drag-grip" aria-hidden="true">⠿</span><label><input type="checkbox" data-visible="${key}" ${!view.hidden.includes(key)?'checked':''} ${key==='customer'?'disabled':''}>${col.label}</label><button type="button" data-move="${key}:-1" aria-label="Move ${attr(col.label)} left" ${i===0?'disabled':''}>↑</button><button type="button" data-move="${key}:1" aria-label="Move ${attr(col.label)} right" ${i===view.columns.length-1?'disabled':''}>↓</button></div>`;}).join('');
}
function moveColumn(from,to){const a=view.columns.indexOf(from),b=view.columns.indexOf(to);if(a<0||b<0||a===b)return;view.columns.splice(a,1);view.columns.splice(b,0,from);renderTable();showColumns();}
function csvCell(value){
  let text=value===null||value===undefined?'':String(value);
  if(typeof value!=='number'&&/^[\s\u0000-\u001f]*[=+\-@\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function csvRows(list){
  const headers=['Snapshot as of','Customer name','Email','Account size','Same-size active accounts','All active accounts','Confirmed failures','Completed payout accounts','Payout proximity','Account number','Progress %','Current balance','Current profit (source)','Verified qualifying profit','Target amount','Status','Progress evidence','History evidence'];
  const records=list.flatMap(r=>r.accounts.map(a=>[snapshot?.asOf,r.customer.name,r.customer.email,r.size,r.count,r.customer.totalActiveAccounts,r.customer.failedAccounts,r.customer.payoutAccounts,RISK_LABEL[r.risk],a.accountNumber,a.progressPct,a.balance,a.profit,a.qualifyingProfit,a.targetAmount,a.status,a.progressNote??'',r.customer.historyNote??(r.customer.historyComplete?'Verified':'Incomplete; unknown is not zero')]));
  return [headers,...records];
}
function exportCSV(){
  const [headers,...records]=csvRows(filtered);
  const blob=new Blob(['\uFEFF'+[headers,...records].map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`Savius-account-monitor-${snapshot?.asOf?.slice(0,10)||'snapshot'}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast(`Exported ${records.length} accounts from the current view`);
}
async function copyValue(value){
  try{await navigator.clipboard.writeText(value);toast('Copied to clipboard');}
  catch(_){
    const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();
    try{if(!document.execCommand('copy'))throw Error();toast('Copied to clipboard');}catch(_){toast('Copy unavailable. Select and copy the value manually.');}finally{input.remove();}
  }
}
document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.copy!==undefined){copyValue(target.dataset.copy);return;}
  if(target.dataset.expand){const k=target.dataset.expand;expanded.has(k)?expanded.delete(k):expanded.add(k);renderTable();const restored=[...document.querySelectorAll('[data-expand]')].find(el=>el.dataset.expand===k);restored?.focus({preventScroll:true});return;}
  if(target.dataset.sort){const key=target.dataset.sort;view.direction=view.sort===key&&view.direction==='asc'?'desc':'asc';view.sort=key;renderTable();return;}
  if(target.dataset.cohort){const [size,count]=target.dataset.cohort.split(':');view.size=size;view.count=count;view.page=1;controlsFromView();renderTable();$('customerOverview').scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(target.dataset.band){const [size,p]=target.dataset.band.split(':');view.size=size;view.progress=p;view.page=1;controlsFromView();renderTable();$('customerOverview').scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(target.dataset.move){const [key,step]=target.dataset.move.split(':');const i=view.columns.indexOf(key),j=i+Number(step);if(j>=0&&j<view.columns.length){moveColumn(key,view.columns[j]);const restored=[...$('columnList').querySelectorAll('[data-move]')].find(el=>el.dataset.move===target.dataset.move);restored?.focus();}return;}
});
document.addEventListener('dragstart',event=>{const element=event.target.closest('[data-column]');if(!element)return;dragKey=element.dataset.column;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragKey);});
document.addEventListener('dragover',event=>{const element=event.target.closest('[data-column]');if(!element||!dragKey)return;event.preventDefault();element.classList.add('drag-over');});
document.addEventListener('dragleave',event=>event.target.closest('[data-column]')?.classList.remove('drag-over'));
document.addEventListener('drop',event=>{const element=event.target.closest('[data-column]');if(!element||!dragKey)return;event.preventDefault();moveColumn(dragKey,element.dataset.column);dragKey=null;});
document.addEventListener('dragend',()=>{dragKey=null;document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));});
$('columnList').addEventListener('change',event=>{const key=event.target.dataset.visible;if(!key||key==='customer')return;view.hidden=event.target.checked?view.hidden.filter(k=>k!==key):[...new Set([...view.hidden,key])];renderTable();});
$('restoreColumns').addEventListener('click',()=>{view.columns=[...DEFAULT.columns];view.hidden=[];renderTable();showColumns();});
for(const [id,key]of [['sizeFilter','size'],['countFilter','count'],['progressFilter','progress'],['riskFilter','risk']])$(id).addEventListener('change',e=>{view[key]=e.target.value;view.page=1;renderTable();});
let searchTimer;$('search').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{view.search=e.target.value;view.page=1;renderTable();},120);});
$('denseMode').addEventListener('change',e=>{view.dense=e.target.checked;renderTable();});
$('clearBtn').addEventListener('click',()=>{view={...DEFAULT,columns:[...DEFAULT.columns],hidden:[]};expanded.clear();controlsFromView();renderTable();toast('Default view restored');});
$('prevPage').addEventListener('click',()=>{view.page--;renderTable();});$('nextPage').addEventListener('click',()=>{view.page++;renderTable();});
$('methodologyBtn').addEventListener('click',()=>$('methodologyDialog').showModal());$('methodologyBottom').addEventListener('click',()=>$('methodologyDialog').showModal());
$('columnsBtn').addEventListener('click',()=>{showColumns();$('columnsDialog').showModal();});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
$('refreshBtn').addEventListener('click',loadData);$('exportBtn').addEventListener('click',exportCSV);
controlsFromView();renderTable();loadData();
setInterval(renderMetadata,60000);

