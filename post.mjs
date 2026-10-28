// Publishes the next due Instagram post from posts.json through the Graph API.
// Runs every 15 minutes from .github/workflows/autopost.yml. Posts at most one per run.
//
// env: META_ACCESS_TOKEN (secret), IG_USER_ID, DRY_RUN ("true" = only report, never publish)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const { META_ACCESS_TOKEN: token, IG_USER_ID: ig, DRY_RUN } = process.env;
const dry = DRY_RUN === 'true';

const posts = JSON.parse(readFileSync('posts.json', 'utf8'));
const posted = existsSync('posted.json') ? JSON.parse(readFileSync('posted.json', 'utf8')) : {};
const save = () => writeFileSync('posted.json', JSON.stringify(posted, null, 2) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '').replace(/\s+/g, ' ').trim();

async function graph(method, path, params = {}) {
  const url = new URL(GRAPH + path);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET'
    ? await fetch(url + '?' + body)
    : await fetch(url, { method, body });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${json.error?.message || res.status}`);
  return json;
}

async function waitReady(containerId) {
  for (let i = 0; i < 24; i++) {
    const { status_code } = await graph('GET', `/${containerId}`, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`container ${containerId}: ${status_code}`);
    await sleep(5000);
  }
  throw new Error(`container ${containerId}: not ready after 2 minutes`);
}

async function checkImages(p) {
  for (const u of p.images) {
    const r = await fetch(u, { method: 'HEAD' });
    if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/jpeg')) throw new Error(`day ${p.day}: image not reachable: ${u}`);
  }
}

async function publish(p) {
  let creation;
  if (p.images.length === 1) {
    creation = (await graph('POST', `/${ig}/media`, { image_url: p.images[0], caption: p.caption })).id;
  } else {
    const children = [];
    for (const u of p.images) {
      const { id } = await graph('POST', `/${ig}/media`, { image_url: u, is_carousel_item: 'true' });
      await waitReady(id);
      children.push(id);
    }
    creation = (await graph('POST', `/${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: p.caption })).id;
  }
  await waitReady(creation);
  const { id } = await graph('POST', `/${ig}/media_publish`, { creation_id: creation });
  const { permalink } = await graph('GET', `/${id}`, { fields: 'permalink' });
  return { id, permalink };
}

const now = Date.now();
const due = posts.filter(p => !posted[p.id] && Date.parse(p.publish_at) <= now).sort((a, b) => a.publish_at.localeCompare(b.publish_at));
const next = posts.find(p => !posted[p.id] && Date.parse(p.publish_at) > now);
console.log(`${Object.keys(posted).length} of ${posts.length} posted. Due now: ${due.map(p => `day ${p.day}`).join(', ') || 'none'}. Next: ${next ? `day ${next.day} (${next.id}) at ${next.et} ET` : 'none'}.`);

if (dry) {
  for (const p of posts) await checkImages(p);
  console.log(`Dry run: all ${posts.reduce((n, p) => n + p.images.length, 0)} images reachable as JPEG.`);
  if (token && ig) {
    const me = await graph('GET', `/${ig}`, { fields: 'username' });
    console.log(`Dry run: token works for @${me.username}.`);
  } else console.log('Dry run: no token set, skipped the account check.');
  if (due[0]) console.log(`Dry run: would publish day ${due[0].day} (${due[0].id}) now.`);
  process.exit(0);
}

if (!due.length) process.exit(0);
if (!token || !ig) throw new Error('META_ACCESS_TOKEN or IG_USER_ID is not set');

const p = due[0];
// Don't post twice: if this caption is already on the account (e.g. a run that published but failed to save), record it instead.
const recent = await graph('GET', `/${ig}/media`, { fields: 'id,caption,permalink', limit: '25' });
const dupe = recent.data.find(m => norm(m.caption) === norm(p.caption));
if (dupe) {
  posted[p.id] = { day: p.day, media_id: dupe.id, permalink: dupe.permalink, posted_at: new Date().toISOString(), note: 'already on the account, not posted again' };
  save();
  console.log(`Day ${p.day} (${p.id}) is already on the account: ${dupe.permalink}. Recorded, not posted again.`);
  process.exit(0);
}

await checkImages(p);
const result = await publish(p);
posted[p.id] = { day: p.day, media_id: result.id, permalink: result.permalink, posted_at: new Date().toISOString() };
save();
console.log(`Published day ${p.day} (${p.id}): ${result.permalink}`);
