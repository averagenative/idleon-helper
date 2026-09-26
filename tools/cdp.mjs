// Minimal CDP client for the live IdleOn tab, talking to Chrome's DevTools
// Protocol over the same port `--remote-debugging-port` was started with.
//
//   node cdp.mjs grab                  pause one frame, stash the engine on window.__ihE, resume
//   node cdp.mjs eval '<expr>'         Runtime.evaluate in the page, print the JSON result
//   node cdp.mjs eval -                same, reading the expression from stdin
//   node cdp.mjs inject <file>         remove any existing [data-ih] host(s), then evaluate <file>'s source
//   ... --port <n>                     use a port other than the default 9222
//
// NEVER reload or navigate the game tab from here (no Page.navigate, no
// Page.reload, nothing that would trigger one indirectly) - a lost run costs
// an ever-growing real-time cooldown on whichever minigame is in progress.
// Every command in this file only ever attaches to the tab that is already
// open and talks to code already running in it.
//
// `grab` pauses the whole page for a moment (Debugger.pause) to read a local
// variable off a paused call frame - the engine reference has no other way
// out, since it is never assigned to anything reachable from outside the
// bundle's own closure. That pause can land mid-autosave; it resumes
// immediately either way, and nothing here writes anything back.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let port = 9222;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === '--port' && args[i + 1] != null) { port = Number(args[i + 1]); args.splice(i, 2); }
  else if (args[i].startsWith('--port=')) { port = Number(args[i].slice(7)); args.splice(i, 1); }
}
const [cmd, arg] = args;

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('legendsofidleon.com/ytGl5oc'));
if (!page) { console.error('no game tab'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const wait = new Map(); const events = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  else if (m.method) events.push(m);
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

async function evalInPage(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r;
}

if (cmd === 'grab') {
  // Every grab is a pause, and a pause can land mid-save, so never take one
  // for a handle the page already has. The engine lives as long as the tab.
  if (await evalInPage(`typeof window.__ihE === 'object' && window.__ihE !== null`) === true) {
    console.log('already grabbed');
    ws.close();
    process.exit(0);
  }
  await send('Debugger.enable');
  await send('Debugger.pause');
  let paused;
  for (let t = 0; t < 100 && !paused; t++) { await new Promise(r => setTimeout(r, 50)); paused = events.find(e => e.method === 'Debugger.paused'); }
  if (!paused) { console.log('never paused (tab hidden?)'); await send('Debugger.disable'); process.exit(1); }
  let got = 'no frame had z';
  for (const f of paused.params.callFrames) {
    const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, returnByValue: true,
      expression: `(typeof z!=='undefined' && z && z["com.stencyl.Engine"] && z["com.stencyl.Engine"].engine) ? (window.__ihE = z["com.stencyl.Engine"].engine, 'ok') : 'no'` });
    if (r.result?.result?.value === 'ok') { got = 'ok in ' + f.functionName; break; }
  }
  await send('Debugger.resume');
  await send('Debugger.disable');
  console.log(got);
} else if (cmd === 'eval') {
  const expr = arg === '-' ? readFileSync(0, 'utf8') : arg;
  console.log(JSON.stringify(await evalInPage(expr), null, 1));
} else if (cmd === 'inject') {
  if (!arg) { console.error('usage: node cdp.mjs inject <file>'); process.exit(1); }
  const src = readFileSync(arg, 'utf8');
  // Drop whatever an earlier injection (or the extension itself, on a fresh
  // load) left mounted, identified by the data-ih attribute the userscript's
  // host element carries for exactly this reason. Removing the element does
  // not stop that generation's rAF loop or its window listeners - the
  // script's own loop notices its host is gone and tears those down itself
  // on the next frame.
  await evalInPage(`document.querySelectorAll('[data-ih]').forEach(n=>n.remove())`);
  const result = await evalInPage(src);
  console.log(JSON.stringify(result, null, 1));
} else {
  console.error('usage: node cdp.mjs <grab|eval|inject> [arg] [--port <n>]');
  process.exit(1);
}
ws.close();
