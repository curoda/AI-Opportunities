// index.js — Cloud Run (Express) or Functions Framework compatible
// - Robust CORS (preflight handled first)
// - Two-phase research with OpenAI Responses API + web_search
// - Logs to Google Sheets
// - Exports Express app for Functions Framework; self-listens for plain Express

const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- Boot diagnostics ---
console.log('Booting generate-opportunities service (Node', process.version, ')');
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));

// -------------------- Utilities --------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

// Lazy-load OpenAI (works with CommonJS)
let _openai;
async function getOpenAI() {
  if (_openai) return _openai;
  const OpenAI = (await import('openai')).default;
  _openai = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  return _openai;
}

// Simple in-memory rate limiter (per-instance)
const rateLimiter = {
  requests: new Map(),
  windowMs: 60_000,
  maxRequests: 10,
  check(ip) {
    const now = Date.now();
    const list = this.requests.get(ip) || [];
    const recent = list.filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxRequests) return false;
    recent.push(now);
    this.requests.set(ip, recent);
    if (Math.random() < 0.01) this.cleanup(now);
    return true;
  },
  cleanup(now) {
    for (const [ip, times] of this.requests.entries()) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.requests.delete(ip);
      else this.requests.set(ip, recent);
    }
  }
};

function validateInput(name, title, company) {
  const errors = [];
  if (!name || !title || !company) errors.push('All fields are required');
  if (name && name.length > 100) errors.push('Name must be less than 100 characters');
  if (title && title.length > 150) errors.push('Title must be less than 150 characters');
  if (company && company.length > 150) errors.push('Company must be less than 150 characters');
  const suspicious = /<script|javascript:|on\w+=/i;
  if (suspicious.test(name || '') || suspicious.test(title || '') || suspicious.test(company || '')) {
    errors.push('Invalid characters detected');
  }
  return errors;
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function cleanJsonText(text) {
  return String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}
function getResponseText(resp) {
  if (resp && typeof resp.output_text === 'string') return resp.output_text;
  try {
    const firstMsg = Array.isArray(resp?.output) ? resp.output.find((x) => x.type === 'message') : null;
    const firstText = firstMsg?.content?.find?.((c) => c.type === 'output_text')?.text;
    return firstText || '';
  } catch {
    return '';
  }
}

// -------------------- Core orchestration --------------------
async function generateOpportunities(name, title, company) {
  const openai = await getOpenAI();
  const model = process.env.OPENAI_MODEL || 'gpt-5';

  // ---------- Phase 1: LinkedIn-only verification ----------
  const phase1Prompt = `
You are a precise researcher. First, verify a person's identity and current employer using LinkedIn ONLY.

INPUT:
- Name: ${name}
- Title (claimed): ${title}
- Company (claimed): ${company}

INSTRUCTIONS:
1) Use the web_search tool restricted to linkedin.com to find the person's profile and confirm employment at the EXACT company (not a lookalike).
2) If multiple profiles exist, pick the one that most clearly matches the name + company + title.
3) If you cannot conclusively verify on LinkedIn, set "verified" to false.

RESPONSE:
Return ONLY valid JSON (no markdown) in this exact schema:
{
  "verified": boolean,
  "linkedin_url": "string or null",
  "full_name": "string or null",
  "title_on_linkedin": "string or null",
  "company_on_linkedin": "string or null",
  "evidence": ["list of linkedin URLs you used"],
  "notes": "brief explanation"
}`.trim();

  const controller1 = new AbortController();
  const t1 = setTimeout(() => controller1.abort(), Number(process.env.OPENAI_TIMEOUT_MS || 60000));
  let p1;
  try {
    const phase1 = await openai.responses.create({
      model,
      input: phase1Prompt,
      tool_choice: 'auto',
      tools: [{ type: 'web_search', sites: ['linkedin.com'] }],
      response_format: { type: 'json_object' }, // enforce JSON
      signal: controller1.signal
    });
    const phase1Text = cleanJsonText(getResponseText(phase1));
    p1 = JSON.parse(phase1Text || '{}');
  } catch (e) {
    console.error('Phase 1 error:', e?.message || e);
    p1 = {
      verified: false, linkedin_url: null, full_name: null,
      title_on_linkedin: null, company_on_linkedin: null, evidence: [], notes: 'Phase 1 failed'
    };
  } finally {
    clearTimeout(t1);
  }

  // ---------- Phase 2: broader research & opportunities ----------
  const phase2Prompt = `
You will generate AI opportunities for a SPECIFIC INDIVIDUAL at their company.

CONTEXT FROM LINKEDIN VERIFICATION:
${JSON.stringify(p1, null, 2)}

RESEARCH RULES:
- Use the web_search tool to find current, reliable info.
- Start from the LinkedIn verification context above. If "verified" is false, attempt careful verification via other reputable sources (company site bio, press releases).
- CRITICAL: Do not confuse people/companies with similar names. If you cannot verify that ${name} works at ${company}, state this clearly in "research.person".
- Include source URLs INSIDE the JSON fields you return (they must specifically mention BOTH the person and the company for person/role sections).
- Prefer company site, newsroom, reputable press, and the LinkedIn profile found in Phase 1.

OUTPUT FORMAT (JSON ONLY):
{
  "research": {
    "person": "Paragraph with findings + source URLs.",
    "role": "Paragraph with role-specific detail + source URLs.",
    "company": "Paragraph about the correct company + source URLs."
  },
  "opportunities": [
    {
      "title": "5-8 word opportunity title",
      "description": "2-3 sentences on how this helps ${name} specifically in their actual role."
    }
  ]
}

VERIFICATION GUARDRAILS:
- If any source refers to a different person or different company, ignore it.
- If you remain uncertain, say "I could not verify..." in "research.person".
- Return ONLY raw JSON (no markdown).`.trim();

  const controller2 = new AbortController();
  const t2 = setTimeout(() => controller2.abort(), Number(process.env.OPENAI_TIMEOUT_MS || 60000));
  let finalObj;
  try {
    const phase2 = await openai.responses.create({
      model,
      input: phase2Prompt,
      tool_choice: 'auto',
      tools: [{ type: 'web_search' }],
      response_format: { type: 'json_object' }, // enforce JSON
      signal: controller2.signal
    });

    const phase2Text = cleanJsonText(getResponseText(phase2));
    let parsed;
    try {
      parsed = JSON.parse(phase2Text);
    } catch (e) {
      console.error('Phase 2 parse error:', e?.message || e);
      console.error('Phase 2 raw text (truncated):', (phase2Text || '').slice(0, 1500));
      throw new Error('Failed to parse AI response');
    }

    // Schema validation
    if (!parsed?.research || !parsed?.opportunities) {
      console.error('Phase 2 schema missing keys. Raw (truncated):', (phase2Text || '').slice(0, 1500));
      throw new Error('Invalid response format - missing research or opportunities');
    }
    if (!Array.isArray(parsed.opportunities) || parsed.opportunities.length === 0) {
      throw new Error('Invalid response format - opportunities must be an array');
    }
    for (const opp of parsed.opportunities) {
      if (!opp.title || !opp.description) throw new Error('Invalid opportunity format');
    }
    const r = parsed.research;
    if (!r.person || !r.role || !r.company) throw new Error('Invalid research format');

    finalObj = parsed;
  } finally {
    clearTimeout(t2);
  }

  return finalObj;
}

// -------------------- Google Sheets logging --------------------
async function logToSheet(data) {
  try {
    const serviceAccountAuth = new JWT({
      email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      key: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(requireEnv('GOOGLE_SHEET_ID'), serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    const opportunitiesText = data.opportunities.opportunities
      .map((opp, idx) => `${idx + 1}. ${opp.title}: ${opp.description}`)
      .join('\n\n');

    const researchText = `PERSON: ${data.opportunities.research.person}\n\nROLE: ${data.opportunities.research.role}\n\nCOMPANY: ${data.opportunities.research.company}`;

    await sheet.addRow({
      Timestamp: new Date().toISOString(),
      Name: data.name,
      Title: data.title,
      Company: data.company,
      Research: researchText,
      Opportunities: opportunitiesText
    });

    console.log('Successfully logged to Google Sheets');
  } catch (error) {
    console.error('Error logging to Google Sheets:', error);
    throw error;
  }
}

// -------------------- Express server (Cloud Run) --------------------
const app = express();
app.enable('trust proxy'); // correct client IPs via x-forwarded-for

// CORS FIRST (preflight before anything else)
const allowedOrigins = new Set([
  'https://helloeiko.com',
  'https://www.helloeiko.com',
  'http://helloeiko.com',
  'http://www.helloeiko.com'
]);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const reqHeaders = req.headers['access-control-request-headers'];
  const reqMethod  = req.headers['access-control-request-method'];

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', reqHeaders || 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '3600');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

app.use((req, res, next) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    const reqMethod = req.headers['access-control-request-method'];
    if (reqMethod) res.setHeader('Access-Control-Allow-Methods', reqMethod);
    return res.status(204).end();
  }
  next();
});

app.options('*', (req, res) => {
  setCorsHeaders(req, res);
  return res.status(204).end();
});

// parse JSON after CORS
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.status(200).send('ok'));

// Main endpoint
app.post('/', async (req, res) => {
  const ct = (req.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return res.status(415).json({ success: false, error: 'Unsupported Media Type' });
  }

  try {
    const clientIp = getClientIp(req);
    if (!rateLimiter.check(clientIp)) {
      return res.status(429).json({ success: false, error: 'Too many requests. Please try again in a minute.' });
    }

    const { name, title, company } = req.body || {};
    const validationErrors = validateInput(name, title, company);
    if (validationErrors.length > 0) {
      return res.status(400).json({ success: false, error: validationErrors.join('. ') });
    }

    const cleanName = name.trim();
    const cleanTitle = title.trim();
    const cleanCompany = company.trim();

    console.log(`Request for ${cleanCompany} / ${cleanTitle}`);

    const opportunities = await generateOpportunities(cleanName, cleanTitle, cleanCompany);

    // Fire-and-forget logging
    logToSheet({ name: cleanName, title: cleanTitle, company: cleanCompany, opportunities })
      .catch((err) => console.error('Failed to log to sheets:', err));

    return res.json({ success: true, opportunities });
  } catch (error) {
    console.error('Error:', error);
    const userMessage = String(error?.message || '').includes('Failed to parse AI response')
      ? 'The research service returned an unexpected format. Please try again.'
      : (String(error?.message || '').includes('API')
         ? 'Service temporarily unavailable. Please try again.'
         : 'An error occurred. Please try again.');
    return res.status(502).json({ success: false, error: userMessage });
  }
});

// ---- Make it run in BOTH modes ----
// 1) Export for Functions Framework (so --target=generateOpportunities works)
module.exports.generateOpportunities = app;

// 2) Self-start the server when run directly (plain Express on Cloud Run)
if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
