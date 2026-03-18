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

// ─── State licensing board scrapers ──────────────────────────────────────────
// All state boards are public records — no API key required.
// Each scraper fails gracefully: timeouts and parse errors return [] not throws.
// States targeted: FL, CA, TX, NY, IL, OH, MA, CT, MD, TN, AZ, CO

/**
 * Generic HTTP GET helper. Returns { status, html } or { status: 0, html: '', error }.
 */
function httpGet(hostname, path, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VetMD-Sourcer/1.0; public records lookup)',
        'Accept': 'text/html,application/xhtml+xml',
        ...extraHeaders
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve({ status: res.statusCode, html: '', redirect: res.headers.location });
        return;
      }
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => resolve({ status: res.statusCode, html }));
    });
    req.on('error', e => resolve({ status: 0, html: '', error: e.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, html: '', error: 'timeout' });
    });
    req.end();
  });
}

/**
 * Extracts text from all <td> cells in each <tr> row of an HTML string.
 * Returns array of string arrays (one per row), skipping rows with no <td>.
 */
function extractTableRows(html) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (!/<td/i.test(rowHtml)) continue;
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#?\w+;/g, '').trim());
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Builds a candidate object from raw fields. */
function makeCandidate(name, city, stateAbbr, stateName, sourceLabel) {
  return {
    name,
    title: `Veterinarian (${stateAbbr} Licensed)`,
    location: city ? `${city}, ${stateName}` : stateName,
    experience: 'Unknown',
    source: `${sourceLabel} (Public Record)`,
    email: '',
    linkedinUrl: ''
  };
}

// ── Florida ───────────────────────────────────────────────────────────────────
// Source: https://www.myfloridalicense.com/wl11.asp  Board 0500 = Veterinary Medicine
async function scrapeFloridaDBPR() {
  const { status, html, error } = await httpGet(
    'www.myfloridalicense.com',
    '/wl11.asp?mode=0&brd=0500&typ=&lic=&nm=&cty=&zip=&cntry=0&con=&adr=&i=1'
  );
  if (error) { console.log(`   FL: ${error}`); return []; }
  console.log(`   FL DBPR: HTTP ${status}`);
  // Cols: 0=Name 1=License# 2=Type 3=Board 4=Status 5=Expiry 6=City
  return extractTableRows(html)
    .filter(c => c.length >= 5 && c[4].toLowerCase() === 'current' && c[0] && c[0].toLowerCase() !== 'name')
    .map(c => makeCandidate(c[0], c[6] || '', 'FL', 'Florida', 'Florida DBPR'))
    .slice(0, 20);
}

// ── California ────────────────────────────────────────────────────────────────
// Source: https://search.dca.ca.gov  BD=5700 = Veterinary Medical Board
async function scrapeCaliforniaDCA() {
  const { status, html, error } = await httpGet(
    'search.dca.ca.gov',
    '/?BD=5700&TP=&NUM=&NAME=&CITY=&ZIP=&CTZN=&ISUS='
  );
  if (error) { console.log(`   CA: ${error}`); return []; }
  console.log(`   CA DCA: HTTP ${status}`);
  // Cols: 0=Name 1=License# 2=LicType 3=Status 4=Expiry 5=City
  return extractTableRows(html)
    .filter(c => c.length >= 4 && /active|current/i.test(c[3]) && c[0] && !/^name$/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[5] || '', 'CA', 'California', 'California DCA'))
    .slice(0, 20);
}

// ── Texas ─────────────────────────────────────────────────────────────────────
// Source: https://www.txvmb.texas.gov  Texas Veterinary Medical Board
async function scrapeTexasTVMB() {
  const { status, html, error } = await httpGet(
    'www.txvmb.texas.gov',
    '/licensee-search/?search=1&first_name=&last_name=&license_number=&city=&license_status=Active'
  );
  if (error) { console.log(`   TX: ${error}`); return []; }
  console.log(`   TX TVMB: HTTP ${status}`);
  // Cols vary; look for Name + city pattern
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || c[2] || '', 'TX', 'Texas', 'Texas TVMB'))
    .slice(0, 20);
}

// ── New York ──────────────────────────────────────────────────────────────────
// Source: https://www.op.nysed.gov  Office of the Professions, profession 56 = Veterinarian
async function scrapeNewYorkNYSED() {
  const { status, html, error } = await httpGet(
    'www.op.nysed.gov',
    '/verification/?ptype=56&op_county=&search_last_name=&search_first_name=&btnSubmit=Search'
  );
  if (error) { console.log(`   NY: ${error}`); return []; }
  console.log(`   NY NYSED: HTTP ${status}`);
  // Cols: 0=Name 1=Profession 2=License# 3=Status 4=County
  return extractTableRows(html)
    .filter(c => c.length >= 3 && /licensed|active/i.test(c[3] || '') && c[0] && !/^name$/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[4] || '', 'NY', 'New York', 'NY NYSED'))
    .slice(0, 20);
}

