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
    
    const simulatedCandidates = [
      {
        name: 'Dr. Sarah Johnson',
        title: 'Medical Director',
        location: 'California',
        experience: '8 years',
        source: 'LinkedIn'
      },
      {
        name: 'Dr. Michael Chen',
        title: 'Veterinary Medical Director',
        location: 'Texas',
        experience: '12 years',
        source: 'VetMedJobs.com'
      },
      {
        name: 'Dr. Emma Williams',
        title: 'Clinical Director',
        location: 'New York',
        experience: '6 years',
        source: 'VetCareers.net'
      }
    ];

    const newCandidates = [];
    for (const candidate of simulatedCandidates) {
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