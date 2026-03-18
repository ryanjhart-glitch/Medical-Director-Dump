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
    titles: [
      ...config.searchKeywords,
      'Equine Veterinarian', 'Equine Medical Director', 'Large Animal Veterinarian',
      'Relief Veterinarian', 'Locum Veterinarian', 'Veterinary Chief of Staff'
    ],
    person_locations: config.locations,
    per_page: 25
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
      'chief of staff',
      'equine veterinarian',
      'equine medical director',
      'large animal veterinarian',
      'relief veterinarian',
      'locum veterinarian',
      'locum tenens veterinarian',
      'per diem veterinarian',
      'veterinary practice owner',
      'associate veterinarian',
      'staff veterinarian'
    )
    AND location_country IN ('united states', 'canada')
    LIMIT 25`;

  const body = JSON.stringify({ sql: sqlQuery, size: 25, pretty: false });

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

// ─── NPI Registry (CMS) ──────────────────────────────────────────────────────
// The National Provider Identifier registry is a FREE public API from CMS.
// No API key required. Covers every US-licensed veterinarian.
// Taxonomy group 138F = Veterinarians (general, equine, large animal, etc.)
// Docs: https://npiregistry.cms.hhs.gov/search

/**
 * Generic HTTPS GET that parses and returns JSON. Returns null on any error.
 */
function httpGetJSON(hostname, path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VetMD-Sourcer/1.0)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Fetches veterinarians from the free CMS NPI Registry API.
 * Uses NPI taxonomy codes (138F group) — more precise than text search.
 *   138F00000X = Veterinarian (general)
 *   138F00002X = Equine
 *   138F00001X = Large Animal
 *   138F00005X = Small Animal
 * Returns up to 800 real, verified US vet records per run — no key needed.
 */
async function fetchNPIRegistryCandidates() {
  const searches = [
    { code: '138F00000X', label: 'general',      titleFallback: null },
    { code: '138F00005X', label: 'small animal',  titleFallback: 'Small Animal Veterinarian' },
    { code: '138F00002X', label: 'equine',        titleFallback: 'Equine Veterinarian' },
    { code: '138F00001X', label: 'large animal',  titleFallback: 'Large Animal Veterinarian' },
  ];

  const all = [];

  for (const { code, label, titleFallback } of searches) {
    const json = await httpGetJSON(
      'npiregistry.cms.hhs.gov',
      `/api/?version=2.1&taxonomy_code=${code}&enumeration_type=NPI-1&limit=200&skip=0`
    );

    if (!json) {
      console.log(`   NPI (${label}): request failed or timed out`);
      continue;
    }
    if (!Array.isArray(json.results)) {
      console.log(`   NPI (${label}): unexpected response — result_count=${json.result_count ?? 'N/A'}`);
      continue;
    }

    for (const p of json.results) {
      const basic   = p.basic || {};
      // Prefer practice location address; fall back to mailing
      const addr    = (p.addresses || []).find(a => a.address_purpose === 'LOCATION')
                   || (p.addresses || [])[0]
                   || {};
      const tax     = (p.taxonomies || []).find(t => t.primary)
                   || (p.taxonomies || [])[0]
                   || {};

      // Build full name — NPI stores first/last (individual) or org name
      let name;
      if (basic.organizational_name) {
        name = basic.organizational_name;
      } else {
        name = [basic.first_name, basic.middle_name, basic.last_name]
          .filter(Boolean).join(' ');
        if (basic.credential) name += `, ${basic.credential}`;
      }

      if (!name || !name.trim()) continue;

      all.push({
        name:        name.trim(),
        title:       titleFallback || tax.desc || 'Veterinarian',
        location:    addr.city
                       ? `${addr.city}, ${addr.state}`
                       : (addr.state || 'Unknown'),
        experience:  'Unknown',
        source:      'NPI Registry (CMS)',
        email:       '',
        linkedinUrl: ''
      });
    }

    console.log(`   NPI (${label}): ${json.result_count ?? '?'} total in registry / ${json.results.length} fetched`);
  }

  console.log(`✅ NPI Registry: ${all.length} veterinarians pulled.`);
  return all;
}

// ─── State licensing board scrapers ──────────────────────────────────────────
// All state boards are public records — no API key required.
// Each scraper fails gracefully: timeouts and parse errors return [] not throws.
// NOTE: State board sites vary widely. Scrapers marked (JS-heavy) will likely
// return 0 until their URL/POST body is tuned against the live site.
// The NPI Registry above is the reliable always-on replacement source.

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

/** Builds a candidate object from raw fields. titleOverride replaces default "Veterinarian (XX Licensed)". */
function makeCandidate(name, city, stateAbbr, stateName, sourceLabel, titleOverride) {
  return {
    name,
    title: titleOverride || `Veterinarian (${stateAbbr} Licensed)`,
    location: city ? `${city}, ${stateName}` : stateName,
    experience: 'Unknown',
    source: `${sourceLabel} (Public Record)`,
    email: '',
    linkedinUrl: ''
  };
}

/**
 * Generic HTTP POST helper for form-based board search pages.
 * postData can be a plain object (key/value) or a pre-encoded string.
 */
function httpPost(hostname, path, postData, extraHeaders = {}) {
  return new Promise((resolve) => {
    const body = typeof postData === 'string'
      ? postData
      : Object.entries(postData).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VetMD-Sourcer/1.0; public records lookup)',
        'Accept': 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
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
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, html: '', error: 'timeout' }); });
    req.write(body);
    req.end();
  });
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
// Source: https://vetboard.az.gov  AZ State Veterinary Medical Examining Board
// Public licensee directory — returns HTML table of active licensees.
async function scrapeArizona() {
  const { status, html, error } = await httpGet(
    'vetboard.az.gov',
    '/licensee-directory-1'
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

// ─── Additional US State Licensing Board Scrapers ─────────────────────────────

// ── Virginia ──────────────────────────────────────────────────────────────────
// Source: https://dhp.virginiainteractive.org  VA Dept of Health Professions
async function scrapeVirginia() {
  const { status, html, error } = await httpGet(
    'dhp.virginiainteractive.org',
    '/lookup/index?profession=VETM&firstname=&lastname=&city=&county=&licnum=&status=A'
  );
  if (error) { console.log(`   VA: ${error}`); return []; }
  console.log(`   VA DHP: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'VA', 'Virginia', 'VA DHP'))
    .slice(0, 20);
}

