import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  getDb,
  initializeStudentDefaults,
  ROLE_BENCHMARKS,
  type UserRecord,
} from './src/server/db.ts';
import {
  hashPassword,
  optionalAuth,
  requireAdmin,
  requireAuth,
  signToken,
  verifyPassword,
  type AuthRequest,
} from './src/server/auth.ts';
import {
  analyzeResumePdf,
  buildSampleResumePdfBuffer,
  generatePlacementPrediction,
} from './src/server/ai.ts';

function computeAcademicSummary(records: Array<{ gpa: number; credits: number; attendance_pct: number; backlogs: number; core_cs_score: number; math_aptitude_score: number }>) {
  if (records.length === 0) {
    return {
      cgpa: 0,
      totalCredits: 0,
      avgAttendance: 0,
      totalBacklogs: 0,
      avgCoreCs: 0,
      avgMathAptitude: 0,
      trendDelta: 0,
    };
  }
  let weightedSum = 0;
  let totalCredits = 0;
  let attendanceSum = 0;
  let backlogs = 0;
  let coreSum = 0;
  let mathSum = 0;

  for (const r of records) {
    weightedSum += r.gpa * r.credits;
    totalCredits += r.credits;
    attendanceSum += r.attendance_pct;
    backlogs += r.backlogs;
    coreSum += r.core_cs_score;
    mathSum += r.math_aptitude_score;
  }

  const firstGpa = records[0].gpa;
  const lastGpa = records[records.length - 1].gpa;

  return {
    cgpa: Number((weightedSum / Math.max(1, totalCredits)).toFixed(2)),
    totalCredits,
    avgAttendance: Number((attendanceSum / records.length).toFixed(1)),
    totalBacklogs: backlogs,
    avgCoreCs: Number((coreSum / records.length).toFixed(1)),
    avgMathAptitude: Number((mathSum / records.length).toFixed(1)),
    trendDelta: Number((lastGpa - firstGpa).toFixed(2)),
  };
}

