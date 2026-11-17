// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// On any host but the live site, asks the server whether this is the demo copy (DEMO_MODE, demo.js) and, if it is,
// says so at the top of every page, so nobody types real health details into it. The live site never asks.
(function () {
  var LIVE_HOSTS = ['nycmalpractice-ai.vercel.app', 'nycmalpractice.ai', 'www.nycmalpractice.ai'];
  if (LIVE_HOSTS.indexOf(location.hostname) !== -1) return;
  fetch('/api/site-mode').then(function (res) { return res.ok ? res.json() : null; }).then(function (mode) {
    if (!mode || !mode.demo || document.getElementById('demoBanner')) return;
    var bar = document.createElement('div');
    bar.id = 'demoBanner';
    bar.setAttribute('role', 'note');
    bar.style.cssText = 'position:relative;z-index:1000;background:#c9a84c;color:#1a1408;font:600 0.85rem/1.45 Inter,system-ui,sans-serif;padding:0.55rem 1rem;text-align:center';
    bar.innerHTML = 'Demo copy: every patient, family, firm and charge here is synthetic, and cards are Stripe test cards. Please do not enter real information. ' +
      '<a href="/demo/outbox" style="color:#1a1408;text-decoration:underline">See the emails and texts it sends</a>';
    document.body.insertBefore(bar, document.body.firstChild);
  }).catch(function () {});
})();