// ── North Carolina ────────────────────────────────────────────────────────────
// Source: https://portal.ncvmb.org  NC Veterinary Medical Board
async function scrapeNorthCarolina() {
  const { status, html, error } = await httpGet(
    'portal.ncvmb.org',
    '/verification/search.aspx?LicType=DVM&Status=A&LastName=&FirstName=&City='
  );
  if (error) { console.log(`   NC: ${error}`); return []; }
  console.log(`   NC VMB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'NC', 'North Carolina', 'NC VMB'))
    .slice(0, 20);
}

// ── Georgia ───────────────────────────────────────────────────────────────────
// Source: https://sos.georgia.gov  GA Secretary of State license lookup
async function scrapeGeorgia() {
  const { status, html, error } = await httpGet(
    'verify.sos.ga.gov',
    '/verification/Search.aspx?facility=N&board=VET&status=A&lname=&fname=&city='
  );
  if (error) { console.log(`   GA: ${error}`); return []; }
  console.log(`   GA SOS: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'GA', 'Georgia', 'GA SOS'))
    .slice(0, 20);
}

// ── Michigan ──────────────────────────────────────────────────────────────────
// Source: https://www.lara.michigan.gov  MI LARA license lookup
async function scrapeMichigan() {
  const { status, html, error } = await httpGet(
    'www.lara.michigan.gov',
    '/online-services/occupational-licensing/license-search/?profession=VETERINARIAN&status=ACTIVE&fname=&lname=&city='
  );
  if (error) { console.log(`   MI: ${error}`); return []; }
  console.log(`   MI LARA: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MI', 'Michigan', 'MI LARA'))
    .slice(0, 20);
}

// ── Pennsylvania ──────────────────────────────────────────────────────────────
// Source: https://www.pals.pa.gov  PA Licensing System
async function scrapePennsylvania() {
  const { status, html, error } = await httpGet(
    'www.pals.pa.gov',
    '/palssPublic/publicConsumer.do?action=ProfessionSelected&selectedBoardCode=VET&statusCode=A'
  );
  if (error) { console.log(`   PA: ${error}`); return []; }
  console.log(`   PA PALS: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'PA', 'Pennsylvania', 'PA PALS'))
    .slice(0, 20);
}

// ── Washington ────────────────────────────────────────────────────────────────
// Source: https://fortress.wa.gov  WA Dept of Health credential search
async function scrapeWashington() {
  const { status, html, error } = await httpGet(
    'fortress.wa.gov',
    '/doh/providercredentialsearch/ProviderCredentialSearch.aspx?ProfSession=VT&StCode=&LastName=&FirstName=&City=&CredentialType=&ActiveOnly=1'
  );
  if (error) { console.log(`   WA: ${error}`); return []; }
  console.log(`   WA DOH: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'WA', 'Washington', 'WA DOH'))
    .slice(0, 20);
}

// ── Oregon ────────────────────────────────────────────────────────────────────
// Source: https://olvr.oregon.gov  OR Veterinary Licensing Board
async function scrapeOregon() {
  const { status, html, error } = await httpGet(
    'olvr.oregon.gov',
    '/LicenseeSearch?profCode=VET&status=Active&lname=&fname=&city='
  );
  if (error) { console.log(`   OR: ${error}`); return []; }
  console.log(`   OR VLB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'OR', 'Oregon', 'OR VLB'))
    .slice(0, 20);
}

