# Veterinarian Medical Director Candidate Sourcer

Automated daily tool that sources Veterinarian Medical Director candidates and emails you a report each morning.

---

## What It Does

- Searches for Veterinarian / DVM Medical Director candidates across configured job boards
- Deduplicates against previously found candidates
- Saves all candidates to `candidates.csv`
- Emails you an HTML report of new candidates found each day

---

## One-Time Setup (Windows Desktop)

### 1. Install Node.js
Download and install from [nodejs.org](https://nodejs.org) (LTS version recommended).

### 2. Clone the repo to your Desktop
Open Command Prompt and run:
```
git clone https://github.com/ryanjhart-glitch/Medical-Director-Dump "%USERPROFILE%\Desktop\Medical-Director-Dump"
cd "%USERPROFILE%\Desktop\Medical-Director-Dump"
```

### 3. Install dependencies
```
npm install
```

### 4. Configure your email
```
copy .env.example .env
```
Open `.env` in Notepad and fill in:
- `EMAIL_FROM` — Gmail address to send from (use a dedicated account)
- `EMAIL_APP_PASSWORD` — Gmail App Password ([generate one here](https://myaccount.google.com/apppasswords); requires 2FA enabled)
- `EMAIL_TO` — Your email address to receive reports

### 5. Test it manually
```
node candidate-sourcer.js
```
You should see output in the console and receive a test email.

---

## Set Up Daily Automation (Windows Task Scheduler)

1. Press **Win + S**, search for **Task Scheduler**, open it.
2. Click **Create Basic Task** in the right panel.
3. **Name**: `Medical Director Sourcer`
4. **Trigger**: Daily — set your preferred time (e.g., 7:00 AM)
5. **Action**: Start a program
   - **Program/script**: `cmd.exe`
   - **Add arguments**: `/c "%USERPROFILE%\Desktop\Medical-Director-Dump\run.bat"`
6. Click **Finish**.

To verify: right-click the task → **Run** → check your email.

Logs are saved to `run.log` in the repo folder after each run.

---

## File Reference

| File | Purpose |
|---|---|
| `candidate-sourcer.js` | Main script — loads CSV, sources candidates, triggers email |
| `config.js` | Search keywords, target locations, job boards |
| `mailer.js` | Sends the daily HTML email report via Gmail |
| `candidates.csv` | Running database of all found candidates |
| `run.bat` | Windows launcher for Task Scheduler |
| `.env` | Your private credentials (gitignored — never committed) |
| `.env.example` | Template showing required environment variables |
| `run.log` | Output log from automated runs (gitignored) |

---

## Customization

Edit `config.js` to change:
- `searchKeywords` — job titles to look for
- `locations` — target states/cities
- `jobBoards` — sites to source from
- `minExperience` — minimum years of experience filter
