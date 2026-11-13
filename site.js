// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// The site's public address, used in the links emailed to law firms. APP_URL overrides it; until the
// site has its own domain, the Vercel address is the one that works.
export const APP_URL = (process.env.APP_URL || 'https://nycmalpractice-ai.vercel.app').replace(/\/+$/, '');