// ── Nevada ────────────────────────────────────────────────────────────────────
// Source: https://nvvetboard.us  Nevada Veterinary Medical Board
async function scrapeNevada() {
  const { status, html, error } = await httpGet(
    'nvvetboard.us',
    '/wp/licensees/?status=active&type=DVM&search='
  );
  if (error) { console.log(`   NV: ${error}`); return []; }
  console.log(`   NV VetBoard: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'NV', 'Nevada', 'NV Vet Board'))
    .slice(0, 20);
}

// ── Minnesota ─────────────────────────────────────────────────────────────────
// Source: https://mn.gov/amlps  MN Automated License Lookup
async function scrapeMinnesota() {
  const { status, html, error } = await httpGet(
    'mn.gov',
    '/amlps/licVerification.do?licType=VT&status=A&last=&first=&city='
  );
  if (error) { console.log(`   MN: ${error}`); return []; }
  console.log(`   MN AMLPS: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MN', 'Minnesota', 'MN AMLPS'))
    .slice(0, 20);
}

// ── Wisconsin ─────────────────────────────────────────────────────────────────
// Source: https://app.wi.gov/licensesearch  WI DSPS license search
async function scrapeWisconsin() {
  const { status, html, error } = await httpGet(
    'app.wi.gov',
    '/licensesearch/forwardList.do?profession=VET&licenseType=DVM&status=Active&lastName=&firstName=&city='
  );
  if (error) { console.log(`   WI: ${error}`); return []; }
  console.log(`   WI DSPS: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'WI', 'Wisconsin', 'WI DSPS'))
    .slice(0, 20);
}

// ── Indiana ───────────────────────────────────────────────────────────────────
// mylicense.in.gov returns the search FORM on GET — results require POST with
// ASP.NET ViewState. Disabled until POST body is captured from live browser.
async function scrapeIndiana() {
  // TODO: capture __VIEWSTATE and POST body from live browser session
  return [];
}

// ── Missouri ──────────────────────────────────────────────────────────────────
// Source: https://pr.mo.gov  MO Division of Professional Registration
async function scrapeMissouri() {
  const { status, html, error } = await httpGet(
    'pr.mo.gov',
    '/LicenseeSearch/LicenseeSearch.aspx?board=VET&status=Active&lname=&fname=&city='
  );
  if (error) { console.log(`   MO: ${error}`); return []; }
  console.log(`   MO DPR: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MO', 'Missouri', 'MO DPR'))
    .slice(0, 20);
}

// ── New Jersey ────────────────────────────────────────────────────────────────
// Source: https://www.njconsumeraffairs.gov  NJ Consumer Affairs - Veterinary Examiners
async function scrapeNewJersey() {
  const { status, html, error } = await httpGet(
    'www.njconsumeraffairs.gov',
    '/vme/Pages/Verify-a-License.aspx?profession=VET&status=ACTIVE&lname=&fname=&city='
  );
  if (error) { console.log(`   NJ: ${error}`); return []; }
  console.log(`   NJ DJCA: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'NJ', 'New Jersey', 'NJ DJCA'))
    .slice(0, 20);
}

// ── Oklahoma ──────────────────────────────────────────────────────────────────
// Source: https://ovmb.ok.gov  Oklahoma Veterinary Medical Board
async function scrapeOklahoma() {
  const { status, html, error } = await httpGet(
    'ovmb.ok.gov',
    '/Lookup/Index?type=DVM&status=Active&lname=&fname=&city='
  );
  if (error) { console.log(`   OK: ${error}`); return []; }
  console.log(`   OK VMB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'OK', 'Oklahoma', 'OK VMB'))
    .slice(0, 20);
}

// ── South Carolina ────────────────────────────────────────────────────────────
// Source: https://www.llronline.com  SC Labor Licensing and Regulation
async function scrapeSouthCarolina() {
  const { status, html, error } = await httpGet(
    'www.llronline.com',
    '/POL/vme/index.asp?action=Search&status=Active&lname=&fname=&city='
  );
  if (error) { console.log(`   SC: ${error}`); return []; }
  console.log(`   SC LLR: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'SC', 'South Carolina', 'SC LLR'))
    .slice(0, 20);
}

// ── Kentucky ──────────────────────────────────────────────────────────────────
// Source: https://kybovme.ky.gov  Kentucky Board of Veterinary Medicine
async function scrapeKentucky() {
  const { status, html, error } = await httpGet(
    'kybovme.ky.gov',
    '/Pages/licensee.aspx?status=Active&type=DVM&lname=&fname=&city='
  );
  if (error) { console.log(`   KY: ${error}`); return []; }
  console.log(`   KY BVME: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'KY', 'Kentucky', 'KY BVME'))
    .slice(0, 20);
}

// ── Louisiana ─────────────────────────────────────────────────────────────────
// Source: https://lsbvm.state.la.us  Louisiana State Board of Veterinary Medicine
async function scrapeLouisiana() {
  const { status, html, error } = await httpGet(
    'lsbvm.state.la.us',
    '/licensee_list.asp?status=Active&type=DVM'
  );
  if (error) { console.log(`   LA: ${error}`); return []; }
  console.log(`   LA SBVM: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'LA', 'Louisiana', 'LA SBVM'))
    .slice(0, 20);
}

// ── Iowa ──────────────────────────────────────────────────────────────────────
// Source: https://iowaveterinaryboard.gov  Iowa Veterinary Medical Board
async function scrapeIowa() {
  const { status, html, error } = await httpGet(
    'iowaveterinaryboard.gov',
    '/licensee/index.cfm?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   IA: ${error}`); return []; }
  console.log(`   IA VMB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'IA', 'Iowa', 'IA VMB'))
    .slice(0, 20);
}

// ── Kansas ────────────────────────────────────────────────────────────────────
// Source: https://www.ksvetboard.org  Kansas Veterinary Examiners Board
async function scrapeKansas() {
  const { status, html, error } = await httpGet(
    'www.ksvetboard.org',
    '/Licensees/LicenseeSearch?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   KS: ${error}`); return []; }
  console.log(`   KS VEB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'KS', 'Kansas', 'KS VEB'))
    .slice(0, 20);
}

// ── Alabama ───────────────────────────────────────────────────────────────────
// Source: https://www.albvme.org  Alabama Board of Veterinary Medical Examiners
async function scrapeAlabama() {
  const { status, html, error } = await httpGet(
    'www.albvme.org',
    '/licensees/?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   AL: ${error}`); return []; }
  console.log(`   AL BVME: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'AL', 'Alabama', 'AL BVME'))
    .slice(0, 20);
}

// ── Mississippi ───────────────────────────────────────────────────────────────
// Source: https://mvmb.ms.gov  Mississippi Veterinary Medical Board
async function scrapeMississippi() {
  const { status, html, error } = await httpGet(
    'mvmb.ms.gov',
    '/online-tools/verify-a-license/?type=DVM&status=Active&lname=&fname='
  );
  if (error) { console.log(`   MS: ${error}`); return []; }
  console.log(`   MS VMB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MS', 'Mississippi', 'MS VMB'))
    .slice(0, 20);
}

