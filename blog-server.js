// blog-server.js — Standalone blog handler for the legalislaw.org network
import 'dotenv/config';
import express from 'express';
import { getBlogPosts, getBlogPost, blogListHTML, blogPostHTML, notFoundHTML } from './blog.js';

const app = express();
const BRAND    = process.env.BLOG_BRAND || process.env.APP_BRAND || 'LegalisLaw';
const BASE_URL = process.env.APP_URL    || 'https://legalislaw.org';

app.get('/blog', (_req, res) => {
  res.send(blogListHTML(getBlogPosts(), BRAND, BASE_URL));
});

app.get('/blog/:slug', (req, res) => {
  const post = getBlogPost(req.params.slug);
  if (!post) return res.status(404).send(notFoundHTML(BRAND));
  res.send(blogPostHTML(post, BRAND, BASE_URL));
});

export default app;
