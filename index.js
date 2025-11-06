// index.js (CommonJS, Google Cloud Functions)
// Migration: Anthropic -> OpenAI Responses API with web_search
// Two-phase research: (1) LinkedIn-only verification, (2) broader web search

const functions = require('@google-cloud/functions-framework');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Lazy-load OpenAI SDK (stays compatible with CommonJS)
let _openai;
async function getOpenAI() {
  if (_openai) return _openai;
  const OpenAI = (await import('openai')).default;
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// --- Simple in-memory rate limiter (unchanged) ---
const rateLimiter = {
  requests: new Map(),
  windowMs: 60000,
  maxRequests: 10,
  check(ip) {
    const now = Date.now();
    const userRequests = this.requests.get(ip) || [];
    const recentRequests = userRequests.filter((t) => now - t < this.windowMs);
    if (recentRequests.length >= this.maxRequests) return false;
    recentRequests.push(now);
    this.requests.set(ip, recentRequests);
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

// --- Input validation (unchanged) ---
function validateInput(name, title, company) {
  const errors = [];
  if (!name || !title || !company) errors.push('All fields are required');
  if (name && name.length > 100) errors.push('Name must be less than 100 characters');
  if (title && title.length > 150) errors.push('Title must be less than 150 characters');
  if (company && company.length > 150) errors.push('Company must be less than 150 characters');
  const suspiciousPattern = /<script|javascript:|on\w+=/i;
  if (
    suspiciousPattern.test(name || '') ||
    suspiciousPattern.test(title || '') ||
    suspiciousPattern.test(company || '')
  ) {
    errors.push('Invalid characters detected');
  }
  return errors;
}

// --- Helpers ---
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

function cleanJsonText(text) {
  return String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function getResponseText(resp) {
  // Prefer the SDK convenience; fall back defensively
  if (resp && typeof resp.output_text === 'string') return resp.output_text;
  try {
    const firstMsg = Array.isArray(resp?.output)
      ? resp.output.find((x) => x.type === 'message')
      : null;
    const firstText = firstMsg?.content?.find?.((c) => c.type === 'output_text')?.text;
    return firstText || '';
  } catch {
    return '';
  }
}

// --- GCF HTTP function ---
functions.http('generateOpportunities', async (req, res) => {
  // CORS (restrict to helloeiko.com)
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://helloeiko.com',
    'https://www.helloeiko.com',
    'http://helloeiko.com',
    'http://www.helloeiko.com'
  ];
  if (allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  // Only POST with JSON
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const ct = req.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return res.status(415).json({ success: false, error: 'Unsupported Media Type' });
  }

  try {
    const clientIp = getClientIp(req);
    if (!rateLimiter.check(clientIp)) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again in a minute.'
      });
    }

    const { name, title, company } = req.body || {};
    const validationErrors = validateInput(name, title, company);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: validationErrors.join('. ')
      });
    }

    const cleanName = name.trim();
    const cleanTitle = title.trim();
    const cleanCompany = company.trim();

    // Avoid logging PII
    console.log(`Received request for ${cleanCompany} / ${cleanTitle}`);

    const opportunities = await generateOpportunities(cleanName, cleanTitle, cleanCompany);

    // Fire-and-forget logging to Sheets
    logToSheet({
      name: cleanName,
      title: cleanTitle,
      company: cleanCompany,
      opportunities
    }).catch((err) => console.error('Failed to log to sheets:', err));

    return res.json({ success: true, opportunities });
  } catch (error) {
    console.error('Error:', error);
    const userMessage = String(error?.message || '').includes('API')
      ? 'Service temporarily unavailable. Please try again.'
      : 'An error occurred. Please try again.';
    return res.status(500).json({ success: false, error: userMessage });
  }
});

