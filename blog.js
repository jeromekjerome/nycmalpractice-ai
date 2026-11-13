// blog.js — Shared blog module for the legalislaw.org network
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(__dirname, 'content', 'blog');

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatDate(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return dateStr; }
}
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = val;
  }
  return { meta, body: match[2] };
}
export function getBlogPosts() {
  if (!existsSync(BLOG_DIR)) return [];
  const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  const posts = files.map(file => {
    const slug = file.replace(/\.md$/, '');
    const raw = readFileSync(join(BLOG_DIR, file), 'utf8');
    const { meta } = parseFrontmatter(raw);
    return { slug, title: meta.title || slug, date: meta.date || '', description: meta.description || '', author: meta.author || 'NYCMalpractice.ai Editorial', tags: meta.tags ? meta.tags.split(',').map(t => t.trim()) : [] };
  }).filter(p => p.date);
  return posts.sort((a, b) => new Date(b.date) - new Date(a.date));
}
export function getBlogPost(slug) {
  const filePath = join(BLOG_DIR, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return { slug, title: meta.title || slug, date: meta.date || '', description: meta.description || '', author: meta.author || 'NYCMalpractice.ai Editorial', tags: meta.tags ? meta.tags.split(',').map(t => t.trim()) : [], html: marked.parse(body), canonical: meta.canonical || '' };
}
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a202c; background: #fff; line-height: 1.7; }
  a { color: #2563eb; text-decoration: none; } a:hover { text-decoration: underline; }
  .site-header { background: #1a3a5c; padding: 1rem 2rem; display: flex; align-items: center; justify-content: space-between; }
  .site-header .brand { color: #fff; font-weight: 700; font-size: 1.2rem; }
  .site-header nav a { color: rgba(255,255,255,0.8); margin-left: 1.5rem; font-size: 0.875rem; }
  .site-header nav a:hover { color: #fff; text-decoration: none; }
  .container { max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem; }
  h1.page-title { font-size: 2rem; font-weight: 800; margin-bottom: 1.5rem; }
  .post-grid { display: grid; gap: 1.5rem; }
  .post-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; transition: box-shadow 0.15s; }
  .post-card:hover { box-shadow: 0 4px 14px rgba(0,0,0,0.08); }
  .post-card h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 0.35rem; }
  .post-card h2 a { color: #1a3a5c; }
  .post-card time { font-size: 0.78rem; color: #718096; display: block; margin-bottom: 0.6rem; }
  .post-card p { color: #4a5568; font-size: 0.93rem; margin-bottom: 0.9rem; }
  .read-more { font-size: 0.875rem; font-weight: 600; color: #2563eb; }
  .article-header { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid #e2e8f0; }
  .article-header h1 { font-size: 1.9rem; line-height: 1.3; margin-bottom: 0.75rem; }
  .article-meta { color: #718096; font-size: 0.875rem; }
  .article-body { max-width: 720px; }
  .article-body h2 { font-size: 1.35rem; margin: 2rem 0 0.75rem; }
  .article-body h3 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
  .article-body p { margin-bottom: 1.2rem; }
  .article-body ul, .article-body ol { padding-left: 1.5rem; margin-bottom: 1.2rem; }
  .article-body li { margin-bottom: 0.4rem; }
  .article-body blockquote { border-left: 4px solid #2563eb; padding: 0.75rem 1.2rem; background: #eff6ff; margin: 1.5rem 0; border-radius: 0 4px 4px 0; }
  .article-body strong { font-weight: 700; }
  .article-body hr { border: none; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
  .back-link { display: inline-block; margin-bottom: 1.5rem; color: #718096; font-size: 0.875rem; }
  .tags { margin-top: 0.75rem; }
  .tag { display: inline-block; background: #e2e8f0; color: #4a5568; font-size: 0.72rem; padding: 0.2rem 0.55rem; border-radius: 4px; margin-right: 0.4rem; }
  .disclaimer { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 1rem 1.25rem; font-size: 0.8rem; color: #718096; margin-top: 2.5rem; }
  footer { text-align: center; padding: 2rem; color: #718096; font-size: 0.83rem; border-top: 1px solid #e2e8f0; margin-top: 3rem; }
  @media (max-width: 600px) { h1.page-title { font-size: 1.5rem; } .article-header h1 { font-size: 1.4rem; } .container { padding: 1.5rem 1rem; } .site-header { padding: 0.75rem 1rem; } }
`;
export function blogListHTML(posts, brand, baseUrl) {
  const items = posts.map(p => `<article class="post-card"><a href="/blog/${escHtml(p.slug)}"><h2>${escHtml(p.title)}</h2></a><time datetime="${escHtml(p.date)}">${formatDate(p.date)}</time><p>${escHtml(p.description)}</p><a class="read-more" href="/blog/${escHtml(p.slug)}">Read article &#x2192;</a></article>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legal Blog &#8212; ${escHtml(brand)}</title><meta name="description" content="Legal guides and resources from ${escHtml(brand)}."><link rel="canonical" href="${baseUrl}/blog"><meta property="og:title" content="Legal Blog &#8212; ${escHtml(brand)}"><meta property="og:type" content="website"><meta property="og:url" content="${baseUrl}/blog"><style>${CSS}</style></head><body><header class="site-header"><a href="/" class="brand">${escHtml(brand)}</a><nav><a href="/blog">Blog</a></nav></header><main class="container"><h1 class="page-title">Legal Insights</h1>${posts.length === 0 ? '<p style="color:#718096">Articles coming soon.</p>' : `<div class="post-grid">${items}</div>`}</main><footer><p>&copy; ${new Date().getFullYear()} ${escHtml(brand)}. For informational purposes only &#8212; not legal advice.</p></footer></body></html>`;
}
export function blogPostHTML(post, brand, baseUrl) {
  const canonical = post.canonical || `${baseUrl}/blog/${post.slug}`;
  const tagHtml = post.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: post.title, description: post.description, datePublished: post.date, author: { '@type': 'Person', name: post.author }, publisher: { '@type': 'Organization', name: brand }, mainEntityOfPage: { '@type': 'WebPage', '@id': canonical } });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(post.title)} &#8212; ${escHtml(brand)}</title><meta name="description" content="${escHtml(post.description)}"><link rel="canonical" href="${canonical}"><meta property="og:title" content="${escHtml(post.title)}"><meta property="og:description" content="${escHtml(post.description)}"><meta property="og:type" content="article"><meta property="og:url" content="${canonical}"><meta property="article:published_time" content="${post.date}"><script type="application/ld+json">${jsonLd}</script><style>${CSS}</style></head><body><header class="site-header"><a href="/" class="brand">${escHtml(brand)}</a><nav><a href="/blog">Blog</a></nav></header><main class="container"><a class="back-link" href="/blog">&#x2190; All articles</a><header class="article-header"><h1>${escHtml(post.title)}</h1><p class="article-meta">By ${escHtml(post.author)} &nbsp;&middot;&nbsp; <time datetime="${post.date}">${formatDate(post.date)}</time></p>${tagHtml ? `<div class="tags">${tagHtml}</div>` : ''}</header><div class="article-body">${post.html}</div><aside class="disclaimer"><strong>Legal Disclaimer:</strong> This article is for general informational purposes only and does not constitute legal advice. Consult a licensed attorney for advice specific to your situation.</aside></main><footer><p>&copy; ${new Date().getFullYear()} ${escHtml(brand)}. For informational purposes only &#8212; not legal advice.</p></footer></body></html>`;
}
export function notFoundHTML(brand) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found &#8212; ${escHtml(brand)}</title><style>${CSS}</style></head><body><header class="site-header"><a href="/" class="brand">${escHtml(brand)}</a><nav><a href="/blog">Blog</a></nav></header><main class="container"><h1 class="page-title">Article Not Found</h1><p><a href="/blog">&#x2190; Back to all articles</a></p></main></body></html>`;
}
