require('dotenv').config();
const nodemailer = require('nodemailer');

/**
 * Sends the daily candidate report via Gmail.
 * Requires .env with EMAIL_FROM, EMAIL_APP_PASSWORD, and EMAIL_TO.
 *
 * @param {number} addedCount   - Number of new candidates found today
 * @param {number} totalCount   - Total candidates in the database
 * @param {Array}  newCandidates - Array of candidate objects added this run
 */
async function sendDailyReport(addedCount, totalCount, newCandidates) {
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

  const newRows = newCandidates.length > 0
    ? newCandidates.map(c =>
        `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.name}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.title}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.location}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.experience}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${c.source}</td>
        </tr>`
      ).join('')
    : '<tr><td colspan="5" style="padding:12px;color:#888;text-align:center">No new candidates found today.</td></tr>';

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:auto">
      <h2 style="color:#2c5f8a">Daily Candidate Report</h2>
      <p style="color:#555">${today}</p>

      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <tr style="background:#2c5f8a;color:#fff">
          <th style="padding:8px 12px;text-align:left">Name</th>
          <th style="padding:8px 12px;text-align:left">Title</th>
          <th style="padding:8px 12px;text-align:left">Location</th>
          <th style="padding:8px 12px;text-align:left">Experience</th>
          <th style="padding:8px 12px;text-align:left">Source</th>
        </tr>
        ${newRows}
      </table>

      <p style="margin-top:20px;color:#555">
        <strong>${addedCount}</strong> new candidate(s) added today &nbsp;|&nbsp;
        <strong>${totalCount}</strong> total in database
      </p>

      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="font-size:12px;color:#aaa">Sent by Medical Director Candidate Sourcer</p>
    </div>
  `;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    html
  });

  console.log(`📧 Daily report emailed to ${EMAIL_TO}`);
}

module.exports = { sendDailyReport };
