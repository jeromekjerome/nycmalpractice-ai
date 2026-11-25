// Vercel entry point. vercel.json rewrites every request that is not a static file in public/ to this function, except
// the two case-library jobs (/api/cron/library and /api/cron/screen), which go to api/jobs.js for its longer time limit.
// The Express app in server.js does the routing.
export { default } from '../server.js';
