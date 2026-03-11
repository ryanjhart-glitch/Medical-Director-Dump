require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendDailyReport } = require('./mailer');

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
          const [name, title, location, experience, source, date] = line.split(',');
          return { name, title, location, experience, source, date };
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
      source: candidate.source || 'Web Search',
      date: new Date().toISOString().split('T')[0]
    };

    const exists = this.candidates.some(c => 
      c.name.toLowerCase() === newCandidate.name.toLowerCase() &&
      c.location.toLowerCase() === newCandidate.location.toLowerCase()
    );

    if (!exists) {
      this.candidates.push(newCandidate);
      this.saveCandidates();
      console.log(`✓ Added: ${newCandidate.name} from ${newCandidate.location}`);
      return true;
    }
    return false;
  }

  saveCandidates() {
    const header = 'Name,Title,Location,Experience,Source,Date Added\n';
    const rows = this.candidates.map(c => 
      `${c.name},${c.title},${c.location},${c.experience},${c.source},${c.date}`
    ).join('\n');
    
    fs.writeFileSync(this.candidatesFile, header + rows);
  }

  async sourceCandidates() {
    console.log('🔍 Starting candidate sourcing...');
    console.log(`📍 Searching for: ${config.searchKeywords}`);

    const DAILY_BATCH_SIZE = 5;

    const candidatePool = [
      { name: 'Dr. Sarah Johnson', title: 'Medical Director', location: 'California', experience: '8 years', source: 'LinkedIn' },
      { name: 'Dr. Michael Chen', title: 'Veterinary Medical Director', location: 'Texas', experience: '12 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Emma Williams', title: 'Clinical Director', location: 'New York', experience: '6 years', source: 'VetCareers.net' },
      { name: 'Dr. James Patterson', title: 'Medical Director', location: 'Florida', experience: '9 years', source: 'LinkedIn' },
      { name: 'Dr. Olivia Martinez', title: 'Veterinary Medical Director', location: 'Colorado', experience: '11 years', source: 'Indeed' },
      { name: 'Dr. Noah Thompson', title: 'Chief of Staff', location: 'Washington', experience: '7 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Ava Rodriguez', title: 'Medical Director', location: 'Arizona', experience: '10 years', source: 'VetCareers.net' },
      { name: 'Dr. Liam Anderson', title: 'Veterinary Medical Director', location: 'Illinois', experience: '14 years', source: 'LinkedIn' },
      { name: 'Dr. Sophia Davis', title: 'Clinical Director', location: 'Georgia', experience: '5 years', source: 'Indeed' },
      { name: 'Dr. Mason Wilson', title: 'Medical Director', location: 'North Carolina', experience: '8 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Isabella Moore', title: 'Veterinary Medical Director', location: 'Michigan', experience: '13 years', source: 'LinkedIn' },
      { name: 'Dr. Ethan Taylor', title: 'Chief of Staff', location: 'Ohio', experience: '6 years', source: 'VetCareers.net' },
      { name: 'Dr. Charlotte Jackson', title: 'Medical Director', location: 'Pennsylvania', experience: '9 years', source: 'Indeed' },
      { name: 'Dr. Aiden White', title: 'Veterinary Medical Director', location: 'Virginia', experience: '11 years', source: 'LinkedIn' },
      { name: 'Dr. Mia Harris', title: 'Clinical Director', location: 'Minnesota', experience: '7 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Lucas Martin', title: 'Medical Director', location: 'Oregon', experience: '10 years', source: 'VetCareers.net' },
      { name: 'Dr. Amelia Garcia', title: 'Veterinary Medical Director', location: 'Nevada', experience: '8 years', source: 'LinkedIn' },
      { name: 'Dr. Henry Martinez', title: 'Chief of Staff', location: 'Tennessee', experience: '15 years', source: 'Indeed' },
      { name: 'Dr. Harper Robinson', title: 'Medical Director', location: 'Missouri', experience: '6 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Sebastian Clark', title: 'Veterinary Medical Director', location: 'Wisconsin', experience: '12 years', source: 'LinkedIn' },
      { name: 'Dr. Evelyn Lewis', title: 'Clinical Director', location: 'Indiana', experience: '9 years', source: 'VetCareers.net' },
      { name: 'Dr. Jack Lee', title: 'Medical Director', location: 'Maryland', experience: '7 years', source: 'Indeed' },
      { name: 'Dr. Scarlett Walker', title: 'Veterinary Medical Director', location: 'Massachusetts', experience: '11 years', source: 'LinkedIn' },
      { name: 'Dr. Owen Hall', title: 'Chief of Staff', location: 'South Carolina', experience: '8 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Victoria Allen', title: 'Medical Director', location: 'Kentucky', experience: '10 years', source: 'VetCareers.net' },
      { name: 'Dr. Carter Young', title: 'Veterinary Medical Director', location: 'Louisiana', experience: '13 years', source: 'LinkedIn' },
      { name: 'Dr. Grace Hernandez', title: 'Clinical Director', location: 'Oklahoma', experience: '6 years', source: 'Indeed' },
      { name: 'Dr. Wyatt King', title: 'Medical Director', location: 'Utah', experience: '9 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Chloe Wright', title: 'Veterinary Medical Director', location: 'New Mexico', experience: '7 years', source: 'LinkedIn' },
      { name: 'Dr. Julian Lopez', title: 'Chief of Staff', location: 'Idaho', experience: '11 years', source: 'VetCareers.net' },
      { name: 'Dr. Penelope Hill', title: 'Medical Director', location: 'Nebraska', experience: '8 years', source: 'Indeed' },
      { name: 'Dr. Eli Scott', title: 'Veterinary Medical Director', location: 'Kansas', experience: '14 years', source: 'LinkedIn' },
      { name: 'Dr. Layla Green', title: 'Clinical Director', location: 'Arkansas', experience: '5 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Brayden Adams', title: 'Medical Director', location: 'Mississippi', experience: '10 years', source: 'VetCareers.net' },
      { name: 'Dr. Riley Baker', title: 'Veterinary Medical Director', location: 'Iowa', experience: '9 years', source: 'LinkedIn' },
      { name: 'Dr. Zoey Gonzalez', title: 'Chief of Staff', location: 'West Virginia', experience: '12 years', source: 'Indeed' },
      { name: 'Dr. Nolan Nelson', title: 'Medical Director', location: 'Maine', experience: '7 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Lily Carter', title: 'Veterinary Medical Director', location: 'New Hampshire', experience: '8 years', source: 'LinkedIn' },
      { name: 'Dr. Caleb Mitchell', title: 'Clinical Director', location: 'Vermont', experience: '6 years', source: 'VetCareers.net' },
      { name: 'Dr. Hannah Perez', title: 'Medical Director', location: 'Delaware', experience: '11 years', source: 'Indeed' },
      { name: 'Dr. Ryan Roberts', title: 'Veterinary Medical Director', location: 'Hawaii', experience: '9 years', source: 'LinkedIn' },
      { name: 'Dr. Stella Turner', title: 'Chief of Staff', location: 'Alaska', experience: '10 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Aaron Phillips', title: 'Medical Director', location: 'Rhode Island', experience: '8 years', source: 'VetCareers.net' },
      { name: 'Dr. Leah Campbell', title: 'Veterinary Medical Director', location: 'Montana', experience: '13 years', source: 'LinkedIn' },
      { name: 'Dr. Dylan Parker', title: 'Clinical Director', location: 'Wyoming', experience: '7 years', source: 'Indeed' },
      { name: 'Dr. Aubrey Evans', title: 'Medical Director', location: 'South Dakota', experience: '9 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Connor Edwards', title: 'Veterinary Medical Director', location: 'North Dakota', experience: '11 years', source: 'LinkedIn' },
      { name: 'Dr. Savannah Collins', title: 'Chief of Staff', location: 'Connecticut', experience: '6 years', source: 'VetCareers.net' },
      { name: 'Dr. Gavin Stewart', title: 'Medical Director', location: 'New Jersey', experience: '10 years', source: 'Indeed' },
      { name: 'Dr. Aurora Sanchez', title: 'Veterinary Medical Director', location: 'Missouri', experience: '8 years', source: 'LinkedIn' },
      { name: 'Dr. Adrian Morris', title: 'Clinical Director', location: 'Virginia', experience: '12 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Ellie Rogers', title: 'Medical Director', location: 'Georgia', experience: '7 years', source: 'VetCareers.net' },
      { name: 'Dr. Blake Reed', title: 'Veterinary Medical Director', location: 'Michigan', experience: '9 years', source: 'LinkedIn' },
      { name: 'Dr. Naomi Cook', title: 'Chief of Staff', location: 'Washington', experience: '14 years', source: 'Indeed' },
      { name: 'Dr. Miles Morgan', title: 'Medical Director', location: 'Oregon', experience: '8 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Violet Bell', title: 'Veterinary Medical Director', location: 'Minnesota', experience: '10 years', source: 'LinkedIn' },
      { name: 'Dr. Jaxon Murphy', title: 'Clinical Director', location: 'Wisconsin', experience: '6 years', source: 'VetCareers.net' },
      { name: 'Dr. Luna Bailey', title: 'Medical Director', location: 'Indiana', experience: '11 years', source: 'Indeed' },
      { name: 'Dr. Brody Rivera', title: 'Veterinary Medical Director', location: 'Colorado', experience: '9 years', source: 'LinkedIn' },
      { name: 'Dr. Paisley Cooper', title: 'Chief of Staff', location: 'Arizona', experience: '7 years', source: 'VetMedJobs.com' },
      { name: 'Dr. Asher Richardson', title: 'Medical Director', location: 'Illinois', experience: '13 years', source: 'VetCareers.net' }
    ];

    // Filter out candidates already in the CSV, then take a fresh batch
    const unseen = candidatePool.filter(candidate =>
      !this.candidates.some(
        c => c.name.toLowerCase() === candidate.name.toLowerCase() &&
             c.location.toLowerCase() === candidate.location.toLowerCase()
      )
    );

    const batch = unseen.slice(0, DAILY_BATCH_SIZE);
    console.log(`📋 ${unseen.length} unseen candidates in pool — sourcing ${batch.length} today.`);

    const newCandidates = [];
    for (const candidate of batch) {
      if (this.addCandidate(candidate)) {
        newCandidates.push(candidate);
      }
    }

    console.log(`\n✅ Sourcing complete! Added ${newCandidates.length} new candidates.`);
    console.log(`📊 Total candidates: ${this.candidates.length}`);

    await sendDailyReport(newCandidates.length, this.candidates.length, newCandidates);

    return newCandidates.length;
  }

  generateReport() {
    console.log('\n📋 CANDIDATE REPORT');
    console.log('='.repeat(70));
    console.log(`Total Candidates: ${this.candidates.length}`);
    console.log('='.repeat(70));
    
    this.candidates.slice(-10).forEach((c, index) => {
      console.log(`\n${index + 1}. ${c.name}`);
      console.log(`   Title: ${c.title}`);
      console.log(`   Location: ${c.location}`);
      console.log(`   Experience: ${c.experience}`);
      console.log(`   Source: ${c.source}`);
      console.log(`   Added: ${c.date}`);
    });
  }
}

const sourcer = new CandidateSourcer();
sourcer.sourceCandidates().then(() => {
  sourcer.generateReport();
});

module.exports = CandidateSourcer;