import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 900));

const snap = await call('take_snapshot', { pageId: PID });
let lines = []; try { lines = JSON.parse(snap.text).lines || []; } catch {}
// map: find uid whose line mentions a label/id-ish token
const uidFor = (token) => {
  const l = lines.find(l => {
    const q = l.match(/"([^"]*)"/);
    return q && q[1].trim() === token;
  });
  const m = l && l.match(/\[([^\]]+)\]/);
  return m && m[1];
};
// snapshot labels come from <label> text — print all for mapping
console.log(lines.join('\n'));

async function fillAndRead(name, labelToken, readExpr, expect) {
  const uid = uidFor(labelToken);
  if (!uid) return ok(`fill ${name}`, false, 'no uid for ' + labelToken);
  const fr = await call('fill', { pageId: PID, uid, value: expect.set });
  const v = await evl(PID, `() => (${readExpr})`);
  ok(`fill ${name}`, !fr.isError && v === expect.get, `set=${JSON.stringify(expect.set)} got=${JSON.stringify(v)}${fr.isError ? ' err=' + fr.text.slice(0, 100) : ''}`);
}

await fillAndRead('text', 'text', `document.getElementById('t-text').value`, { set: 'hello world', get: 'hello world' });
await fillAndRead('password', 'password', `document.getElementById('t-pass').value`, { set: 's3cret!', get: 's3cret!' });
await fillAndRead('number', 'number', `document.getElementById('t-num').value`, { set: '42', get: '42' });
await fillAndRead('number-bad', 'number', `document.getElementById('t-num').value`, { set: 'abc', get: '' });
await fillAndRead('email', 'email', `document.getElementById('t-email').value`, { set: 'a@b.co', get: 'a@b.co' });
await fillAndRead('tel', 'tel', `document.getElementById('t-tel').value`, { set: '+15551234567', get: '+15551234567' });
await fillAndRead('date', 'date', `document.getElementById('t-date').value`, { set: '2026-09-23', get: '2026-09-23' });
await fillAndRead('color', 'color', `document.getElementById('t-color').value`, { set: '#ff0000', get: '#ff0000' });
await fillAndRead('textarea', 'textarea', `document.getElementById('ta').value`, { set: 'line1\nline2', get: 'line1\nline2' });
await fillAndRead('contenteditable', 'contenteditable', `document.getElementById('ce').textContent`, { set: 'ce text here', get: 'ce text here' });
await fillAndRead('maxlength', 'maxlength5', `document.getElementById('t-max').value`, { set: '123456789', get: '123456789' });
await fillAndRead('pattern', 'pattern[0-9]', `document.getElementById('t-pat').value`, { set: 'abc', get: 'abc' });

// readonly / disabled — expect value to be SET anyway (documents bypass) or rejected
{
  const uidRo = uidFor('readonly'), uidDis = uidFor('disabled');
  const r1 = await call('fill', { pageId: PID, uid: uidRo, value: 'HACKED-RO' });
  const v1 = await evl(PID, `() => document.getElementById('t-ro').value`);
  ok('fill readonly bypass', true, `toolErr=${r1.isError} value=${JSON.stringify(v1)} (init RO-INIT)`);
  const r2 = await call('fill', { pageId: PID, uid: uidDis, value: 'HACKED-DIS' });
  const v2 = await evl(PID, `() => document.getElementById('t-dis').value`);
  ok('fill disabled bypass', true, `toolErr=${r2.isError} value=${JSON.stringify(v2)} (init DIS-INIT)`);
}

// selects
{
  const uid1 = uidFor('combobox "opt') || uidFor('opt-a');
  // snapshot label is label text; selects have no label → labelOf '' → combobox "" — find by order
  const selLines = lines.filter(l => /combobox|listbox/.test(l));
  console.log('select lines:', JSON.stringify(selLines));
  const uidOf = (i) => { const m = selLines[i] && selLines[i].match(/\[([^\]]+)\]/); return m && m[1]; };
  const u1 = uidOf(0), um = uidOf(1), ug = uidOf(2);
  let r = await call('fill', { pageId: PID, uid: u1, value: 'b' });
  let v = await evl(PID, `() => ({si:document.getElementById('sel1').selectedIndex, val:document.getElementById('sel1').value})`);
  ok('select single', !r.isError && v.si === 1 && v.val === 'b', JSON.stringify(v));
  // by visible text
  r = await call('fill', { pageId: PID, uid: u1, value: 'opt-c' });
  v = await evl(PID, `() => ({si:document.getElementById('sel1').selectedIndex, val:document.getElementById('sel1').value})`);
  ok('select by text', !r.isError && v.si === 2, JSON.stringify(v));
  // optgroup select → 'z' (index 2)
  r = await call('fill', { pageId: PID, uid: ug, value: 'z' });
  v = await evl(PID, `() => ({si:document.getElementById('selg').selectedIndex, val:document.getElementById('selg').value})`);
  ok('select optgroup', !r.isError && v.si === 2 && v.val === 'z', JSON.stringify(v));
  // multi-select: fill '3'
  r = await call('fill', { pageId: PID, uid: um, value: '3' });
  v = await evl(PID, `() => ({si:document.getElementById('selm').selectedIndex, sel:[...document.getElementById('selm').selectedOptions].map(o=>o.value)})`);
  ok('select multi', !r.isError && v.si === 2, JSON.stringify(v) + (r.isError ? ' err=' + r.text.slice(0, 80) : ''));
}

// checkbox / radio via fill
{
  const cbUid = uidFor('checkme'), r1Uid = uidFor('radio1'), r2Uid = uidFor('radio2');
  let r = await call('fill', { pageId: PID, uid: cbUid, value: 'true' });
  let v = await evl(PID, `() => document.getElementById('cb').checked`);
  ok('checkbox on', !r.isError && v === true, `checked=${v}`);
  r = await call('fill', { pageId: PID, uid: cbUid, value: 'true' });
  v = await evl(PID, `() => document.getElementById('cb').checked`);
  ok('checkbox idempotent-on', !r.isError && v === true, `checked=${v}`);
  r = await call('fill', { pageId: PID, uid: cbUid, value: 'false' });
  v = await evl(PID, `() => document.getElementById('cb').checked`);
  ok('checkbox off', !r.isError && v === false, `checked=${v}`);
  r = await call('fill', { pageId: PID, uid: r2Uid, value: 'true' });
  v = await evl(PID, `() => ({r1:document.getElementById('r1').checked, r2:document.getElementById('r2').checked})`);
  ok('radio r2 on', !r.isError && v.r2 === true && v.r1 === false, JSON.stringify(v));
  r = await call('fill', { pageId: PID, uid: r1Uid, value: 'true' });
  v = await evl(PID, `() => ({r1:document.getElementById('r1').checked, r2:document.getElementById('r2').checked})`);
  ok('radio r1 exclusivity', !r.isError && v.r1 === true && v.r2 === false, JSON.stringify(v));
}

// click on checkbox toggles
{
  const cbUid = uidFor('checkme');
  await evl(PID, `() => (document.getElementById('cb').checked = false)`);
  await call('click', { pageId: PID, uid: cbUid });
  const v = await evl(PID, `() => document.getElementById('cb').checked`);
  ok('click toggles checkbox', v === true, `checked=${v}`);
}
process.exit(0);
