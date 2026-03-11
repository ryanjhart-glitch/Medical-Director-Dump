require('dotenv').config();
const nodemailer = require('nodemailer');

/**
 * Sends the daily candidate report via Gmail.
 * Requires .env with EMAIL_FROM, EMAIL_APP_PASSWORD, and EMAIL_TO.
 *
 * @param {number} addedCount    - Number of new candidates found today
 * @param {number} totalCount    - Total candidates in the database
 * @param {Array}  newCandidates - Candidates added this run (for NEW badge)
 * @param {Array}  allCandidates - Full candidate database (all rows)
 */
async function sendDailyReport(addedCount, totalCount, newCandidates, allCandidates = []) {
  const { EMAIL_FROM, EMAIL_APP_PASSWORD, EMAIL_TO, EMAIL_SUBJECT } = process.env;

  if (!EMAIL_FROM || !EMAIL_APP_PASSWORD || !EMAIL_TO) {
    console.log('⚠️  Email not configured — skipping notification. See .env.example to set up.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_FROM,
      pass: EMAIL_APP_PASSWORD
    }
  });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const subject = EMAIL_SUBJECT || `Vet Medical Director Candidates — ${today}`;

  // Build a lookup set of new candidate keys for fast badge check
  const newKeys = new Set(
    newCandidates.map(c => `${c.name.toLowerCase()}|${c.location.toLowerCase()}`)
  );

  // Sort: new candidates first, then existing sorted by date descending
  const displayList = allCandidates.length > 0
    ? [...allCandidates].sort((a, b) => {
        const aNew = newKeys.has(`${a.name.toLowerCase()}|${a.location.toLowerCase()}`);
        const bNew = newKeys.has(`${b.name.toLowerCase()}|${b.location.toLowerCase()}`);
        if (aNew && !bNew) return -1;
        if (!aNew && bNew) return 1;
        return (b.date || '').localeCompare(a.date || '');
      })
    : newCandidates;

  const rows = displayList.length > 0
    ? displayList.map(c => {
        const isNew = newKeys.has(`${c.name.toLowerCase()}|${c.location.toLowerCase()}`);
        const rowBg = isNew ? 'background:#f0faf0' : '';
        const nameBadge = isNew
          ? `${c.name} <span style="display:inline-block;background:#28a745;color:#fff;font-size:10px;font-weight:bold;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:middle">NEW</span>`
          : c.name;
        return `<tr style="${rowBg}">
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${nameBadge}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.title}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.location}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.experience}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.source}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.email ? `<a href="mailto:${c.email}">${c.email}</a>` : '—'}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.linkedinUrl ? `<a href="${c.linkedinUrl}" target="_blank">View Profile</a>` : '—'}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;white-space:nowrap">${c.date || '—'}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="8" style="padding:12px;color:#888;text-align:center">No candidates found.</td></tr>';

  const html = `
    <div style="font-family:sans-serif;max-width:860px;margin:auto">
      <h2 style="color:#2c5f8a">Daily Candidate Report</h2>
      <p style="color:#555">${today}</p>

      <p style="color:#555">
        <span style="display:inline-block;background:#28a745;color:#fff;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:10px;margin-right:6px">NEW</span>
        = added this run &nbsp;&nbsp;
        <strong>${addedCount}</strong> new today &nbsp;|&nbsp;
        <strong>${totalCount}</strong> total in database
      </p>

      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <tr style="background:#2c5f8a;color:#fff">
          <th style="padding:8px 12px;text-align:left">Name</th>
          <th style="padding:8px 12px;text-align:left">Title</th>
          <th style="padding:8px 12px;text-align:left">Location</th>
          <th style="padding:8px 12px;text-align:left">Experience</th>
          <th style="padding:8px 12px;text-align:left">Source</th>
          <th style="padding:8px 12px;text-align:left">Email</th>
          <th style="padding:8px 12px;text-align:left">LinkedIn</th>
          <th style="padding:8px 12px;text-align:left">Date Added</th>
        </tr>
        ${rows}
      </table>

      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="font-size:12px;color:#aaa">Sent by Medical Director Candidate Sourcer</p>
    </div>
  `;

  // Build CSV attachment from the full candidate list
  const csvHeader = 'Name,Title,Location,Experience,Source,Email,LinkedIn,Date Added';
  const csvRows = displayList.map(c =>
    [c.name, c.title, c.location, c.experience, c.source, c.email || '', c.linkedinUrl || '', c.date || '']
      .map(v => (String(v).includes(',') ? `"${v}"` : v))
      .join(',')
  );
  const csvContent = [csvHeader, ...csvRows].join('\r\n');

  const dateStamp = new Date().toISOString().slice(0, 10);

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    html,
    attachments: [
      {
        filename: `vet-md-candidates-${dateStamp}.csv`,
        content: csvContent,
        contentType: 'text/csv'
      }
    ]
  });

  console.log(`📧 Daily report emailed to ${EMAIL_TO}`);
}

module.exports = { sendDailyReport };