// ── Illinois ──────────────────────────────────────────────────────────────────
// Source: https://www.idfpr.illinois.gov  IDFPR license lookup
async function scrapeIllinoisIDFPR() {
  const { status, html, error } = await httpGet(
    'www.idfpr.illinois.gov',
    '/LicenseLookup/LicenseLookup.asp?profession=039&action=search&license=&fname=&lname=&city=&county='
  );
  if (error) { console.log(`   IL: ${error}`); return []; }
  console.log(`   IL IDFPR: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[4] || c[3] || '', 'IL', 'Illinois', 'Illinois IDFPR'))
    .slice(0, 20);
}

// ── Ohio ──────────────────────────────────────────────────────────────────────
// Source: https://elicense.ohio.gov  Ohio eLicense, profession = Veterinarian
async function scrapeOhioELicense() {
  const { status, html, error } = await httpGet(
    'elicense.ohio.gov',
    '/lookup/r/_/#2'
  );
  if (error) { console.log(`   OH: ${error}`); return []; }
  console.log(`   OH eLicense: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'OH', 'Ohio', 'Ohio eLicense'))
    .slice(0, 20);
}

// ── Massachusetts ─────────────────────────────────────────────────────────────
// Source: https://checkahealthcareprovider.mass.gov  Board of Registration of Veterinarians
async function scrapeMassachusetts() {
  const { status, html, error } = await httpGet(
    'checkahealthcareprovider.mass.gov',
    '/ProfilePage.aspx?LicenseType=VET&TypeCode=VET&action=search'
  );
  if (error) { console.log(`   MA: ${error}`); return []; }
  console.log(`   MA Health Provider: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MA', 'Massachusetts', 'MA License Board'))
    .slice(0, 20);
}

// ── Connecticut ───────────────────────────────────────────────────────────────
// Source: https://www.elicense.ct.gov  CT eLicense portal
async function scrapeConnecticut() {
  const { status, html, error } = await httpGet(
    'www.elicense.ct.gov',
    '/Lookup/LicenseLookup.aspx?profession=VET&status=Active'
  );
  if (error) { console.log(`   CT: ${error}`); return []; }
  console.log(`   CT eLicense: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'CT', 'Connecticut', 'CT eLicense'))
    .slice(0, 20);
}

// ── Maryland ──────────────────────────────────────────────────────────────────
// Source: https://www.mdbop.org  Maryland Board of Physicians handles combined lookup
// Veterinary board is under MDA; direct search via MD imap portal
async function scrapeMaryland() {
  const { status, html, error } = await httpGet(
    'www.maryland.gov',
    '/Pages/service.aspx?ID=2588'
  );
  if (error) { console.log(`   MD: ${error}`); return []; }
  console.log(`   MD: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MD', 'Maryland', 'MD License Board'))
    .slice(0, 20);
}

// ── Tennessee ─────────────────────────────────────────────────────────────────
// Source: https://verify.tn.gov  Tennessee license verification portal
async function scrapeTennessee() {
  const { status, html, error } = await httpGet(
    'verify.tn.gov',
    '/LicenseDetail.aspx?board=VET&status=Active'
  );
  if (error) { console.log(`   TN: ${error}`); return []; }
  console.log(`   TN verify: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'TN', 'Tennessee', 'TN License Board'))
    .slice(0, 20);
}

// ── Arizona ───────────────────────────────────────────────────────────────────
// Source: https://veterinaryboard.az.gov  AZ State Veterinary Medical Examining Board
async function scrapeArizona() {
  const { status, html, error } = await httpGet(
    'veterinaryboard.az.gov',
    '/licensee-search/?status=active'
  );
  if (error) { console.log(`   AZ: ${error}`); return []; }
  console.log(`   AZ Vet Board: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'AZ', 'Arizona', 'AZ Vet Board'))
    .slice(0, 20);
}

// ── Colorado ──────────────────────────────────────────────────────────────────
// Source: https://apps.colorado.gov  DORA license lookup
async function scrapeColorado() {
  const { status, html, error } = await httpGet(
    'apps.colorado.gov',
    '/dora/licensing/Lookup/LicenseLookup.aspx?profession=VET&status=Active'
  );
  if (error) { console.log(`   CO: ${error}`); return []; }
  console.log(`   CO DORA: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'CO', 'Colorado', 'CO DORA'))
    .slice(0, 20);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
/**
 * Runs all state board scrapers in parallel. Each fails safely.
 * Targets the 12 states with active Thrive requisitions.
 */
async function fetchStateLicenseBoardCandidates() {
  const scrapers = [
    { label: 'Florida',       fn: scrapeFloridaDBPR    },
    { label: 'California',    fn: scrapeCaliforniaDCA  },
    { label: 'Texas',         fn: scrapeTexasTVMB      },
    { label: 'New York',      fn: scrapeNewYorkNYSED   },
    { label: 'Illinois',      fn: scrapeIllinoisIDFPR  },
    { label: 'Ohio',          fn: scrapeOhioELicense   },
    { label: 'Massachusetts', fn: scrapeMassachusetts  },
    { label: 'Connecticut',   fn: scrapeConnecticut    },
    { label: 'Maryland',      fn: scrapeMaryland       },
    { label: 'Tennessee',     fn: scrapeTennessee      },
    { label: 'Arizona',       fn: scrapeArizona        },
    { label: 'Colorado',      fn: scrapeColorado       },
  ];

  const results = await Promise.allSettled(scrapers.map(s => s.fn()));

  const allCandidates = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      console.log(`   ✓ ${scrapers[i].label}: ${result.value.length} licensees`);
      allCandidates.push(...result.value);
    } else if (result.status === 'rejected') {
      console.log(`   ✗ ${scrapers[i].label}: ${result.reason}`);
    }
    // 0-result states already logged inside their own scraper
  });

  return allCandidates;
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
