# Route map

Routing is declared in `server/index.js` with Express static serving and explicit page routes.

| URL | File | Layout | Access |
| --- | --- | --- | --- |
| `/` | `public/index.html` | Authenticated dashboard shell | Authenticated |
| `/login.html` | `public/login.html` | Standalone auth card | Public |
| `/setup.html` | `public/setup.html` | Standalone setup card | Public |
| `/privacy`, `/privacy.html` | `public/privacy.html` | Standalone legal page | Public |
| `/terms`, `/terms.html` | `public/terms.html` | Standalone legal page | Public |

## Router source

```js
const publicPaths = new Set([
  '/login.html',
  '/setup.html',
  '/privacy.html',
  '/terms.html',
  '/api/login',
  '/api/setup',
  '/api/setup/status',
]);

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
```

## Key page summary

`/` is the primary stream operator surface. It reads station, now-playing, stream, and settings data; opens Socket.io for live updates; supports YouTube/Twitch selection; starts/stops streams; displays preview/runtime stats/logs; and opens a settings modal for AzuraCast and platform credentials.
