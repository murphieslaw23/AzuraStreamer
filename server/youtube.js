'use strict';

const { google } = require('googleapis');
const db = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

async function getOAuth2Client(redirectUri = 'http://localhost/api/youtube/callback') {
  const settings = await db.getSettings();
  const clientId = settings.YT_CLIENT_ID;
  const clientSecret = settings.YT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('YouTube Client ID or Client Secret not configured in settings.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthUrl(host) {
  const oauth2Client = await getOAuth2Client(`http://${host}/api/youtube/callback`);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account'
  });
}

async function exchangeCode(code, host) {
  const oauth2Client = await getOAuth2Client(`http://${host}/api/youtube/callback`);
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function createBroadcast(title, description = '', privacyStatus = 'public') {
  const settings = await db.getSettings();
  const oauth2Client = await getOAuth2Client();
  
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