// --- Core orchestration: Phase 1 (LinkedIn) -> Phase 2 (broader web) ---
async function generateOpportunities(name, title, company) {
  const openai = await getOpenAI();
  const model = process.env.OPENAI_MODEL || 'gpt-5'; // set to the exact GPT‑5 model you use

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
3) If you cannot conclusively verify the person and the company on LinkedIn, set "verified" to false.

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
}
  `.trim();

  const phase1 = await openai.responses.create({
    model,
    input: phase1Prompt,
    tool_choice: 'auto',
    tools: [
      {
        type: 'web_search',
        // Phase 1: strictly search LinkedIn only (supported by the web_search tool)
        sites: ['linkedin.com']
      }
    ]
  });

  const phase1Text = cleanJsonText(getResponseText(phase1));
  let p1;
  try {
    p1 = JSON.parse(phase1Text || '{}');
  } catch (e) {
    console.error('Phase 1 parse error:', e, phase1Text);
    p1 = {
      verified: false,
      linkedin_url: null,
      full_name: null,
      title_on_linkedin: null,
      company_on_linkedin: null,
      evidence: [],
      notes: 'Phase 1 JSON parse failed'
    };
  }

  // ---------- Phase 2: broader research & opportunities ----------
  const phase2Prompt = `
You will generate AI opportunities for a SPECIFIC INDIVIDUAL at their company.

CONTEXT FROM LINKEDIN VERIFICATION:
${JSON.stringify(p1, null, 2)}

RESEARCH RULES:
- Use the web_search tool to find current, reliable info.
- Start from the LinkedIn verification context above. If "verified" is false, attempt careful verification via other reputable sources (company site bio, press releases).
- CRITICAL: Do not confuse people or companies with similar names. If you cannot verify that ${name} works at ${company}, state this clearly in "research.person".
- Include source URLs INSIDE the JSON fields you return (they must specifically mention BOTH the person and the company for person/role sections).
- Prefer company site, newsroom, reputable press, and the LinkedIn profile found in Phase 1.

TASK STEPS:
1) PERSON: Summarize what you found about ${name}, including whether they actually work at ${company}. Include 2–5 source URLs that mention both the person and the company.
2) ROLE: Describe what ${name} does day‑to‑day at ${company}, grounded in sources. If not found, say so. Include URLs.
3) COMPANY: Summarize the correct ${company}: industry, products/services, scale, and context. Include URLs.

OUTPUT FORMAT (JSON ONLY):
{
  "research": {
    "person": "Paragraph with findings + source URLs inline or appended.",
    "role": "Paragraph with role‑specific detail + source URLs.",
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
- Return ONLY raw JSON (no markdown).
  `.trim();

  const phase2 = await openai.responses.create({
    model,
    input: phase2Prompt,
    tool_choice: 'auto',
    tools: [{ type: 'web_search' }] // broaden search (no site restriction)
  });

  const phase2Text = cleanJsonText(getResponseText(phase2));

  // Final strict parse & validation (mirrors your original checks)
  let finalObj;
  try {
    finalObj = JSON.parse(phase2Text);
    if (!finalObj?.research || !finalObj?.opportunities) {
      throw new Error('Invalid response format - missing research or opportunities');
    }
    if (
      !Array.isArray(finalObj.opportunities) ||
      finalObj.opportunities.length === 0
    ) {
      throw new Error('Invalid response format - opportunities must be an array');
    }
    for (const opp of finalObj.opportunities) {
      if (!opp.title || !opp.description) throw new Error('Invalid opportunity format');
    }
    const r = finalObj.research;
    if (!r.person || !r.role || !r.company) {
      throw new Error('Invalid research format');
    }
  } catch (e) {
    console.error('Phase 2 parse error:', e);
    console.error('Raw model text:', phase2Text);
    throw new Error('Failed to parse AI response');
  }

  return finalObj;
}

// --- Google Sheets logging (unchanged) ---
async function logToSheet(data) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Format opportunities as text
    const opportunitiesText = data.opportunities.opportunities
      .map((opp, idx) => `${idx + 1}. ${opp.title}: ${opp.description}`)
      .join('\n\n');

    // Format research as text
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

