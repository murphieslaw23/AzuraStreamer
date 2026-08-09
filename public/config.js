// Frontend deployment configuration.
//
// Empty values mean "same origin", which is what the all-in-one Docker
// deployment wants — the Express process serves this file alongside the UI.
//
// In the split deployment the Vercel build replaces this file (see
// .github/workflows/deploy-frontend-vercel.yml) so that the Socket.io client
// connects straight to the backend on IONOS. REST calls stay relative either
// way: on Vercel they are proxied to the backend by the rewrite in vercel.json,
// which keeps them same-origin from the browser's point of view.
window.AZURA_CONFIG = {
  // Absolute origin of the backend, e.g. "https://api.example.org".
  apiOrigin: ''
};