// ── Arkansas ──────────────────────────────────────────────────────────────────
// Source: https://www.asvmb.org  Arkansas State Veterinary Medical Board
async function scrapeArkansas() {
  const { status, html, error } = await httpGet(
    'www.asvmb.org',
    '/licensees/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   AR: ${error}`); return []; }
  console.log(`   AR SVMB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'AR', 'Arkansas', 'AR SVMB'))
    .slice(0, 20);
}

// ── Nebraska ──────────────────────────────────────────────────────────────────
// Source: https://www.nebraska.gov  NE DHHS license search
async function scrapeNebraska() {
  const { status, html, error } = await httpGet(
    'www.nebraska.gov',
    '/LISSearch/search.cgi?profession=VET&status=Active&lname=&fname='
  );
  if (error) { console.log(`   NE: ${error}`); return []; }
  console.log(`   NE DHHS: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'NE', 'Nebraska', 'NE DHHS'))
    .slice(0, 20);
}

// ── Idaho ─────────────────────────────────────────────────────────────────────
// Source: https://dopl.idaho.gov  ID Bureau of Occupational Licenses
async function scrapeIdaho() {
  const { status, html, error } = await httpGet(
    'dopl.idaho.gov',
    '/Lists/LicenseeSearch?board=IVET&status=Active&lname=&fname='
  );
  if (error) { console.log(`   ID: ${error}`); return []; }
  console.log(`   ID DOPL: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'ID', 'Idaho', 'ID DOPL'))
    .slice(0, 20);
}

// ── Utah ──────────────────────────────────────────────────────────────────────
// Source: https://secure.utah.gov  UT Division of Occupational and Professional Licensing
async function scrapeUtah() {
  const { status, html, error } = await httpGet(
    'secure.utah.gov',
    '/llv/llv!search.action?searchType=1&licenseType=PHYSICIAN&board=VET&status=ACTIVE&lname=&fname='
  );
  if (error) { console.log(`   UT: ${error}`); return []; }
  console.log(`   UT DOPL: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'UT', 'Utah', 'UT DOPL'))
    .slice(0, 20);
}

// ── New Mexico ────────────────────────────────────────────────────────────────
// Source: https://www.rld.nm.gov  NM Regulation and Licensing Department
async function scrapeNewMexico() {
  const { status, html, error } = await httpGet(
    'www.rld.nm.gov',
    '/boards-and-commissions/individual-boards-and-commissions/veterinary/licensee-search/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   NM: ${error}`); return []; }
  console.log(`   NM RLD: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'NM', 'New Mexico', 'NM RLD'))
    .slice(0, 20);
}

// ── Montana ───────────────────────────────────────────────────────────────────
// Source: https://boards.bsd.dli.mt.gov  MT Board of Veterinary Medicine
async function scrapeMontana() {
  const { status, html, error } = await httpGet(
    'boards.bsd.dli.mt.gov',
    '/vet/roster.asp?status=Active&lname=&fname='
  );
  if (error) { console.log(`   MT: ${error}`); return []; }
  console.log(`   MT BVME: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MT', 'Montana', 'MT BVME'))
    .slice(0, 20);
}

// ── North Dakota ──────────────────────────────────────────────────────────────
// Source: https://ndbovme.nd.gov  ND Board of Veterinary Medical Examiners
async function scrapeNorthDakota() {
  const { status, html, error } = await httpGet(
    'ndbovme.nd.gov',
    '/licensees/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   ND: ${error}`); return []; }
  console.log(`   ND BVME: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'ND', 'North Dakota', 'ND BVME'))
    .slice(0, 20);
}

// ── South Dakota ──────────────────────────────────────────────────────────────
// Source: https://www.sdvmb.com  SD Veterinary Medical Board
async function scrapeSouthDakota() {
  const { status, html, error } = await httpGet(
    'www.sdvmb.com',
    '/licensee-search/?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   SD: ${error}`); return []; }
  console.log(`   SD VMB: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'SD', 'South Dakota', 'SD VMB'))
    .slice(0, 20);
}

// ── West Virginia ─────────────────────────────────────────────────────────────
// Source: https://wvbovme.org  WV Board of Veterinary Medicine
async function scrapeWestVirginia() {
  const { status, html, error } = await httpGet(
    'wvbovme.org',
    '/licensees/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   WV: ${error}`); return []; }
  console.log(`   WV BVME: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'WV', 'West Virginia', 'WV BVME'))
    .slice(0, 20);
}

// ── Delaware ──────────────────────────────────────────────────────────────────
// Source: https://dpr.delaware.gov  DE Division of Professional Regulation
async function scrapeDelaware() {
  const { status, html, error } = await httpGet(
    'dpr.delaware.gov',
    '/boards/veterinarymedicine/index.shtml'
  );
  if (error) { console.log(`   DE: ${error}`); return []; }
  console.log(`   DE DPR: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'DE', 'Delaware', 'DE DPR'))
    .slice(0, 20);
}

