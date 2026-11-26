// Checks a Google Play purchase token with Google before the
// server believes it. A token the app sends is only a claim; this
// call asks Google whether the subscription is real and live.
//
// No new packages: the service account signs its own token with
// node:crypto, swaps it for an access token at Google, then asks
// the Android Publisher API about the subscription.
//
// The service account is the JSON key made in Play Console
// (Settings, API access). It arrives as
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, or as a file path in
// GOOGLE_PLAY_SERVICE_ACCOUNT_FILE. Without it there is no
// verifier, and the server refuses Play purchases instead of
// trusting them.

const crypto = require('crypto');
const https = require('https');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const LIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Google timed out.')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function getJson(url, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { authorization: `Bearer ${token}` },
      timeout: timeoutMs,
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Google timed out.')));
    request.on('error', reject);
  });
}

async function accessToken(credentials, timeoutMs) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const answer = await postJson(
    TOKEN_URL,
    `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
    timeoutMs,
  );
  if (answer.status !== 200 || !answer.body || !answer.body.access_token) {
    throw new Error('Google refused the service account.');
  }
  return answer.body.access_token;
}

// Builds a verifier from a service account, or returns null when
// there is none. The returned function takes a product id and a
// purchase token and answers { valid: true } only when Google says
// the subscription is live and the product matches. Network and
// auth failures throw, so the caller can answer "try again" instead
// of believing or refusing a purchase it could not check.
function createPlayVerifier({ credentials, packageName, timeoutMs = 10000 } = {}) {
  if (!credentials || !credentials.client_email || !credentials.private_key) {
    return null;
  }
  if (!packageName) {
    return null;
  }
  return async (productId, purchaseToken) => {
    const token = await accessToken(credentials, timeoutMs);
    const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3'
      + `/applications/${encodeURIComponent(packageName)}`
      + `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const answer = await getJson(url, token, timeoutMs);
    if (answer.status === 404 || answer.status === 410) {
      return { valid: false };
    }
    if (answer.status !== 200 || !answer.body) {
      throw new Error(`Google answered ${answer.status}.`);
    }
    const state = answer.body.subscriptionState;
    if (!LIVE_STATES.has(state)) {
      return { valid: false };
    }
    const items = Array.isArray(answer.body.lineItems) ? answer.body.lineItems : [];
    const match = items.some((item) => item && item.productId === productId);
    return { valid: match };
  };
}

// Reads the service account from the server settings. The JSON may
// sit in the setting itself, or in a file the setting points to.
function playCredentialsFromEnv(env = process.env) {
  const direct = typeof env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON === 'string'
    ? env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.trim()
    : '';
  if (direct) {
    try { return JSON.parse(direct); } catch { return null; }
  }
  const file = typeof env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE === 'string'
    ? env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE.trim()
    : '';
  if (!file) return null;
  try {
    return JSON.parse(require('fs').readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { createPlayVerifier, playCredentialsFromEnv };
