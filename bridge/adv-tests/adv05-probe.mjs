import { init, call } from './adv05-lib.mjs';
await init();
const PID = 301370771;
const snap = await call('take_snapshot', { pageId: PID });
console.log(snap.text.slice(0, 6000));
process.exit(0);