// ── Vermont ───────────────────────────────────────────────────────────────────
// Source: https://www.sec.state.vt.us  VT Secretary of State license lookup
async function scrapeVermont() {
  const { status, html, error } = await httpGet(
    'www.sec.state.vt.us',
    '/professional-regulation/license-lookup/veterinarian/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   VT: ${error}`); return []; }
  console.log(`   VT SOS: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'VT', 'Vermont', 'VT SOS'))
    .slice(0, 20);
}

// ── New Hampshire ─────────────────────────────────────────────────────────────
// Source: https://www.vet.nh.gov  NH Board of Veterinary Medicine
async function scrapeNewHampshire() {
  const { status, html, error } = await httpGet(
    'www.vet.nh.gov',
    '/licensees/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   NH: ${error}`); return []; }
  console.log(`   NH BVM: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'NH', 'New Hampshire', 'NH BVM'))
    .slice(0, 20);
}

// ── Maine ─────────────────────────────────────────────────────────────────────
// Source: https://www.maine.gov  ME Professional & Financial Regulation
async function scrapeMaine() {
  const { status, html, error } = await httpGet(
    'www.maine.gov',
    '/pfr/professionallicensing/professions/veterinarians/veterinarylist.htm'
  );
  if (error) { console.log(`   ME: ${error}`); return []; }
  console.log(`   ME PFR: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'ME', 'Maine', 'ME PFR'))
    .slice(0, 20);
}

// ── Alaska ────────────────────────────────────────────────────────────────────
// Source: https://www.commerce.alaska.gov  AK Div of Corporations, Business & Professional Licensing
async function scrapeAlaska() {
  const { status, html, error } = await httpGet(
    'www.commerce.alaska.gov',
    '/cbp/main/Search/Professional?q=&professionCode=VETERINARIAN&status=Active'
  );
  if (error) { console.log(`   AK: ${error}`); return []; }
  console.log(`   AK DCBPL: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'AK', 'Alaska', 'AK DCBPL'))
    .slice(0, 20);
}

// ── Hawaii ────────────────────────────────────────────────────────────────────
// Source: https://pvl.ehawaii.gov  HI Professional and Vocational Licensing
async function scrapeHawaii() {
  const { status, html, error } = await httpGet(
    'pvl.ehawaii.gov',
    '/pvlsearch/app/?profession=VET&status=ACTIVE&lname=&fname='
  );
  if (error) { console.log(`   HI: ${error}`); return []; }
  console.log(`   HI PVL: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'HI', 'Hawaii', 'HI PVL'))
    .slice(0, 20);
}

// ── Rhode Island ──────────────────────────────────────────────────────────────
// Source: https://health.ri.gov  RI Dept of Health license verification
async function scrapeRhodeIsland() {
  const { status, html, error } = await httpGet(
    'health.ri.gov',
    '/licenses/veterinary/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   RI: ${error}`); return []; }
  console.log(`   RI DOH: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'RI', 'Rhode Island', 'RI DOH'))
    .slice(0, 20);
}

// ── Wyoming ───────────────────────────────────────────────────────────────────
// Source: https://www.wyomingboard.us  WY State Board of Veterinary Medicine
async function scrapeWyoming() {
  const { status, html, error } = await httpGet(
    'www.wyomingboard.us',
    '/veterinary/licensees/?status=Active&lname=&fname='
  );
  if (error) { console.log(`   WY: ${error}`); return []; }
  console.log(`   WY SBVM: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|licensee)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'WY', 'Wyoming', 'WY SBVM'))
    .slice(0, 20);
}

// ─── Canadian Provincial Licensing Board Scrapers ─────────────────────────────
// Public regulatory registers — no API key required.

// ── Alberta ───────────────────────────────────────────────────────────────────
// Source: https://www.abvma.ca  Alberta Veterinary Medical Association
async function scrapeAlbertaABVMA() {
  const { status, html, error } = await httpGet(
    'www.abvma.ca',
    '/site/rosterdirectory?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   AB: ${error}`); return []; }
  console.log(`   AB ABVMA: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|registrant)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'AB', 'Alberta, Canada', 'ABVMA'))
    .slice(0, 20);
}

// ── British Columbia ──────────────────────────────────────────────────────────
// Source: https://www.cvbc.ca  College of Veterinarians of British Columbia
async function scrapeBritishColumbiaCVBC() {
  const { status, html, error } = await httpGet(
    'www.cvbc.ca',
    '/online-registry/?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   BC: ${error}`); return []; }
  console.log(`   BC CVBC: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|registrant)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'BC', 'British Columbia, Canada', 'CVBC'))
    .slice(0, 20);
}

// ── Ontario ───────────────────────────────────────────────────────────────────
// Source: https://cvo.org  College of Veterinarians of Ontario (~4,500 registrants)
async function scrapeOntarioCVO() {
  const { status, html, error } = await httpGet(
    'cvo.ca.thentiacloud.net',
    '/webs/cvo/register/?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   ON: ${error}`); return []; }
  console.log(`   ON CVO: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|registrant)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'ON', 'Ontario, Canada', 'CVO Ontario'))
    .slice(0, 20);
}

// ── Manitoba ──────────────────────────────────────────────────────────────────
// Source: https://www.mvma.ca  Manitoba Veterinary Medical Association
async function scrapeManitobaMVMA() {
  const { status, html, error } = await httpGet(
    'www.mvma.ca',
    '/directory/?status=Active&type=DVM&lname=&fname='
  );
  if (error) { console.log(`   MB: ${error}`); return []; }
  console.log(`   MB MVMA: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|registrant)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'MB', 'Manitoba, Canada', 'MB MVMA'))
    .slice(0, 20);
}

