// Vercel entry point. vercel.json rewrites every request that is not a static file in public/
// to this function, and the Express app in server.js does the routing.
export { default } from '../server.js';
