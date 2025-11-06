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
  const prompt = `You are researching AI opportunities for a SPECIFIC INDIVIDUAL at their company. Your goal is to find opportunities tailored to what THIS PERSON actually does in their role, not generic company-wide opportunities.

CONTACT INFORMATION:
- Name: ${name}
- Title: ${title}
- Company: ${company}

YOUR RESEARCH PROCESS:

STEP 1: Research ${name} specifically
- Search for "${name} ${company}" to find information about this specific person
- Look for their LinkedIn profile, bio on company website, interviews, articles they've written, or mentions in news
- Identify what THEY specifically work on, their projects, their focus areas, their responsibilities
- Find out their actual day-to-day activities if possible

STEP 2: Research ${company} contextually
- Understand the company's industry and business model
- Learn about their products, services, and market position
- Identify how someone with the title "${title}" would typically operate in this type of company

STEP 3: Understand ${name}'s sphere of influence
- What decisions can someone in their role make?
- What processes do they control or influence?
- What teams or functions do they oversee?
- What are the specific pain points THEY face (not the whole company)?

STEP 4: Generate 3-6 AI opportunities specifically for ${name}
- Focus on what ${name} can actually implement or champion given their role
- Address the specific challenges THEY face in their day-to-day work
- Make opportunities relevant to their sphere of control and influence
- DO NOT suggest broad company-wide initiatives unless they clearly fall under this person's responsibilities

For each opportunity, provide:
- A clear, specific title (5-8 words)
- A detailed description (2-3 sentences) explaining:
  * What AI solution would help ${name} specifically
  * How it addresses a challenge in THEIR role
  * The benefit to THEIR work (not just the company overall)

CRITICAL RULES:
- Opportunities must be relevant to ${name}'s actual role and responsibilities
- Avoid generic company-wide suggestions unless they're clearly this person's domain
- Base suggestions on what you learned about ${name} specifically, not just typical responsibilities for their title
- If you can't find specific information about ${name}, focus deeply on what someone with title "${title}" at a company like ${company} would realistically handle

Return your response as a JSON array with this structure:
[
  {
    "title": "Opportunity title here",
    "description": "Detailed description here."
  }
]

CRITICAL FORMATTING RULES: 
- Return ONLY valid JSON array, no other text before or after
- No markdown formatting
- No backticks
- No explanatory text
- Just the raw JSON array starting with [ and ending with ]`;

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
    if (!Array.isArray(opportunities) || opportunities.length === 0) {
      throw new Error('Invalid response format');
    }
    
    // Validate each opportunity has required fields
    for (const opp of opportunities) {
      if (!opp.title || !opp.description) {
        throw new Error('Invalid opportunity format');
      }
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
    const opportunitiesText = data.opportunities
      .map((opp, idx) => `${idx + 1}. ${opp.title}: ${opp.description}`)
      .join('\n\n');
    
    // Add row to sheet
    await sheet.addRow({
      Timestamp: new Date().toISOString(),
      Name: data.name,
      Title: data.title,
      Company: data.company,
      Opportunities: opportunitiesText
    });
    
    console.log('Successfully logged to Google Sheets');
  } catch (error) {
    console.error('Error logging to Google Sheets:', error);
    // Re-throw so caller can handle
    throw error;
  }
}
