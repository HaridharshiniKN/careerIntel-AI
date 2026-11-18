# CareerIntel AI — Career Intelligence & Placement Prediction System

Full-stack student placement readiness platform built with React, TypeScript, Tailwind CSS, Express, SQLite, and Gemini AI (`gemini-4-hydrogen`).

## Modules Implemented

1. **Student Registration & Login**: Salted `scrypt` authentication with Bearer session tokens, department, graduation year, and target career track.
2. **Student Dashboard**: Placement probability summary, weighted CGPA, Resume ATS readiness, learning roadmap progress, competency benchmarks, and eligible campus placement drives.
3. **Resume PDF Upload**: Upload `.pdf` resumes (or parse the generated sample PDF) for AI extraction of skills, project/internship/certification counts, ATS score, and improvement feedback.
4. **Academic Performance Analysis**: Multi-semester SGPA trajectory chart, credit-weighted CGPA calculation, attendance, backlogs, and semester CRUD.
5. **AI-Based Placement Prediction**: Calibrated placement probability, readiness tier, estimated CTC (LPA), matched roles, strengths, and risk factors.
6. **Technical & Aptitude Skill Gap Analysis**: Interactive benchmark comparison across 8 technical and aptitude dimensions with score calibration sliders.
7. **Personalized Learning Recommendations**: Priority-ranked study modules mapped to skill gaps with live completion tracking.
8. **Student Progress Report**: Weekly readiness trajectory chart, consolidated candidate dossier, CSV export, and printable PDF layout.
9. **Admin Dashboard**: Placement Office cohort analytics, student readiness roster, at-risk intervention flags, and campus drive scheduling.

## Quick Start

```bash
npm install
npm test
npm run lint
npm run build
npm run dev
```

### Seeded Sample Accounts
- **Student (Tier-1 Ready)**: `aarav.sharma@careerintel.edu` / `Student2026!`
- **Student (Developing)**: `rohan.k@careerintel.edu` / `Student2026!`
- **Placement Admin**: `admin@careerintel.edu` / `Admin2026!`
