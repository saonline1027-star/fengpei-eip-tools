// 鋒霈 EIP 觸發中繼
// 環境變數（在 Cloudflare Worker 設定）：GH_OWNER、GH_REPO、GH_TOKEN

const ALLOWED = ['clock-out.yml', 'apply-ot.yml'];

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return cors(null, 204);
    }

    if (request.method !== 'POST') {
      return cors(json({ error: 'Method not allowed' }), 405);
    }

    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: '請求格式錯誤' }), 400); }

    const { workflow, inputs } = body;

    if (!ALLOWED.includes(workflow)) {
      return cors(json({ error: '未知的 workflow' }), 400);
    }

    if (!inputs?.username || !inputs?.password) {
      return cors(json({ error: '缺少員工編號或密碼' }), 400);
    }

    const ghRes = await fetch(
      `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GH_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fengpei-worker/1.0',
        },
        body: JSON.stringify({ ref: 'main', inputs }),
      }
    );

    if (ghRes.status === 204) {
      return cors(json({ ok: true }));
    }

    const errText = await ghRes.text().catch(() => '');
    return cors(json({ error: `GitHub 回應 ${ghRes.status}`, detail: errText }), 502);
  }
};

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function cors(response, status) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (!response) {
    return new Response(null, { status: status || 204, headers });
  }
  const r = new Response(response.body, { status: status || response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
  return r;
}
