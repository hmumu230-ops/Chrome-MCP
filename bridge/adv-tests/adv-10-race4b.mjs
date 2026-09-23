// Focused repeat: in-flight performance_stop_trace vs detach_debugger (0ms gap), x4.
const BASE='http://127.0.0.1:7890/mcp';
let sid,i=0;
const rpc=async b=>{const r=await fetch(BASE,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream',...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify(b)});const t=await r.text();if(!sid)sid=r.headers.get('mcp-session-id');const m=t.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5).trim()));return{msg:m[m.length-1],status:r.status}};
await rpc({jsonrpc:'2.0',id:++i,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'0'}}});
await rpc({jsonrpc:'2.0',method:'notifications/initialized'});
const call=(n,a)=>rpc({jsonrpc:'2.0',id:++i,method:'tools/call',params:{name:n,arguments:a}});
const txt=r=>((r.msg&&r.msg.result&&r.msg.result.content)||[]).map(c=>c.text||'').join('\n');
const isErr=r=>!!(r.msg&&((r.msg.result&&r.msg.result.isError)||r.msg.error));
const brief=r=>!r?'<none>':r.timeout?`<TIMEOUT ${r.ms}ms>`:(isErr(r)?'ERR ':'ok  ')+txt(r).replace(/\s+/g,' ').slice(0,140);
const timed=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(()=>r({timeout:true,ms}),ms))]);
const sc=r=>r.msg&&r.msg.result&&r.msg.result.structuredContent;

const np=await call('new_page',{url:'https://example.com'});
const P=sc(np).pageId;
await new Promise(r=>setTimeout(r,1500));
for(let k=1;k<=4;k++){
  const st=await call('performance_start_trace',{pageId:P});
  await new Promise(r=>setTimeout(r,500));
  const t0=Date.now();
  const stop=timed(call('performance_stop_trace',{pageId:P}),25000);
  const det=call('detach_debugger',{pageId:P}); // no delay — race it
  const [s,d]=await Promise.all([stop,det]);
  console.log(`iter${k}: start=${brief(st)} | stop(${Date.now()-t0}ms)=${brief(s)} | detach=${brief(d)}`);
  // re-attach for next round
  await call('list_console_messages',{pageId:P});
}
await call('close_page',{pageId:P});
const h=await fetch(BASE.replace('/mcp','/')).then(r=>r.json());
console.log('health:',JSON.stringify(h));
