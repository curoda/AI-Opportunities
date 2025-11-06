const functions = require('@google-cloud/functions-framework');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Simple in-memory rate limiter
// NOTE: This has limitations in production. When Cloud Functions scale to multiple
// instances, each instance has its own Map. For true rate limiting, consider
// using Cloud Armor, Redis, or Firestore. For low-traffic use, this is acceptable.
const rateLimiter = {
  requests: new Map(),
  windowMs: 60000, // 1 minute
  maxRequests: 10, // 10 requests per minute per IP
  
  check(ip) {
    const now = Date.now();
    const userRequests = this.requests.get(ip) || [];
    
    // Remove old requests outside the time window
    const recentRequests = userRequests.filter(time => now - time < this.windowMs);
    
    if (recentRequests.length >= this.maxRequests) {
      return false; // Rate limit exceeded
    }
    
    recentRequests.push(now);
    this.requests.set(ip, recentRequests);
    
    // Cleanup old entries periodically
    if (Math.random() < 0.01) { // 1% chance
      this.cleanup(now);
    }
    
    return true; // Request allowed
  },
  
  cleanup(now) {
    for (const [ip, times] of this.requests.entries()) {
      const recentTimes = times.filter(time => now - time < this.windowMs);
      if (recentTimes.length === 0) {
        this.requests.delete(ip);
      } else {
        this.requests.set(ip, recentTimes);
      }
    }
  }
};

// Input validation
function validateInput(name, title, company) {
  const errors = [];
  
  // Check required fields
  if (!name || !title || !company) {
    errors.push('All fields are required');
  }
  
  // Check lengths
  if (name && name.length > 100) {
    errors.push('Name must be less than 100 characters');
  }
  if (title && title.length > 150) {
    errors.push('Title must be less than 150 characters');
  }
  if (company && company.length > 150) {
    errors.push('Company must be less than 150 characters');
  }
  
  // Check for suspicious patterns (basic XSS prevention)
  const suspiciousPattern = /<script|javascript:|on\w+=/i;
  if (suspiciousPattern.test(name) || suspiciousPattern.test(title) || suspiciousPattern.test(company)) {
    errors.push('Invalid characters detected');
  }
  
  return errors;
}

// Main function
functions.http('generateOpportunities', async (req, res) => {
  // Set CORS headers - restricted to helloeiko.com domains
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
  
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  
  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  
  try {
    // Get client IP for rate limiting
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.headers['x-real-ip'] || 
                     req.connection.remoteAddress || 
                     'unknown';
    
    // Check rate limit
    if (!rateLimiter.check(clientIp)) {
      console.log(`Rate limit exceeded for IP: ${clientIp}`);
      return res.status(429).json({ 
        success: false, 
        error: 'Too many requests. Please try again in a minute.' 
      });
    }
    
    console.log('Received request:', req.body);
    
    const { name, title, company } = req.body;
    
    // Validate input
    const validationErrors = validateInput(name, title, company);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: validationErrors.join('. ')
      });
    }
    
    // Trim inputs
    const cleanName = name.trim();
    const cleanTitle = title.trim();
    const cleanCompany = company.trim();
    
    // Generate opportunities using Claude
    const opportunities = await generateOpportunities(cleanName, cleanTitle, cleanCompany);
    
    // Log to Google Sheets (non-blocking)
    logToSheet({ 
      name: cleanName, 
      title: cleanTitle, 
      company: cleanCompany, 
      opportunities 
    }).catch(err => {
      console.error('Failed to log to sheets:', err);
      // Don't fail the request if logging fails
    });
    
    // Return response
    res.json({
      success: true,
      opportunities: opportunities
    });
    
  } catch (error) {
    console.error('Error:', error);
    
    // Don't expose internal error details to client
    const userMessage = error.message.includes('API') 
      ? 'Service temporarily unavailable. Please try again.' 
      : 'An error occurred. Please try again.';
    
    res.status(500).json({ 
      success: false, 
      error: userMessage
    });
  }
});