// ── Saskatchewan ─────────────────────────────────────────────────────────────
// Source: https://www.svma.sk.ca  Saskatchewan Veterinary Medical Association
async function scrapeSaskatchewanSVMA() {
  const { status, html, error } = await httpGet(
    'www.svma.sk.ca',
    '/members/member-directory/?status=Active'
  );
  if (error) { console.log(`   SK: ${error}`); return []; }
  console.log(`   SK SVMA: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 3 && c[0] && !/^(name|registrant)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[3] || '', 'SK', 'Saskatchewan, Canada', 'SK SVMA'))
    .slice(0, 20);
}

// ─── US State VMA "Find a Vet" Directory Scrapers ─────────────────────────────
// Professional association member directories — public, no login required.
// These surface practicing DVMs including Medical Directors and specialists.

// ── Florida FVMA ──────────────────────────────────────────────────────────────
// Source: https://members.fvma.org  FVMA "Find a Vet" member directory
async function scrapeFVMAFlorida() {
  const { status, html, error } = await httpGet(
    'members.fvma.org',
    '/directory/findvet/personresults.html'
  );
  if (error) { console.log(`   FVMA FL: ${error}`); return []; }
  console.log(`   FVMA Florida: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'FL', 'Florida', 'FVMA Directory', 'Veterinarian (FVMA Member)'))
    .slice(0, 20);
}

// ── Georgia GVMA ─────────────────────────────────────────────────────────────
// Source: https://gvma.net  GVMA "Find a Vet / Find a Specialist"
async function scrapeGVMAGeorgia() {
  const { status, html, error } = await httpGet(
    'gvma.net',
    '/directory-search/?type=member&specialty=&city=&state=GA'
  );
  if (error) { console.log(`   GVMA GA: ${error}`); return []; }
  console.log(`   GVMA Georgia: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'GA', 'Georgia', 'GVMA Directory', 'Veterinarian (GVMA Member)'))
    .slice(0, 20);
}

// ── Massachusetts MVMA ────────────────────────────────────────────────────────
// Source: https://www.massvet.org  MVMA "Find a Veterinarian" directory
async function scrapeMVMAMassachusetts() {
  const { status, html, error } = await httpGet(
    'www.massvet.org',
    '/find-a-veterinarian-directory?type=&service=&city=&state=MA'
  );
  if (error) { console.log(`   MVMA MA: ${error}`); return []; }
  console.log(`   MVMA Massachusetts: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'MA', 'Massachusetts', 'MVMA Directory', 'Veterinarian (MVMA Member)'))
    .slice(0, 20);
}

// ── Minnesota MVMA ────────────────────────────────────────────────────────────
// Source: https://www.mvma.org  MVMA member directory
async function scrapeMVMAMinnesota() {
  const { status, html, error } = await httpGet(
    'www.mvma.org',
    '/directory/?type=member&city=&state=MN'
  );
  if (error) { console.log(`   MVMA MN: ${error}`); return []; }
  console.log(`   MVMA Minnesota: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'MN', 'Minnesota', 'MVMA-MN Directory', 'Veterinarian (MVMA-MN Member)'))
    .slice(0, 20);
}

// ── Washington WSVMA ──────────────────────────────────────────────────────────
// Source: https://mycommunity.wsvma.org  WSVMA member search
async function scrapeWSVMAWashington() {
  const { status, html, error } = await httpGet(
    'mycommunity.wsvma.org',
    '/search/?type=member&city=&state=WA'
  );
  if (error) { console.log(`   WSVMA WA: ${error}`); return []; }
  console.log(`   WSVMA Washington: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'WA', 'Washington', 'WSVMA Directory', 'Veterinarian (WSVMA Member)'))
    .slice(0, 20);
}

// ── California CVMA ───────────────────────────────────────────────────────────
// Source: https://cvma.net  CVMA "Find a Veterinarian"
async function scrapeCVMACalifornia() {
  const { status, html, error } = await httpGet(
    'cvma.net',
    '/find-a-veterinarian/?city=&state=CA&specialty='
  );
  if (error) { console.log(`   CVMA CA: ${error}`); return []; }
  console.log(`   CVMA California: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'CA', 'California', 'CVMA Directory', 'Veterinarian (CVMA Member)'))
    .slice(0, 20);
}

// ── Texas TVMA ────────────────────────────────────────────────────────────────
// Source: https://www.tvma.org  TVMA member directory
async function scrapeTVMATexas() {
  const { status, html, error } = await httpGet(
    'www.tvma.org',
    '/find-a-vet/?city=&state=TX&specialty='
  );
  if (error) { console.log(`   TVMA TX: ${error}`); return []; }
  console.log(`   TVMA Texas: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'TX', 'Texas', 'TVMA Directory', 'Veterinarian (TVMA Member)'))
    .slice(0, 20);
}

// ── New Hampshire NHVMA ───────────────────────────────────────────────────────
// Source: https://www.nhvma.com  NHVMA hospital and specialty directory
async function scrapeNHVMA() {
  const { status, html, error } = await httpGet(
    'www.nhvma.com',
    '/find-a-vet'
  );
  if (error) { console.log(`   NHVMA NH: ${error}`); return []; }
  console.log(`   NHVMA New Hampshire: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'NH', 'New Hampshire', 'NHVMA Directory', 'Veterinarian (NHVMA Member)'))
    .slice(0, 20);
}

// ─── Equine Specialty Scrapers ─────────────────────────────────────────────────
// AAEP = American Association of Equine Practitioners (~10,000 members)
// Public "Find a Vet" directory for horse owners seeking equine DVMs.

// ── AAEP Find a Veterinarian ──────────────────────────────────────────────────
async function scrapeAAEPEquine() {
  const { status, html, error } = await httpGet(
    'www.aaep.org',
    '/find-a-veterinarian?location=&specialty=&distance=100'
  );
  if (error) { console.log(`   AAEP: ${error}`); return []; }
  console.log(`   AAEP Equine: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || c[1] || '', 'US', 'United States', 'AAEP Directory', 'Equine Veterinarian (AAEP Member)'))
    .slice(0, 25);
}

