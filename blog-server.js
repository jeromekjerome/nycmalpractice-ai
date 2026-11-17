// blog-server.js — Blog routes (/blog and /blog/:slug), mounted by server.js.
// BLOG_BRAND (or APP_BRAND) and APP_URL override the brand name and the canonical base URL.
import 'dotenv/config';
import express from 'express';
import { getBlogPosts, getBlogPost, blogListHTML, blogPostHTML, notFoundHTML, sitemapXML } from './blog.js';
import { APP_URL } from './site.js';
import { securityHeaders } from './security-headers.js';

const app = express();
app.use(securityHeaders);
const BRAND    = process.env.BLOG_BRAND || process.env.APP_BRAND || 'NYCMalpractice.ai';
// Links and canonical addresses name the live site. The demo copy (demo.js) sets CANONICAL_URL to it, so search
// engines treat the live pages as the originals.
const BASE_URL = (process.env.CANONICAL_URL || APP_URL).replace(/\/+$/, '');

app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').send(sitemapXML(getBlogPosts(), BASE_URL));
});

app.get('/blog', (_req, res) => {
  res.send(blogListHTML(getBlogPosts(), BRAND, BASE_URL));
});

app.get('/blog/:slug', (req, res) => {
  const post = getBlogPost(req.params.slug);
  if (!post) return res.status(404).send(notFoundHTML(BRAND));
  res.send(blogPostHTML(post, BRAND, BASE_URL));
});

export default app;
