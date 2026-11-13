// blog-server.js — Blog routes (/blog and /blog/:slug), routed here by vercel.json.
// BLOG_BRAND (or APP_BRAND) and APP_URL override the brand name and the canonical base URL.
import 'dotenv/config';
import express from 'express';
import { getBlogPosts, getBlogPost, blogListHTML, blogPostHTML, notFoundHTML } from './blog.js';
import { APP_URL } from './site.js';

const app = express();
const BRAND    = process.env.BLOG_BRAND || process.env.APP_BRAND || 'NYCMalpractice.ai';
const BASE_URL = APP_URL;

app.get('/blog', (_req, res) => {
  res.send(blogListHTML(getBlogPosts(), BRAND, BASE_URL));
});

app.get('/blog/:slug', (req, res) => {
  const post = getBlogPost(req.params.slug);
  if (!post) return res.status(404).send(notFoundHTML(BRAND));
  res.send(blogPostHTML(post, BRAND, BASE_URL));
});

export default app;
