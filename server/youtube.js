'use strict';

const { google } = require('googleapis');
const db = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

// Build the absolute redirect URI for the OAuth dance. Caddy terminates TLS in
// front of this process, so the public scheme is whatever the client used; if
// the user is on https://azurastreamer.syco23.org then the redirect URI MUST
// be https:// too, or Google rejects the consent screen with
// "redirect_uri_mismatch". When Caddy is in front we trust the X-Forwarded-Proto
// header (express `trust proxy` is set in index.js).
function buildRedirectUri(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/youtube/callback`;
}

async function getOAuth2Client(reqOrRedirectUri) {
  const settings = await db.getSettings();
  const clientId = settings.YT_CLIENT_ID;
  const clientSecret = settings.YT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('YouTube Client ID or Client Secret not configured in settings.');
  }

  // Accept either an Express req (preferred — protocol-aware) or a string.
  const redirectUri = (reqOrRedirectUri && typeof reqOrRedirectUri === 'object' && reqOrRedirectUri.headers)
    ? buildRedirectUri(reqOrRedirectUri)
    : (reqOrRedirectUri || 'http://localhost/api/youtube/callback');

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthUrl(req) {
  const oauth2Client = await getOAuth2Client(req);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    // `prompt: 'consent'` forces Google to show a fresh consent screen and
    // guarantees that the callback's token response includes a refresh_token.
    // `select_account` only picked the account; if the user had previously
    // granted this app the same scope (e.g. a prior session, a test run, or
    // they hit Connect twice), Google re-used the existing grant and
    // returned only an access_token — no refresh_token — so the DB never
    // got the credential and the next createBroadcast call failed with
    // "YouTube account not connected". `consent` is intrusive but it makes
    // the flow deterministic.
    prompt: 'consent',
    include_granted_scopes: true
  });
}

async function exchangeCode(code, req) {
  const oauth2Client = await getOAuth2Client(req);
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function createBroadcast(title, description = '', privacyStatus = 'public') {
  const settings = await db.getSettings();
  // No request object here — the broadcast is created from inside
  // /api/streams/start, where the redirect URI isn't relevant. Pass the
  // configured public origin (or fall back to the current host) so the OAuth
  // client has a valid absolute URL even if no request is in scope.
  const oauth2Client = await getOAuth2Client(`${settings.PUBLIC_ORIGIN || 'http://localhost'}/api/youtube/callback`);
  
  const refreshToken = settings.YT_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('YouTube account not connected. Please connect in settings.');
  }

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client
  });

  // 1. Create Broadcast
  const broadcastResponse = await youtube.liveBroadcasts.insert({
    part: 'snippet,status,contentDetails',
    requestBody: {
      snippet: {
        title: title || 'AzuraStreamer Live',
        description: description || 'Live stream from AzuraCast',
        scheduledStartTime: new Date().toISOString()
      },
      status: {
        privacyStatus: privacyStatus || 'public', 
        selfDeclaredMadeForKids: false
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        monitorStream: { enableMonitorStream: false }
      }
    }
  });

  const broadcastId = broadcastResponse.data.id;

  // 2. Create Stream
  const streamResponse = await youtube.liveStreams.insert({
    part: 'snippet,cdn,status',
    requestBody: {
      snippet: {
        title: `Stream for ${title}`
      },
      cdn: {
        frameRate: '30fps',
        ingestionType: 'rtmp',
        resolution: '720p'
      }
    }
  });

  const streamId = streamResponse.data.id;
  const streamKey = streamResponse.data.cdn.ingestionInfo.streamName;
  const rtmpUrl = streamResponse.data.cdn.ingestionInfo.ingestionAddress;

  // 3. Bind Broadcast to Stream
  await youtube.liveBroadcasts.bind({
    id: broadcastId,
    streamId: streamId,
    part: 'id,contentDetails'
  });

  return {
    broadcastId,
    streamId,
    streamKey,
    rtmpUrl
  };
}

async function testConnection() {
  const settings = await db.getSettings();
  if (!settings.YT_REFRESH_TOKEN) throw new Error('YouTube not connected via OAuth.');
  
  const oauth2Client = await getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: settings.YT_REFRESH_TOKEN });
  
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const res = await youtube.channels.list({ part: 'snippet', mine: true });
  
  if (!res.data.items || res.data.items.length === 0) throw new Error('Could not find YouTube channel.');
  return { channel: res.data.items[0].snippet.title };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  createBroadcast,
  testConnection
};
