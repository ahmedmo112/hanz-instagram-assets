// Publishes due posts from posts.json to Instagram and the Facebook Page through the Graph API.
// Runs every 15 minutes from .github/workflows/autopost.yml. Publishes at most one thing per run.
//
// env: META_ACCESS_TOKEN (secret), IG_USER_ID, FB_PAGE_ID,
//      FACEBOOK_ENABLED ("true" = also post to the Page), DRY_RUN ("true" = only report, never publish)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const { META_ACCESS_TOKEN: token, IG_USER_ID: ig, FB_PAGE_ID: page, FACEBOOK_ENABLED, DRY_RUN } = process.env;
const dry = DRY_RUN === 'true';
const fbOn = FACEBOOK_ENABLED === 'true';

const posts = JSON.parse(readFileSync('posts.json', 'utf8'));
const load = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
const done = { instagram: load('posted.json'), facebook: load('posted-facebook.json') };
const save = () => {
  writeFileSync('posted.json', JSON.stringify(done.instagram, null, 2) + '\n');
  writeFileSync('posted-facebook.json', JSON.stringify(done.facebook, null, 2) + '\n');
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
const platformsOf = p => (p.platforms || ['instagram', 'facebook']).filter(x => x === 'instagram' || fbOn);
// Facebook has no "link in bio", so point to the site instead.
const fbCaption = c => c.replace(/link in bio/gi, 'hanzapp.com');

async function graph(method, path, params = {}, accessToken = token) {
  const url = new URL(GRAPH + path);
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const res = method === 'GET' ? await fetch(url + '?' + body) : await fetch(url, { method, body });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${json.error?.message || res.status}`);
  return json;
}

async function checkImages(p) {
  for (const u of p.images) {
    const r = await fetch(u, { method: 'HEAD' });
    if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/jpeg')) throw new Error(`day ${p.day}: image not reachable: ${u}`);
  }
}

// --- Instagram ---
async function waitReady(containerId) {
  for (let i = 0; i < 24; i++) {
    const { status_code } = await graph('GET', `/${containerId}`, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`container ${containerId}: ${status_code}`);
    await sleep(5000);
  }
  throw new Error(`container ${containerId}: not ready after 2 minutes`);
}

const instagram = {
  async existing(p) {
    const { data } = await graph('GET', `/${ig}/media`, { fields: 'id,caption,permalink', limit: '25' });
    const m = data.find(m => norm(m.caption) === norm(p.caption));
    return m && { id: m.id, permalink: m.permalink };
  },
  async publish(p) {
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
  },
};

// --- Facebook Page ---
let pageToken;
async function getPageToken() {
  if (!pageToken) {
    const r = await graph('GET', `/${page}`, { fields: 'name,access_token' });
    if (!r.access_token) throw new Error(`no Page token for ${page}: the token needs pages_manage_posts and access to the Page`);
    pageToken = r.access_token;
  }
  return pageToken;
}

const facebook = {
  async existing(p) {
    const { data } = await graph('GET', `/${page}/posts`, { fields: 'id,message,permalink_url', limit: '25' }, await getPageToken());
    const m = data.find(m => norm(m.message) === norm(fbCaption(p.caption)));
    return m && { id: m.id, permalink: m.permalink_url };
  },
  async publish(p) {
    const pt = await getPageToken();
    const message = fbCaption(p.caption);
    let id;
    if (p.images.length === 1) {
      id = (await graph('POST', `/${page}/photos`, { url: p.images[0], message }, pt)).post_id;
    } else {
      const media = {};
      for (const [i, u] of p.images.entries()) {
        const photo = await graph('POST', `/${page}/photos`, { url: u, published: 'false' }, pt);
        media[`attached_media[${i}]`] = JSON.stringify({ media_fbid: photo.id });
      }
      id = (await graph('POST', `/${page}/feed`, { message, ...media }, pt)).id;
    }
    const { permalink_url } = await graph('GET', `/${id}`, { fields: 'permalink_url' }, pt);
    return { id, permalink: permalink_url };
  },
};

const PLATFORMS = { instagram, facebook };

// Every (post, platform) pair that is due and not yet done, oldest first.
const now = Date.now();
const jobs = posts
  .filter(p => Date.parse(p.publish_at) <= now)
  .sort((a, b) => a.publish_at.localeCompare(b.publish_at))
  .flatMap(p => platformsOf(p).filter(pl => !done[pl][p.id]).map(pl => ({ p, pl })));
const pending = posts.filter(p => platformsOf(p).some(pl => !done[pl][p.id]) && Date.parse(p.publish_at) > now);
console.log(`Instagram: ${Object.keys(done.instagram).length} posted. Facebook: ${fbOn ? `${Object.keys(done.facebook).length} posted` : 'off'}. ` +
  `Due now: ${jobs.map(j => `day ${j.p.day} ${j.pl}`).join(', ') || 'none'}. Next: ${pending[0] ? `day ${pending[0].day} (${pending[0].id}) at ${pending[0].et} ET` : 'none'}.`);

if (dry) {
  for (const p of posts) await checkImages(p);
  console.log(`Dry run: all ${posts.reduce((n, p) => n + p.images.length, 0)} images reachable as JPEG.`);
  if (!token) { console.log('Dry run: no token set, skipped the account checks.'); process.exit(0); }
  const me = await graph('GET', `/${ig}`, { fields: 'username' });
  console.log(`Dry run: token works for Instagram @${me.username}.`);
  if (page) {
    try {
      const { name } = await graph('GET', `/${page}`, { fields: 'name' }, await getPageToken());
      const { data } = await graph('GET', '/me/permissions');
      const granted = data.filter(x => x.status === 'granted').map(x => x.permission);
      const missing = ['pages_manage_posts', 'pages_read_engagement', 'instagram_content_publish'].filter(x => !granted.includes(x));
      if (missing.length) throw new Error(`token is missing ${missing.join(', ')}`);
      console.log(`Dry run: token can post to the Facebook Page "${name}" (pages_manage_posts granted).`);
    } catch (e) { console.log(`Dry run: Facebook Page NOT ready: ${e.message}`); process.exitCode = 1; }
  }
  if (jobs[0]) console.log(`Dry run: would publish day ${jobs[0].p.day} to ${jobs[0].pl} now.`);
  process.exit();
}

if (!jobs.length) process.exit(0);
if (!token || !ig) throw new Error('META_ACCESS_TOKEN or IG_USER_ID is not set');

// Each platform publishes its oldest due post, so Instagram and Facebook go out together,
// and a problem on one platform never holds up the other.
let failed = false;
for (const pl of Object.keys(PLATFORMS)) {
  const job = jobs.find(j => j.pl === pl);
  if (!job) continue;
  const { p } = job;
  try {
    await checkImages(p);
    // Don't post twice: if this caption is already there (e.g. a run that published but failed to save), record it instead.
    const dupe = await PLATFORMS[pl].existing(p);
    const result = dupe || await PLATFORMS[pl].publish(p);
    done[pl][p.id] = { day: p.day, id: result.id, permalink: result.permalink, posted_at: new Date().toISOString(), ...(dupe && { note: 'already there, not posted again' }) };
    save();
    console.log(dupe ? `Day ${p.day} (${p.id}) was already on ${pl}: ${dupe.permalink}. Recorded, not posted again.`
                     : `Published day ${p.day} (${p.id}) to ${pl}: ${result.permalink}`);
  } catch (e) {
    console.error(`Day ${p.day} (${p.id}) failed on ${pl}: ${e.message}`);
    failed = true;
  }
}
if (failed) process.exit(1);