// ─── Relief / Locum Vet Scrapers ──────────────────────────────────────────────
// ReliefVets.com is the largest public relief vet marketplace.
// Their "Find Relief Vets" public directory lists available relief DVMs by state.

async function scrapeReliefVets() {
  const { status, html, error } = await httpGet(
    'www.reliefvets.com',
    '/find-relief-vets?specialty=&state=&distance='
  );
  if (error) { console.log(`   ReliefVets: ${error}`); return []; }
  console.log(`   ReliefVets.com: HTTP ${status}`);
  return extractTableRows(html)
    .filter(c => c.length >= 2 && c[0] && !/^(name|doctor)/i.test(c[0]))
    .map(c => makeCandidate(c[0], c[2] || '', 'US', 'United States', 'ReliefVets.com', 'Relief Veterinarian'))
    .slice(0, 25);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
/**
 * Runs all state board scrapers in parallel. Each fails safely.
 * Covers all 50 US states.
 */
async function fetchStateLicenseBoardCandidates() {
  const scrapers = [
    { label: 'Florida',        fn: scrapeFloridaDBPR     },
    { label: 'California',     fn: scrapeCaliforniaDCA   },
    { label: 'Texas',          fn: scrapeTexasTVMB       },
    { label: 'New York',       fn: scrapeNewYorkNYSED    },
    { label: 'Illinois',       fn: scrapeIllinoisIDFPR   },
    { label: 'Ohio',           fn: scrapeOhioELicense    },
    { label: 'Massachusetts',  fn: scrapeMassachusetts   },
    { label: 'Connecticut',    fn: scrapeConnecticut     },
    { label: 'Maryland',       fn: scrapeMaryland        },
    { label: 'Tennessee',      fn: scrapeTennessee       },
    { label: 'Arizona',        fn: scrapeArizona         },
    { label: 'Colorado',       fn: scrapeColorado        },
    // New states
    { label: 'Virginia',       fn: scrapeVirginia        },
    { label: 'North Carolina', fn: scrapeNorthCarolina   },
    { label: 'Georgia',        fn: scrapeGeorgia         },
    { label: 'Michigan',       fn: scrapeMichigan        },
    { label: 'Pennsylvania',   fn: scrapePennsylvania    },
    { label: 'Washington',     fn: scrapeWashington      },
    { label: 'Oregon',         fn: scrapeOregon          },
    { label: 'Nevada',         fn: scrapeNevada          },
    { label: 'Minnesota',      fn: scrapeMinnesota       },
    { label: 'Wisconsin',      fn: scrapeWisconsin       },
    { label: 'Indiana',        fn: scrapeIndiana         },
    { label: 'Missouri',       fn: scrapeMissouri        },
    { label: 'New Jersey',     fn: scrapeNewJersey       },
    { label: 'Oklahoma',       fn: scrapeOklahoma        },
    { label: 'South Carolina', fn: scrapeSouthCarolina   },
    { label: 'Kentucky',       fn: scrapeKentucky        },
    { label: 'Louisiana',      fn: scrapeLouisiana       },
    { label: 'Iowa',           fn: scrapeIowa            },
    { label: 'Kansas',         fn: scrapeKansas          },
    { label: 'Alabama',        fn: scrapeAlabama         },
    { label: 'Mississippi',    fn: scrapeMississippi     },
    { label: 'Arkansas',       fn: scrapeArkansas        },
    { label: 'Nebraska',       fn: scrapeNebraska        },
    { label: 'Idaho',          fn: scrapeIdaho           },
    { label: 'Utah',           fn: scrapeUtah            },
    { label: 'New Mexico',     fn: scrapeNewMexico       },
    { label: 'Montana',        fn: scrapeMontana         },
    { label: 'North Dakota',   fn: scrapeNorthDakota     },
    { label: 'South Dakota',   fn: scrapeSouthDakota     },
    { label: 'West Virginia',  fn: scrapeWestVirginia    },
    { label: 'Delaware',       fn: scrapeDelaware        },
    { label: 'Vermont',        fn: scrapeVermont         },
    { label: 'New Hampshire',  fn: scrapeNewHampshire    },
    { label: 'Maine',          fn: scrapeMaine           },
    { label: 'Alaska',         fn: scrapeAlaska          },
    { label: 'Hawaii',         fn: scrapeHawaii          },
    { label: 'Rhode Island',   fn: scrapeRhodeIsland     },
    { label: 'Wyoming',        fn: scrapeWyoming         },
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
  });

  return allCandidates;
}

/**
 * Runs all Canadian provincial regulatory board scrapers in parallel.
 */
