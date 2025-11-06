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

CONTACT INFORMATION:
- Name: ${name}
- Title: ${title}
- Company: ${company}

YOUR TASK:

PART 1: CONDUCT THOROUGH RESEARCH (Use web search for all of this)

Research ${name} specifically:
- Search for "${name} ${company}" to find information about this specific person
- Look for their LinkedIn profile, bio on company website, interviews, articles, mentions in news
- Find what THEY specifically work on, their projects, focus areas, responsibilities
- Identify their actual day-to-day activities and sphere of influence

Research ${company}:
- Understand the company's industry and business model
- Learn about their products, services, and market position
- Identify the company's scale, location, and key challenges

Research the role of "${title}" at ${company}:
- What does someone with this title typically do at a company like this?
- What are their likely responsibilities and pain points?
- What can they control or influence?

PART 2: DOCUMENT YOUR RESEARCH FINDINGS

Write 2-3 paragraphs summarizing your research:

Paragraph 1 - About ${name}:
Write a paragraph about who ${name} is, what you learned about them, their background, and their specific role at ${company}. Include the URLs of sources where you found this information.

Paragraph 2 - About ${name}'s Role & Responsibilities:
Write a paragraph about what ${name} likely does day-to-day in their role as ${title} at ${company}, what they're responsible for, what challenges they face, and what they can control or influence. Include URLs of sources.

Paragraph 3 - About ${company}:
Write a paragraph about what ${company} does, their industry, their products/services, their scale, and any relevant context about the company. Include URLs of sources.

PART 3: GENERATE 3-6 AI OPPORTUNITIES

Based on your research, generate 3-6 AI opportunities specifically tailored to ${name} and their actual responsibilities. Each opportunity should:
- Be something ${name} can actually implement or champion given their role
- Address specific challenges THEY face in their work
- Be relevant to their sphere of control and influence
- NOT be generic company-wide initiatives unless they clearly fall under this person's domain

For each opportunity, provide:
- A clear, specific title (5-8 words)
- A detailed description (2-3 sentences) explaining what the AI solution does and how it helps ${name} specifically

RESPONSE FORMAT:

Return your response as a JSON object with this EXACT structure:
{
  "research": {
    "person": "Paragraph about ${name} with their background and role. Include source URLs.",
    "role": "Paragraph about ${name}'s responsibilities and day-to-day work as ${title}. Include source URLs.",
    "company": "Paragraph about ${company} and what they do. Include source URLs."
  },
  "opportunities": [
    {
      "title": "Opportunity title here",
      "description": "Detailed description here."
    }
  ]
}

CRITICAL RULES:
- Use web search to find real information about ${name} and ${company}
- Include actual source URLs in your research paragraphs
- Make opportunities specific to what ${name} can actually do in their role
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
