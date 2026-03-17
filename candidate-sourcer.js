require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');
const { sendDailyReport } = require('./mailer');

/**
 * Fetches candidates from Apollo.io People Search API.
 * Requires a paid Apollo plan. Returns null if not configured, [] on API failure.
 */
async function fetchApolloCandidates() {
  const apiKey = (process.env.APOLLO_API_KEY || '').trim();
  if (!apiKey || apiKey === 'your-apollo-api-key-here') return null;

  const body = JSON.stringify({
    titles: config.searchKeywords,
    person_locations: config.locations,
    per_page: 10
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.apollo.io',
      path: '/api/v1/mixed_people/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          console.log(`Apollo.io HTTP status: ${res.statusCode}`);
          const json = JSON.parse(data);
          if (json.error) {
            console.log('Apollo.io error:', json.error);
            resolve([]);
            return;
          }
          const people = json.people || [];
          const candidates = people.map(p => ({
            name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            title: p.title || 'Veterinarian',
            location: p.city ? `${p.city}${p.state ? ', ' + p.state : ''}` : (p.state || 'Unknown'),
            experience: 'Unknown',
            source: 'Apollo.io',
            email: p.email || '',
            linkedinUrl: p.linkedin_url || ''
          }));
          console.log(`✅ Apollo.io returned ${candidates.length} candidates.`);
          resolve(candidates);
        } catch (e) {
          console.log('⚠️  Apollo.io response parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.log('⚠️  Apollo.io request failed:', e.message);
      resolve([]);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Fetches candidates from People Data Labs Person Search API.
 * Free tier: 100 API calls/month. Sign up at https://www.peopledatalabs.com/
 * Returns null if not configured, [] on API failure.
 */
async function fetchPDLCandidates() {
  const apiKey = (process.env.PDL_API_KEY || '').trim();
  if (!apiKey || apiKey === 'your-pdl-api-key-here') return null;

  // PDL supports SQL-style queries against their person dataset
  const sqlQuery = `SELECT * FROM person
    WHERE job_title IN (
      'veterinary medical director',
      'dvm medical director',
      'veterinary clinical director',
      'veterinary chief of staff',
      'chief of staff'
    )
    AND location_country = 'united states'
    LIMIT 10`;

  const body = JSON.stringify({ sql: sqlQuery, size: 10, pretty: false });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.peopledatalabs.com',
      path: '/v5/person/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          console.log(`People Data Labs HTTP status: ${res.statusCode}`);
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            console.log('PDL error:', json.error || json.message || JSON.stringify(json));
            resolve([]);
            return;
          }
          const people = json.data || [];
          const candidates = people.map(p => ({
            name: p.full_name || 'Unknown',
            title: p.job_title || 'Veterinarian',
            location: p.location_locality
              ? `${p.location_locality}${p.location_region ? ', ' + p.location_region : ''}`
              : (p.location_region || 'Unknown'),
            experience: 'Unknown',
            source: 'People Data Labs',
            email: (p.emails && p.emails[0] && p.emails[0].address) || '',
            linkedinUrl: p.linkedin_url || ''
          }));
          console.log(`✅ People Data Labs returned ${candidates.length} candidates.`);
          resolve(candidates);
        } catch (e) {
          console.log('⚠️  PDL response parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.log('⚠️  PDL request failed:', e.message);
      resolve([]);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Scrapes public veterinary license data from state licensing boards.
 * No API key required — these are public government records.
 * Currently supports: Florida DBPR.
 */
async function fetchStateLicenseBoardCandidates() {
  const allCandidates = [];

  // Florida Department of Business and Professional Regulation (DBPR)
  // Veterinary Medicine board — public license lookup, no key needed
  try {
    console.log('   Querying Florida DBPR (Veterinary Medicine board)...');
    const flCandidates = await scrapeFloridaDBPR();
    if (flCandidates.length > 0) {
      console.log(`   Florida DBPR: found ${flCandidates.length} active licensees.`);
      allCandidates.push(...flCandidates);
    } else {
      console.log('   Florida DBPR: 0 results (site may have changed; check manually at myfloridalicense.com).');
    }
  } catch (e) {
    console.log('⚠️  Florida DBPR scrape failed:', e.message);
  }

  return allCandidates;
}

/**
 * Queries Florida DBPR public license lookup.
 * Board 0500 = Veterinary Medicine. Returns active licensees only.
 * Source URL: https://www.myfloridalicense.com/wl11.asp
 */
function scrapeFloridaDBPR() {
  // Search all license types on the Veterinary Medicine board, active licenses only
  const params = 'mode=0&brd=0500&typ=&lic=&nm=&cty=&zip=&cntry=0&con=&adr=&i=1';

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.myfloridalicense.com',
      path: `/wl11.asp?${params}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VetMD-Sourcer/1.0; public records lookup)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        console.log(`   Florida DBPR redirected to: ${res.headers.location}`);
        resolve([]);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          console.log(`   Florida DBPR HTTP status: ${res.statusCode}`);
          const candidates = parseFloridaDBPRHtml(data);
          resolve(candidates);
        } catch (e) {
          console.log('⚠️  Florida DBPR parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.log('⚠️  Florida DBPR request failed:', e.message);
      resolve([]);
    });
    req.setTimeout(15000, () => {
      console.log('⚠️  Florida DBPR request timed out.');
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

/**
 * Parses Florida DBPR HTML search results into candidate objects.
 * Extracts licensee name, city, and license status from the results table.
 * Only returns rows where status is "Current" (active license).
 */
function parseFloridaDBPRHtml(html) {
  const candidates = [];

  // DBPR results table rows — each <tr> holds one licensee
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let headerSkipped = false;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Skip rows without <td> cells (header rows use <th>)
    if (!/<td/i.test(rowHtml)) continue;
    if (!headerSkipped) { headerSkipped = true; continue; }

    // Extract all <td> cell text, stripping inner HTML tags
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, '')   // strip HTML tags
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, '')
        .trim();
      cells.push(text);
    }

    // Florida DBPR columns (typical order):
    // 0: Name, 1: License#, 2: License Type, 3: Board, 4: Status, 5: Expiry, 6: City/County
    if (cells.length < 5) continue;

    const name   = cells[0] || '';
    const status = cells[4] || '';
    const city   = cells[6] || '';

    // Only include currently active licensees; skip header artifacts
    if (!name || name.toLowerCase() === 'name') continue;
    if (status.toLowerCase() !== 'current') continue;

    candidates.push({
      name,
      title: 'Veterinarian (FL Licensed)',
      location: city ? `${city}, Florida` : 'Florida',
      experience: 'Unknown',
      source: 'Florida DBPR (Public Record)',
      email: '',
      linkedinUrl: ''
    });
  }

  // Cap per run to avoid flooding CSV on first run
  return candidates.slice(0, 20);
}

// ─── Main CandidateSourcer class ─────────────────────────────────────────────

class CandidateSourcer {
  constructor() {
    this.candidatesFile = path.join(__dirname, 'candidates.csv');
    this.candidates = [];
    this.loadCandidates();
  }

  loadCandidates() {
    if (fs.existsSync(this.candidatesFile)) {
      const data = fs.readFileSync(this.candidatesFile, 'utf8');
      const lines = data.split('\n');
      if (lines.length > 1) {
        this.candidates = lines.slice(1).filter(line => line.trim()).map(line => {
          const [name, title, location, experience, source, date, email, linkedinUrl] = line.split(',');
          return { name, title, location, experience, source, date, email: email || '', linkedinUrl: linkedinUrl || '' };
        });
      }
    }
  }

  addCandidate(candidate) {
    const newCandidate = {
      name: candidate.name || 'Unknown',
      title: candidate.title || 'Veterinarian',
      location: candidate.location || 'Unknown',
      experience: candidate.experience || 'Unknown',
      source: candidate.source || 'Unknown',
      date: new Date().toISOString().split('T')[0],
      email: candidate.email || '',
      linkedinUrl: candidate.linkedinUrl || ''
    };

    const exists = this.candidates.some(c =>
      c.name.toLowerCase() === newCandidate.name.toLowerCase() &&
      c.location.toLowerCase() === newCandidate.location.toLowerCase()
    );

    if (!exists) {
      this.candidates.push(newCandidate);
      this.saveCandidates();
      console.log(`✓ Added: ${newCandidate.name} — ${newCandidate.location}`);
      return true;
    }
    return false;
  }

  saveCandidates() {
    const header = 'Name,Title,Location,Experience,Source,Date Added,Email,LinkedIn URL\n';
    const rows = this.candidates.map(c =>
      `${c.name},${c.title},${c.location},${c.experience},${c.source},${c.date},${c.email || ''},${c.linkedinUrl || ''}`
    ).join('\n');
    fs.writeFileSync(this.candidatesFile, header + rows);
  }

  async sourceCandidates() {
    console.log('🔍 Starting candidate sourcing...');
    console.log(`📍 Targeting: ${config.searchKeywords.join(', ')}`);
    console.log('');

    const allResults = [];
    let apiSourceConfigured = false;

    // ── Source 1: Apollo.io ───────────────────────────────────────────────────
    const apolloCandidates = await fetchApolloCandidates();
    if (apolloCandidates === null) {
      console.log('⏭️  Apollo.io: not configured (set APOLLO_API_KEY in .env; requires paid plan)');
    } else {
      apiSourceConfigured = true;
      allResults.push(...apolloCandidates);
    }

    // ── Source 2: People Data Labs ────────────────────────────────────────────
    const pdlCandidates = await fetchPDLCandidates();
    if (pdlCandidates === null) {
      console.log('⏭️  People Data Labs: not configured (set PDL_API_KEY in .env; 100 free calls/month)');
    } else {
      apiSourceConfigured = true;
      allResults.push(...pdlCandidates);
    }

    // ── Source 3: State licensing boards (no key needed) ─────────────────────
    console.log('🏛️  Querying state veterinary licensing boards (public records)...');
    const stateCandidates = await fetchStateLicenseBoardCandidates();
    allResults.push(...stateCandidates);

    // ── No data at all ────────────────────────────────────────────────────────
    if (allResults.length === 0) {
      console.log('');
      console.log('━'.repeat(60));
      console.log('⚠️  NO CANDIDATES SOURCED — NO DATA SOURCES RETURNING RESULTS');
      console.log('━'.repeat(60));
      if (!apiSourceConfigured) {
        console.log('');
        console.log('To enable real candidate data, add at least one API key to .env:');
        console.log('');
        console.log('  PDL_API_KEY     — People Data Labs (free: 100 calls/month)');
        console.log('                    https://www.peopledatalabs.com/');
        console.log('');
        console.log('  APOLLO_API_KEY  — Apollo.io (paid plan required)');
        console.log('                    https://app.apollo.io/#/settings/integrations/api');
        console.log('');
        console.log('State licensing board scraping runs automatically but may return 0');
        console.log('results if the board website is unavailable or has changed its format.');
      }
      await sendDailyReport(0, this.candidates.length, [], this.candidates);
      return 0;
    }

    // ── Deduplicate across sources by name ────────────────────────────────────
    const seen = new Set();
    const uniqueResults = allResults.filter(c => {
      const key = c.name.toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const newCandidates = [];
    for (const candidate of uniqueResults) {
      if (this.addCandidate(candidate)) {
        newCandidates.push(candidate);
      }
    }

    console.log('');
    console.log(`✅ Sourcing complete. Added ${newCandidates.length} new candidates.`);
    console.log(`📊 Total in database: ${this.candidates.length}`);

    await sendDailyReport(newCandidates.length, this.candidates.length, newCandidates, this.candidates);
    return newCandidates.length;
  }

  generateReport() {
    console.log('\n📋 CANDIDATE REPORT');
    console.log('='.repeat(70));
    console.log(`Total Candidates in Database: ${this.candidates.length}`);
    console.log('='.repeat(70));

    if (this.candidates.length === 0) {
      console.log('No candidates in database yet.');
      return;
    }

    this.candidates.slice(-10).forEach((c, index) => {
      console.log(`\n${index + 1}. ${c.name}`);
      console.log(`   Title:      ${c.title}`);
      console.log(`   Location:   ${c.location}`);
      console.log(`   Experience: ${c.experience}`);
      console.log(`   Source:     ${c.source}`);
      console.log(`   Email:      ${c.email || 'N/A'}`);
      console.log(`   LinkedIn:   ${c.linkedinUrl || 'N/A'}`);
      console.log(`   Added:      ${c.date}`);
    });
  }
}

const sourcer = new CandidateSourcer();
sourcer.sourceCandidates().then(() => {
  sourcer.generateReport();
});

module.exports = CandidateSourcer;