async function fetchCanadianBoardCandidates() {
  const scrapers = [
    { label: 'Alberta (ABVMA)',          fn: scrapeAlbertaABVMA        },
    { label: 'British Columbia (CVBC)',   fn: scrapeBritishColumbiaCVBC },
    { label: 'Ontario (CVO)',             fn: scrapeOntarioCVO          },
    { label: 'Manitoba (MVMA)',           fn: scrapeManitobaMVMA        },
    { label: 'Saskatchewan (SVMA)',       fn: scrapeSaskatchewanSVMA    },
  ];

  const results = await Promise.allSettled(scrapers.map(s => s.fn()));
  const allCandidates = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      console.log(`   ✓ ${scrapers[i].label}: ${result.value.length} registrants`);
      allCandidates.push(...result.value);
    } else if (result.status === 'rejected') {
      console.log(`   ✗ ${scrapers[i].label}: ${result.reason}`);
    }
  });
  return allCandidates;
}

/**
 * Runs all state VMA "Find a Vet" directory scrapers in parallel.
 */
async function fetchVMADirectoryCandidates() {
  const scrapers = [
    { label: 'FL FVMA',    fn: scrapeFVMAFlorida       },
    { label: 'GA GVMA',    fn: scrapeGVMAGeorgia       },
    { label: 'MA MVMA',    fn: scrapeMVMAMassachusetts  },
    { label: 'MN MVMA',    fn: scrapeMVMAMinnesota      },
    { label: 'WA WSVMA',   fn: scrapeWSVMAWashington   },
    { label: 'CA CVMA',    fn: scrapeCVMACalifornia     },
    { label: 'TX TVMA',    fn: scrapeTVMATexas          },
    { label: 'NH NHVMA',   fn: scrapeNHVMA              },
  ];

  const results = await Promise.allSettled(scrapers.map(s => s.fn()));
  const allCandidates = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      console.log(`   ✓ ${scrapers[i].label}: ${result.value.length} members`);
      allCandidates.push(...result.value);
    } else if (result.status === 'rejected') {
      console.log(`   ✗ ${scrapers[i].label}: ${result.reason}`);
    }
  });
  return allCandidates;
}

/**
 * Runs equine and relief/locum specialty scrapers in parallel.
 */
async function fetchSpecialtyCandidates() {
  const scrapers = [
    { label: 'AAEP Equine Directory',  fn: scrapeAAEPEquine  },
    { label: 'ReliefVets.com',         fn: scrapeReliefVets  },
  ];

  const results = await Promise.allSettled(scrapers.map(s => s.fn()));
  const allCandidates = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      console.log(`   ✓ ${scrapers[i].label}: ${result.value.length} candidates`);
      allCandidates.push(...result.value);
    } else if (result.status === 'rejected') {
      console.log(`   ✗ ${scrapers[i].label}: ${result.reason}`);
    }
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

    // ── Name sanity guard ───────────────────────────────────────────────────
    // Reject HTML form artifacts that some board scrapers pick up as rows:
    // form field labels ("Profession:", "License Type:"), dropdown option lists
    // ("AA AE AK AL..."), pure numbers, and single-character strings.
    const n = newCandidate.name;
    if (
      n === 'Unknown'                               ||  // no name at all
      n.endsWith(':')                               ||  // form label: "Profession:"
      n.length < 4                                  ||  // too short
      /^\d+$/.test(n)                               ||  // pure number
      /^([A-Z]{2}\s+){3,}/.test(n)                 ||  // state abbr list "AA AE AK AL..."
      /^(--All--|--Select|-+$)/i.test(n)            ||  // dropdown placeholder
      /^(profession|license|status|doing business|name|type|number|city|state|zip|county|country)/i.test(n)
    ) {
      return false;
    }

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

    // ── Source 1: NPI Registry (FREE — no key, always runs) ──────────────────
    // CMS National Provider Identifier registry — every licensed US veterinarian.
    // Returns real names, cities, states, specialties. Up to 600 records/run.
    console.log('🏥  Querying NPI Registry (CMS) — free, no key required...');
    const npiCandidates = await fetchNPIRegistryCandidates();
    allResults.push(...npiCandidates);

    // ── Source 2: Apollo.io ───────────────────────────────────────────────────
    const apolloCandidates = await fetchApolloCandidates();
    if (apolloCandidates === null) {
      console.log('⏭️  Apollo.io: not configured (set APOLLO_API_KEY in .env; requires paid plan)');
    } else {
      apiSourceConfigured = true;
      allResults.push(...apolloCandidates);
    }

    // ── Source 3: People Data Labs ────────────────────────────────────────────
    const pdlCandidates = await fetchPDLCandidates();
    if (pdlCandidates === null) {
      console.log('⏭️  People Data Labs: not configured (set PDL_API_KEY in .env; 100 free calls/month)');
    } else {
      apiSourceConfigured = true;
      allResults.push(...pdlCandidates);
    }

    // ── Source 4: US State licensing boards — all 50 states (no key needed) ──
    console.log('🏛️  Querying US state veterinary licensing boards (all 50 states)...');
    const stateCandidates = await fetchStateLicenseBoardCandidates();
    allResults.push(...stateCandidates);

    // ── Source 5: Canadian provincial regulatory boards ───────────────────────
    console.log('🍁  Querying Canadian provincial veterinary regulatory boards...');
    const canadianCandidates = await fetchCanadianBoardCandidates();
    allResults.push(...canadianCandidates);

    // ── Source 6: US state VMA "Find a Vet" member directories ───────────────
    console.log('🐾  Querying state VMA association directories...');
    const vmaCandidates = await fetchVMADirectoryCandidates();
    allResults.push(...vmaCandidates);

    // ── Source 7: Equine (AAEP) + Relief/Locum specialty directories ─────────
    console.log('🐴  Querying equine and relief/locum specialty directories...');
    const specialtyCandidates = await fetchSpecialtyCandidates();
    allResults.push(...specialtyCandidates);

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
