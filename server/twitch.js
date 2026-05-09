'use strict';

const axios = require('axios');
const db = require('./db');
const querystring = require('querystring');

const TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

async function getAuthUrl(host) {
  const settings = await db.getSettings();
  const clientId = settings.TWITCH_CLIENT_ID;
  const redirectUri = `http://${host}/api/twitch/callback`;

  if (!clientId) throw new Error('Twitch Client ID not configured in settings.');

  const params = querystring.stringify({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'channel:read:stream_key user:read:email',
    force_verify: true
  });

  return `${TWITCH_AUTH_URL}?${params}`;
}

async function exchangeCode(code, host) {
  const settings = await db.getSettings();
  const clientId = settings.TWITCH_CLIENT_ID;
  const clientSecret = settings.TWITCH_CLIENT_SECRET;
  const redirectUri = `http://${host}/api/twitch/callback`;

  const res = await axios.post(TWITCH_TOKEN_URL, querystring.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    code: code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  }));

  return res.data;
}

async function getStreamKey(accessToken) {
  const settings = await db.getSettings();
  const clientId = settings.TWITCH_CLIENT_ID;

  // 1. Get User ID
  const userRes = await axios.get(`${TWITCH_API_BASE}/users`, {
    headers: {
      'Client-ID': clientId,
      'Authorization': `Bearer ${accessToken}`
    }
  });

  const userId = userRes.data.data[0].id;
  const username = userRes.data.data[0].login;

  // 2. Get Stream Key
  const keyRes = await axios.get(`${TWITCH_API_BASE}/streams/key?broadcaster_id=${userId}`, {
    headers: {
      'Client-ID': clientId,
      'Authorization': `Bearer ${accessToken}`
    }
  });

  return { streamKey: keyRes.data.data[0].stream_key, username };
}

async function testConnection() {
  const settings = await db.getSettings();
  if (!settings.TWITCH_REFRESH_TOKEN) throw new Error('Twitch not connected via OAuth.');

  // Refresh token to get fresh access token
  const resp = await axios.post(TWITCH_TOKEN_URL, querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: settings.TWITCH_REFRESH_TOKEN,
    client_id: settings.TWITCH_CLIENT_ID,
    client_secret: settings.TWITCH_CLIENT_SECRET
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const accessToken = resp.data.access_token;
  const userRes = await axios.get(`${TWITCH_API_BASE}/users`, {
    headers: {
      'Client-ID': settings.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!userRes.data.data || userRes.data.data.length === 0) throw new Error('Could not find Twitch user.');
  return { user: userRes.data.data[0].display_name };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getStreamKey,
  testConnection
};
