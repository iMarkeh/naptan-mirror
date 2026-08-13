// Trigger endpoint for the Naptan Mirror.
//
// A button on the status page and the other sites both POST to refresh. 
// This function asks GitHub to run the refresh workflow (workflow_dispatch). It refuses to fire twice within MIN_GAP_MS to save spam/overload.
//
// Secrets live in Cloudflare, never in this file:
//   MIRROR_REPO       e.g. yourusername/naptan-mirror
//   GH_TRIGGER_TOKEN  fine-grained PAT with "Actions: Read and write"
//
// GitHub's "workflow_dispatch" only triggers workflows on the default branch, so ref is pinned to main here.

const META_URL = 'https://naptan-mirror.pages.dev/meta.json';
const WORKFLOW = 'refresh.yml';
const REF = 'main';
const MIN_GAP_MS = 30 * 60 * 1000; // 30 minutes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestPost({ env }) {
  const repo = env.MIRROR_REPO;
  const token = env.GH_TRIGGER_TOKEN;
  if (!repo || !token) {
    return json({ ok: false, error: 'not_configured' }, 500);
  }

  // Rate guard: refuse if the data was refreshed in the last 30 minutes.
  try {
    const metaRes = await fetch(META_URL);
    if (metaRes.ok) {
      const meta = await metaRes.json();
      const last = Date.parse(meta.generatedAt);
      if (Number.isFinite(last) && Date.now() - last < MIN_GAP_MS) {
        return json(
          { ok: false, error: 'recently_refreshed', generatedAt: meta.generatedAt },
          429
        );
      }
    }
  } catch {
    // meta.json unreachable - allow the dispatch anyway.
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'naptan-mirror-trigger',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: REF }),
    }
  );

  if (res.status === 204) {
    return json({ ok: true });
  }
  const detail = (await res.text()).slice(0, 300);
  return json({ ok: false, error: 'github', status: res.status, detail }, 502);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