export function createApp() {
  const app = express();
  const db = getDb();

  app.use(express.json({ limit: '16mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'CareerIntel AI API', timestamp: new Date().toISOString() });
  });

  // --- 1. Student Registration & Login ---
  app.post('/api/auth/register', (req, res) => {
    const { name, email, password, department, graduationYear, targetRole } = req.body ?? {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      res.status(400).json({ error: 'Please enter your full name (minimum 2 characters).' });
      return;
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'Please enter a valid academic or personal email address.' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this email is already registered.' });
      return;
    }

    const dept = String(department || 'Computer Science & Engineering').trim();
    const gradYear = Number(graduationYear) || 2027;
    const roleTarget = String(targetRole || 'Software Development Engineer').trim();
    const code = `STU-${gradYear}-${String(Math.floor(100 + Math.random() * 899))}`;

    const result = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, student_code, department, graduation_year, target_role)
         VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`
      )
      .run(name.trim(), normalizedEmail, hashPassword(password), code, dept, gradYear, roleTarget);

    const userId = Number(result.lastInsertRowid);
    initializeStudentDefaults(db, userId);

    const token = signToken({
      userId,
      email: normalizedEmail,
      role: 'student',
      name: name.trim(),
    });

    const user = db
      .prepare('SELECT id, name, email, role, student_code, department, graduation_year, target_role, created_at FROM users WHERE id = ?')
      .get(userId);

    res.status(201).json({ token, user });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as UserRecord | undefined;
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        student_code: user.student_code,
        department: user.department,
        graduation_year: user.graduation_year,
        target_role: user.target_role,
        created_at: user.created_at,
      },
    });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => {
    const user = db
      .prepare('SELECT id, name, email, role, student_code, department, graduation_year, target_role, created_at FROM users WHERE id = ?')
      .get(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: 'User account not found.' });
      return;
    }
    res.json({ user });
  });

  // Helper to resolve active student ID (logged-in student or demo student Aarav for preview)
  function resolveStudentId(req: AuthRequest): number {
    if (req.user && req.user.role === 'student') {
      return req.user.userId;
    }
    if (req.user && req.user.role === 'admin' && req.query.studentId) {
      return Number(req.query.studentId);
    }
    const demo = db
      .prepare("SELECT id FROM users WHERE email = 'aarav.sharma@careerintel.edu' LIMIT 1")
      .get() as { id: number } | undefined;
    return demo?.id ?? 1;
  }

  // --- 2. Student Dashboard & Full Workspace Payload ---
  app.get('/api/student/workspace', optionalAuth, (req: AuthRequest, res) => {
    const studentId = resolveStudentId(req);
    const student = db
      .prepare('SELECT id, name, email, role, student_code, department, graduation_year, target_role, created_at FROM users WHERE id = ?')
      .get(studentId) as Omit<UserRecord, 'password_hash'> | undefined;

    if (!student) {
      res.status(404).json({ error: 'Student profile not found.' });
      return;
    }

    const academics = db
      .prepare('SELECT * FROM academic_records WHERE user_id = ? ORDER BY semester ASC')
      .all(studentId) as any[];
    const academicSummary = computeAcademicSummary(academics);

    const resumes = db
      .prepare('SELECT * FROM resumes WHERE user_id = ? ORDER BY id DESC LIMIT 10')
      .all(studentId) as any[];

    const parsedResumes = resumes.map((r) => ({
      ...r,
      extracted_skills: JSON.parse(r.extracted_skills_json || '[]'),
    }));

    let skills = db.prepare('SELECT * FROM skill_assessments WHERE user_id = ?').get(studentId) as any;
    if (!skills) {
      initializeStudentDefaults(db, studentId);
      skills = db.prepare('SELECT * FROM skill_assessments WHERE user_id = ?').get(studentId);
    }

    const predictions = db
      .prepare('SELECT * FROM placement_predictions WHERE user_id = ? ORDER BY id DESC LIMIT 10')
      .all(studentId) as any[];
    const parsedPredictions = predictions.map((p) => ({
      ...p,
      top_matched_roles: JSON.parse(p.top_matched_roles_json || '[]'),
      strengths: JSON.parse(p.strengths_json || '[]'),
      risk_factors: JSON.parse(p.risk_factors_json || '[]'),
    }));

    const recommendations = db
      .prepare('SELECT * FROM learning_recommendations WHERE user_id = ? ORDER BY id ASC')
      .all(studentId) as any[];

    const progressSnapshots = db
      .prepare('SELECT * FROM progress_snapshots WHERE user_id = ? ORDER BY id ASC')
      .all(studentId) as any[];

    const drives = db
      .prepare('SELECT * FROM placement_drives ORDER BY drive_date ASC')
      .all() as any[];

    const parsedDrives = drives.map((d) => ({
      ...d,
      required_skills: JSON.parse(d.required_skills_json || '[]'),
      eligible: academicSummary.cgpa >= d.min_cgpa && academicSummary.totalBacklogs === 0,
    }));

    const benchmark =
      ROLE_BENCHMARKS[student.target_role] || ROLE_BENCHMARKS['Software Development Engineer'];

    res.json({
      isDemoPreview: !req.user,
      student,
      academics,
      academicSummary,
      resumes: parsedResumes,
      skills,
      benchmark,
      benchmarks: Object.values(ROLE_BENCHMARKS),
      predictions: parsedPredictions,
      recommendations,
      progressSnapshots,
      drives: parsedDrives,
    });
  });

  app.patch('/api/student/target-role', requireAuth, (req: AuthRequest, res) => {
    const { targetRole } = req.body ?? {};
    if (!targetRole || typeof targetRole !== 'string') {
      res.status(400).json({ error: 'Target role is required.' });
      return;
    }
    db.prepare('UPDATE users SET target_role = ? WHERE id = ?').run(targetRole.trim(), req.user!.userId);
    res.json({ target_role: targetRole.trim() });
  });

  // --- 3. Resume PDF Upload & Sample PDF Generator ---
  app.get('/api/sample-resume.pdf', optionalAuth, (req: AuthRequest, res) => {
    const studentId = resolveStudentId(req);
    const student = db.prepare('SELECT name, email, department, target_role FROM users WHERE id = ?').get(studentId) as any;
    const academics = db.prepare('SELECT gpa, credits, attendance_pct, backlogs, core_cs_score, math_aptitude_score FROM academic_records WHERE user_id = ?').all(studentId) as any[];
    const summary = computeAcademicSummary(academics);

    const buffer = buildSampleResumePdfBuffer({
      name: student?.name || 'Aarav Sharma',
      email: student?.email || 'aarav.sharma@careerintel.edu',
      department: student?.department || 'Computer Science & Engineering',
      cgpa: summary.cgpa || 8.62,
      targetRole: student?.target_role || 'Software Development Engineer',
      skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Python', 'Docker', 'Redis', 'Data Structures'],
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Sample_Student_Resume.pdf"');
    res.send(buffer);
  });

  app.post('/api/resume/upload', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { filename, pdfBase64 } = req.body ?? {};
      if (!pdfBase64 || typeof pdfBase64 !== 'string') {
        res.status(400).json({ error: 'A PDF resume file payload is required.' });
        return;
      }

      const cleanBase64 = pdfBase64.startsWith('data:application/pdf;base64,')
        ? pdfBase64.slice('data:application/pdf;base64,'.length)
        : pdfBase64;

      const byteLen = Buffer.byteLength(cleanBase64, 'base64');
      if (byteLen < 100) {
        res.status(400).json({ error: 'Uploaded PDF appears empty or corrupted.' });
        return;
      }

      const student = db.prepare('SELECT target_role FROM users WHERE id = ?').get(req.user!.userId) as { target_role: string };
      const parsed = await analyzeResumePdf(
        cleanBase64,
        String(filename || 'Resume.pdf'),
        student?.target_role || 'Software Development Engineer'
      );

      const insertRes = db
        .prepare(
          `INSERT INTO resumes (
            user_id, filename, file_size_bytes, raw_summary, extracted_skills_json,
            projects_count, internships_count, certifications_count, ats_score, resume_strength_notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.user!.userId,
          String(filename || 'Resume.pdf').slice(0, 120),
          byteLen,
          parsed.raw_summary,
          JSON.stringify(parsed.extracted_skills),
          parsed.projects_count,
          parsed.internships_count,
          parsed.certifications_count,
          parsed.ats_score,
          parsed.resume_strength_notes
        );

      const saved = db.prepare('SELECT * FROM resumes WHERE id = ?').get(Number(insertRes.lastInsertRowid)) as any;
      res.status(201).json({
        resume: {
          ...saved,
          extracted_skills: JSON.parse(saved.extracted_skills_json || '[]'),
        },
      });
    } catch (error: any) {
      const msg = error?.message || 'Resume PDF analysis failed.';
      res.status(msg.includes('GEMINI_API_KEY') ? 503 : 500).json({ error: msg });
    }
  });

  // --- 4. Academic Performance Analysis ---
  app.post('/api/academics', requireAuth, (req: AuthRequest, res) => {
    const { semester, gpa, credits, attendance_pct, backlogs, core_cs_score, math_aptitude_score } = req.body ?? {};
    const sem = Number(semester);
    const gpaVal = Number(gpa);
    if (!Number.isInteger(sem) || sem < 1 || sem > 10) {
      res.status(400).json({ error: 'Semester must be an integer between 1 and 10.' });
      return;
    }
    if (Number.isNaN(gpaVal) || gpaVal < 0 || gpaVal > 10) {
      res.status(400).json({ error: 'GPA must be between 0.0 and 10.0.' });
      return;
    }

    db.prepare(
      `INSERT INTO academic_records (user_id, semester, gpa, credits, attendance_pct, backlogs, core_cs_score, math_aptitude_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, semester) DO UPDATE SET
         gpa = excluded.gpa,
         credits = excluded.credits,
         attendance_pct = excluded.attendance_pct,
         backlogs = excluded.backlogs,
         core_cs_score = excluded.core_cs_score,
         math_aptitude_score = excluded.math_aptitude_score`
    ).run(
      req.user!.userId,
      sem,
      Number(gpaVal.toFixed(2)),
      Math.max(1, Math.min(35, Number(credits) || 22)),
      Math.max(0, Math.min(100, Number(attendance_pct) || 88)),
      Math.max(0, Number(backlogs) || 0),
      Math.max(0, Math.min(100, Number(core_cs_score) || 80)),
      Math.max(0, Math.min(100, Number(math_aptitude_score) || 80))
    );

    const academics = db
      .prepare('SELECT * FROM academic_records WHERE user_id = ? ORDER BY semester ASC')
      .all(req.user!.userId) as any[];
    res.json({ academics, academicSummary: computeAcademicSummary(academics) });
  });

  app.delete('/api/academics/:id', requireAuth, (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT user_id FROM academic_records WHERE id = ?').get(id) as { user_id: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Semester record not found.' });
      return;
    }
    if (row.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    db.prepare('DELETE FROM academic_records WHERE id = ?').run(id);
    res.json({ deleted: true, id });
  });

  // --- 6. Technical & Aptitude Skill Gap Analysis ---
  app.put('/api/skills', requireAuth, (req: AuthRequest, res) => {
    const body = req.body ?? {};
    const clamp = (v: unknown, fallback = 60) => Math.max(0, Math.min(100, Math.round(Number(v ?? fallback))));

    initializeStudentDefaults(db, req.user!.userId);
    db.prepare(
      `UPDATE skill_assessments SET
        dsa_score = ?,
        system_design_score = ?,
        dbms_sql_score = ?,
        backend_api_score = ?,
        cloud_devops_score = ?,
        quant_aptitude_score = ?,
        logical_reasoning_score = ?,
        verbal_comm_score = ?,
        coding_problems_solved = ?,
        mock_interviews_completed = ?,
        updated_at = datetime('now')
      WHERE user_id = ?`
    ).run(
      clamp(body.dsa_score),
      clamp(body.system_design_score),
      clamp(body.dbms_sql_score),
      clamp(body.backend_api_score),
      clamp(body.cloud_devops_score),
      clamp(body.quant_aptitude_score),
      clamp(body.logical_reasoning_score),
      clamp(body.verbal_comm_score),
      Math.max(0, Math.round(Number(body.coding_problems_solved) || 0)),
      Math.max(0, Math.round(Number(body.mock_interviews_completed) || 0)),
      req.user!.userId
    );

    const skills = db.prepare('SELECT * FROM skill_assessments WHERE user_id = ?').get(req.user!.userId);
    res.json({ skills });
  });

  // --- 5. AI-Based Placement Prediction & 7. Personalized Learning Recommendations ---
  app.post('/api/predictions/run', requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.userId;
      const student = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRecord | undefined;
      if (!student) {
        res.status(404).json({ error: 'Student account not found.' });
        return;
      }

      const academics = db
        .prepare('SELECT * FROM academic_records WHERE user_id = ? ORDER BY semester ASC')
        .all(userId) as any[];
      const academicSummary = computeAcademicSummary(academics);

      initializeStudentDefaults(db, userId);
      const skills = db.prepare('SELECT * FROM skill_assessments WHERE user_id = ?').get(userId) as any;
      const latestResume = db.prepare('SELECT * FROM resumes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) as any;

      const benchmark =
        ROLE_BENCHMARKS[student.target_role] || ROLE_BENCHMARKS['Software Development Engineer'];

      const aiResult = await generatePlacementPrediction({
        studentName: student.name,
        department: student.department,
        targetRole: student.target_role,
        cgpa: academicSummary.cgpa || 7.5,
        attendancePct: academicSummary.avgAttendance || 85,
        backlogs: academicSummary.totalBacklogs,
        semesterTrend: academics.map((a) => ({ semester: a.semester, gpa: a.gpa })),
        skills,
        benchmark,
        resume: latestResume
          ? {
              ats_score: latestResume.ats_score,
              projects_count: latestResume.projects_count,
              internships_count: latestResume.internships_count,
              extracted_skills: JSON.parse(latestResume.extracted_skills_json || '[]'),
            }
          : null,
      });

      const predRes = db
        .prepare(
          `INSERT INTO placement_predictions (
            user_id, placement_probability, readiness_tier, predicted_ctc_lpa,
            top_matched_roles_json, strengths_json, risk_factors_json, ai_rationale, model_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gemini-4-hydrogen')`
        )
        .run(
          userId,
          aiResult.placement_probability,
          aiResult.readiness_tier,
          aiResult.predicted_ctc_lpa,
          JSON.stringify(aiResult.top_matched_roles),
          JSON.stringify(aiResult.strengths),
          JSON.stringify(aiResult.risk_factors),
          aiResult.ai_rationale
        );

      // Refresh personalized learning recommendations
      if (aiResult.recommended_learning_plan.length > 0) {
        db.prepare("DELETE FROM learning_recommendations WHERE user_id = ? AND status = 'pending'").run(userId);
        const insRec = db.prepare(
          `INSERT INTO learning_recommendations (
            user_id, skill_area, priority, title, provider, estimated_hours, rationale, resource_url, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        );
        for (const item of aiResult.recommended_learning_plan) {
          insRec.run(
            userId,
            item.skill_area,
            item.priority,
            item.title,
            item.provider,
            item.estimated_hours,
            item.rationale,
            item.resource_url || ''
          );
        }
      }

      // Append weekly snapshot for progress tracking
      const snapCount = (db.prepare('SELECT COUNT(*) as c FROM progress_snapshots WHERE user_id = ?').get(userId) as { c: number }).c;
      const avgApt = Math.round((skills.quant_aptitude_score + skills.logical_reasoning_score + skills.verbal_comm_score) / 3);
      db.prepare(
        'INSERT INTO progress_snapshots (user_id, week_label, readiness_score, dsa_score, aptitude_score, cgpa) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, `Eval #${snapCount + 1}`, aiResult.placement_probability, skills.dsa_score, avgApt, academicSummary.cgpa);

      const savedPred = db.prepare('SELECT * FROM placement_predictions WHERE id = ?').get(Number(predRes.lastInsertRowid)) as any;
      const recommendations = db.prepare('SELECT * FROM learning_recommendations WHERE user_id = ? ORDER BY id ASC').all(userId);

      res.status(201).json({
        prediction: {
          ...savedPred,
          top_matched_roles: JSON.parse(savedPred.top_matched_roles_json || '[]'),
          strengths: JSON.parse(savedPred.strengths_json || '[]'),
          risk_factors: JSON.parse(savedPred.risk_factors_json || '[]'),
        },
        recommendations,
      });
    } catch (error: any) {
      const msg = error?.message || 'Placement prediction failed.';
      res.status(msg.includes('GEMINI_API_KEY') ? 503 : 500).json({ error: msg });
    }
  });

  app.patch('/api/recommendations/:id', requireAuth, (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!['pending', 'in_progress', 'completed'].includes(String(status))) {
      res.status(400).json({ error: 'Invalid learning recommendation status.' });
      return;
    }
    const existing = db.prepare('SELECT user_id FROM learning_recommendations WHERE id = ?').get(id) as { user_id: number } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Recommendation not found.' });
      return;
    }
    if (existing.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    db.prepare('UPDATE learning_recommendations SET status = ? WHERE id = ?').run(String(status), id);
    const updated = db.prepare('SELECT * FROM learning_recommendations WHERE id = ?').get(id);
    res.json({ recommendation: updated });
  });

  // --- 9. Admin Dashboard ---
  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    const students = db
      .prepare("SELECT id, name, email, student_code, department, graduation_year, target_role, created_at FROM users WHERE role = 'student' ORDER BY id ASC")
      .all() as any[];

    const roster = students.map((stu) => {
      const academics = db.prepare('SELECT * FROM academic_records WHERE user_id = ? ORDER BY semester ASC').all(stu.id) as any[];
      const acadSummary = computeAcademicSummary(academics);
      const latestPred = db.prepare('SELECT placement_probability, readiness_tier, predicted_ctc_lpa FROM placement_predictions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(stu.id) as any;
      const latestResume = db.prepare('SELECT ats_score, filename FROM resumes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(stu.id) as any;
      const skills = db.prepare('SELECT dsa_score, quant_aptitude_score FROM skill_assessments WHERE user_id = ?').get(stu.id) as any;

      return {
        ...stu,
        cgpa: acadSummary.cgpa,
        backlogs: acadSummary.totalBacklogs,
        placement_probability: latestPred?.placement_probability ?? 0,
        readiness_tier: latestPred?.readiness_tier ?? 'Pending Eval',
        predicted_ctc_lpa: latestPred?.predicted_ctc_lpa ?? 0,
        ats_score: latestResume?.ats_score ?? 0,
        dsa_score: skills?.dsa_score ?? 0,
        aptitude_score: skills?.quant_aptitude_score ?? 0,
      };
    });

    const totalStudents = roster.length;
    const avgCgpa = totalStudents ? Number((roster.reduce((a, b) => a + b.cgpa, 0) / totalStudents).toFixed(2)) : 0;
    const avgProbability = totalStudents
      ? Number((roster.reduce((a, b) => a + b.placement_probability, 0) / totalStudents).toFixed(1))
      : 0;
    const tier1Count = roster.filter((s) => s.readiness_tier === 'Tier-1 Ready' || s.readiness_tier === 'Placement Ready').length;
    const atRiskCount = roster.filter((s) => s.placement_probability < 65 || s.backlogs > 0).length;

    const drives = db.prepare('SELECT * FROM placement_drives ORDER BY drive_date ASC').all() as any[];
    const parsedDrives = drives.map((d) => ({
      ...d,
      required_skills: JSON.parse(d.required_skills_json || '[]'),
      eligible_count: roster.filter((s) => s.cgpa >= d.min_cgpa && s.backlogs === 0).length,
    }));

    res.json({
      kpis: {
        totalStudents,
        avgCgpa,
        avgProbability,
        tier1Count,
        atRiskCount,
        openDrives: parsedDrives.filter((d) => d.status === 'Open').length,
      },
      roster,
      drives: parsedDrives,
    });
  });

  app.post('/api/admin/drives', requireAdmin, (req, res) => {
    const { company_name, role_title, min_cgpa, package_lpa, required_skills, status, drive_date } = req.body ?? {};
    if (!company_name || !role_title || !drive_date) {
      res.status(400).json({ error: 'Company name, role title, and drive date are required.' });
      return;
    }
    const skillsArr = Array.isArray(required_skills)
      ? required_skills
      : String(required_skills || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

    const ins = db
      .prepare(
        `INSERT INTO placement_drives (company_name, role_title, min_cgpa, package_lpa, required_skills_json, status, drive_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(company_name).trim(),
        String(role_title).trim(),
        Number(min_cgpa) || 7.0,
        Number(package_lpa) || 9.0,
        JSON.stringify(skillsArr),
        String(status || 'Open'),
        String(drive_date)
      );

    const drive = db.prepare('SELECT * FROM placement_drives WHERE id = ?').get(Number(ins.lastInsertRowid)) as any;
    res.status(201).json({
      drive: { ...drive, required_skills: JSON.parse(drive.required_skills_json || '[]') },
    });
  });

  app.patch('/api/admin/drives/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!['Open', 'Upcoming', 'Closed'].includes(String(status))) {
      res.status(400).json({ error: 'Invalid drive status.' });
      return;
    }
    db.prepare('UPDATE placement_drives SET status = ? WHERE id = ?').run(String(status), id);
    res.json({ updated: true, id, status });
  });

  app.delete('/api/admin/drives/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM placement_drives WHERE id = ?').run(id);
    res.json({ deleted: true, id });
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const distDir = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`CareerIntel AI server running on http://0.0.0.0:${port}`);
  });
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start CareerIntel AI server:', err);
    process.exit(1);
  });
}