async function generateOpportunities(name, title, company) {
  const prompt = `You are researching AI opportunities for a SPECIFIC INDIVIDUAL at their company. 

CRITICAL: You must verify you're researching the CORRECT person at the CORRECT company. Do not confuse similar company names or people with similar names.

CONTACT INFORMATION:
- Name: ${name}
- Title: ${title}
- Company: ${company}

YOUR RESEARCH PROCESS:

STEP 1: FIND THE PERSON FIRST
- Search for "${name} LinkedIn" to find their LinkedIn profile
- Search for "${name} ${title}" to find information about this specific person
- Look for their professional profiles, company bio, articles, interviews, or news mentions
- VERIFY they actually work at ${company} - do not proceed if you can't confirm this

STEP 2: VERIFY THE COMPANY MATCH
- Once you find information about ${name}, verify it mentions ${company}
- Be careful: "${company}" might have similar names to other companies
- If you find ${name} at a DIFFERENT company, do NOT use that information
- Only use information where ${name} and ${company} appear together
- If you cannot verify ${name} works at ${company}, state this clearly in your research

STEP 3: RESEARCH ${name}'S ACTUAL ROLE
- What does ${name} specifically do at ${company}?
- What projects are they working on?
- What are their responsibilities?
- What is their sphere of influence?
- What challenges do they face in their role?

STEP 4: RESEARCH ${company} (THE RIGHT ONE)
- What does ${company} actually do? (industry, products, services)
- What is their business model?
- Where are they located?
- What scale are they operating at?

STEP 5: GENERATE OPPORTUNITIES
- Generate 3-6 AI opportunities specifically for ${name}'s actual role
- Base opportunities on what ${name} can realistically implement or champion
- Focus on THEIR specific challenges and responsibilities
- Do NOT suggest broad company-wide initiatives unless they're clearly in ${name}'s domain

RESPONSE FORMAT:

Return your response as a JSON object with this EXACT structure:
{
  "research": {
    "person": "Write a paragraph about ${name}. Include what you found about them, their actual role at ${company}, and their background. If you found they work at a DIFFERENT company or couldn't verify they work at ${company}, state that clearly. Include source URLs that specifically mention both ${name} AND ${company} together.",
    "role": "Write a paragraph about what ${name} does day-to-day as ${title} at ${company}. Base this on actual information you found about ${name}, not just generic responsibilities for the title. If you couldn't find specific information about ${name}, say so. Include source URLs.",
    "company": "Write a paragraph about ${company} (the company where ${name} works). Make sure this is the CORRECT ${company}, not a different company with a similar name. Include what they do, their industry, and relevant context. Include source URLs."
  },
  "opportunities": [
    {
      "title": "Opportunity title here (5-8 words)",
      "description": "Detailed description (2-3 sentences) of how this helps ${name} specifically in their actual role."
    }
  ]
}

CRITICAL VERIFICATION RULES:
- If you find information about "${name}" at a company OTHER than "${company}", DO NOT USE IT
- If you find a company with a similar name to "${company}" but it's a different business, DO NOT USE IT
- If you cannot verify ${name} works at ${company}, state this explicitly in the "person" section
- Only include source URLs that specifically mention BOTH ${name} AND ${company}
- If uncertain whether information is about the correct person/company, err on the side of saying "I could not verify..."

RESPONSE FORMATTING:
- Return ONLY valid JSON, no other text before or after
- No markdown formatting or backticks
- Just the raw JSON object starting with { and ending with }`;


  console.log('Sending request to Anthropic API...');
  
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });
  
  console.log('Received response from Anthropic API');
  
  const responseText = message.content[0].text;
  console.log('Raw response:', responseText);
  
  // Parse JSON response
  let opportunities;
  try {
    // Remove any markdown formatting if present
    const cleanedResponse = responseText
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    
    opportunities = JSON.parse(cleanedResponse);
    
    // Validate response structure
    if (!opportunities.research || !opportunities.opportunities) {
      throw new Error('Invalid response format - missing research or opportunities');
    }
    
    if (!Array.isArray(opportunities.opportunities) || opportunities.opportunities.length === 0) {
      throw new Error('Invalid response format - opportunities must be an array');
    }
    
    // Validate each opportunity has required fields
    for (const opp of opportunities.opportunities) {
      if (!opp.title || !opp.description) {
        throw new Error('Invalid opportunity format');
      }
    }
    
    // Validate research has required fields
    if (!opportunities.research.person || !opportunities.research.role || !opportunities.research.company) {
      throw new Error('Invalid research format');
    }
    
  } catch (parseError) {
    console.error('Failed to parse JSON:', parseError);
    console.error('Response text:', responseText);
    throw new Error('Failed to parse AI response');
  }
  
  return opportunities;
}

async function logToSheet(data) {
  try {
    const serviceAccountKey = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
    
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
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
    
    // Add row to sheet
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
    // Re-throw so caller can handle
    throw error;
  }
}
