/**
 * Training — courses for anyone with a portal login (crew leads get a Training-only account).
 * Routes: /training (course list), /training/:courseId (start page), /training/:courseId/:moduleId.
 * Phone-first, no office sidebar. Progress is saved per person via /training/*.
 * Course content: src/lib/training/. Backend: app/api/training.py.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  completeTrainingModule, currentUser, getTrainingProgress, isTrainingOnly, logout, type CourseProgress,
} from '../lib/api';
import { COURSES, findCourse, type Block, type Check, type Course, type Module } from '../lib/training';

const C = {
  bg: '#f4f7f1', surface: '#ffffff', soft: '#e8efe2', line: '#d5ddcd', fg: '#17241a', muted: '#55645a',
  forest: '#1f4d2b', hivis: '#d9661c', good: '#2e7d46', goodBg: '#e4f2e6', bad: '#b23a2a', badBg: '#fbe9e5',
};
const display = '"Archivo", "Arial Narrow", Arial, sans-serif';

const page: CSSProperties = { minHeight: '100vh', background: C.bg, color: C.fg, fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: 16, lineHeight: 1.6 };
const wrap: CSSProperties = { maxWidth: 780, margin: '0 auto', padding: '20px 16px 64px' };
const card: CSSProperties = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, minWidth: 0 };
const eyebrow: CSSProperties = { fontFamily: display, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6f9645' };
const h1: CSSProperties = { fontFamily: display, fontWeight: 800, fontSize: 30, lineHeight: 1.15, margin: '4px 0 6px' };
const h3: CSSProperties = { fontFamily: display, fontWeight: 700, fontSize: 19, margin: '0 0 10px' };
const lede: CSSProperties = { fontSize: 17, color: C.muted, margin: 0 };
const btn: CSSProperties = { display: 'inline-block', fontWeight: 600, fontSize: 15, borderRadius: 8, padding: '11px 18px', border: `1.5px solid ${C.forest}`, background: C.forest, color: '#fff', cursor: 'pointer', textDecoration: 'none' };
const ghost: CSSProperties = { ...btn, background: 'transparent', color: C.forest };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 };
const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 24, marginTop: 20 };

function Bar({ value, total }: { value: number; total: number }) {
  return (
    <div style={{ height: 8, borderRadius: 99, background: C.soft, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${total ? (value / total) * 100 : 0}%`, background: C.forest, borderRadius: 99 }} />
    </div>
  );
}

function Header() {
  const user = currentUser();
  const trainingOnly = isTrainingOnly();
  return (
    <header style={{ background: C.forest, color: '#fff' }}>
      <div style={{ ...wrap, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Link to="/training" style={{ color: '#fff', textDecoration: 'none', fontFamily: display, fontWeight: 800, fontSize: 18 }}>🌿 Darios Training</Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 14 }}>
          {user?.name && <span style={{ opacity: 0.85 }}>{user.name}</span>}
          {!trainingOnly && <Link to="/home" style={{ color: '#fff' }}>Office home</Link>}
          <button type="button" onClick={logout} style={{ background: 'none', border: '1px solid rgba(255,255,255,.5)', color: '#fff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'videos':
      return (
        <div style={grid}>
          {b.videos.map(v => (
            <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" style={{ ...card, padding: 0, overflow: 'hidden', textDecoration: 'none', color: C.fg, display: 'flex', flexDirection: 'column' }}>
              <div style={{ position: 'relative', aspectRatio: '16 / 9', maxWidth: '100%', background: C.soft }}>
                <img src={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                <span aria-hidden style={{ position: 'absolute', inset: 0, margin: 'auto', width: 54, height: 54, borderRadius: '50%', background: '#c0392b', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 20, boxShadow: '0 2px 10px rgba(0,0,0,.35)' }}>▶</span>
              </div>
              <div style={{ padding: '10px 14px 14px' }}>
                <div style={{ fontFamily: display, fontWeight: 700, fontSize: 17 }}>{v.title}</div>
                <div style={{ fontSize: 13, color: C.muted }}>{v.meta} · opens YouTube</div>
                <div style={{ fontSize: 15, marginTop: 4 }}>{v.why}</div>
              </div>
            </a>
          ))}
        </div>
      );
    case 'text':
      return <div>{b.title && <h3 style={h3}>{b.title}</h3>}{b.paragraphs.map((p, i) => <p key={i} style={{ margin: '0 0 12px' }}>{p}</p>)}</div>;
    case 'list':
      return <div>{b.title && <h3 style={h3}>{b.title}</h3>}<ul style={{ margin: 0, paddingLeft: 20 }}>{b.items.map((t, i) => <li key={i} style={{ marginBottom: 6 }}>{t}</li>)}</ul></div>;
    case 'cards':
      return (
        <div>
          {b.title && <h3 style={h3}>{b.title}</h3>}
          <div style={grid}>
            {b.cards.map((c, i) => (
              <div key={i} style={card}>
                {c.big && <div style={{ fontFamily: display, fontWeight: 800, fontSize: 40, lineHeight: 1, color: C.hivis }}>{c.big}</div>}
                <div style={{ fontFamily: display, fontWeight: 700, fontSize: 17, color: C.forest, margin: '4px 0' }}>{c.title}</div>
                <div style={{ fontSize: 15 }}>{c.text}</div>
              </div>
            ))}
          </div>
        </div>
      );
    case 'compare':
      return (
        <div>
          {b.title && <h3 style={h3}>{b.title}</h3>}
          <div style={grid}>
            {[{ s: b.no, bg: C.badBg, fg: C.bad }, { s: b.yes, bg: C.goodBg, fg: C.good }].map(({ s, bg, fg }) => (
              <div key={s.title} style={{ ...card, background: bg, border: 'none' }}>
                <div style={{ fontFamily: display, fontWeight: 700, fontSize: 17, color: fg }}>{s.title}</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 15 }}>{s.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      );
    case 'ladder':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {b.rungs.map((r, i) => {
            const top = i === b.rungs.length - 1;
            return (
              <div key={r.level} style={{ ...card, display: 'flex', gap: 14, alignItems: 'flex-start', background: top ? C.forest : C.surface, borderColor: top ? C.forest : C.line, color: top ? '#fff' : C.fg }}>
                <div style={{ fontFamily: display, fontWeight: 800, fontSize: 30, lineHeight: 1, color: top ? '#cfe3c0' : C.forest, minWidth: 24 }}>{r.level}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: display, fontWeight: 700, fontSize: 17 }}>{r.who}</div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>{r.role}</div>
                  <div style={{ fontSize: 15, marginTop: 4 }}>{r.text}</div>
                </div>
              </div>
            );
          })}
        </div>
      );
    case 'callout':
      return (
        <div style={{ borderRadius: 10, padding: '14px 16px', fontSize: 15, background: b.tone === 'danger' ? C.badBg : C.soft }}>
          <strong style={{ color: b.tone === 'danger' ? C.bad : C.hivis }}>{b.label}</strong> {b.text}
        </div>
      );
  }
}

function CheckView({ c, picked, onPick, label, solved }: { c: Check; picked: number | undefined; onPick: (j: number) => void; label: string; solved: boolean }) {
  const right = picked === c.correct;
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ ...eyebrow, color: C.hivis }}>{c.tag || label}</span>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 17 }}>{c.q}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {c.options.map((o, j) => {
          const showRight = (picked === j && right) || (solved && picked === undefined && j === c.correct);
          const showWrong = picked === j && !right;
          return (
            <button key={j} type="button" disabled={right} onClick={() => onPick(j)}
              style={{ textAlign: 'left', font: 'inherit', fontSize: 15, color: C.fg, borderRadius: 8, padding: '11px 14px', cursor: right ? 'default' : 'pointer',
                background: showRight ? C.goodBg : showWrong ? C.badBg : C.bg,
                border: `1.5px solid ${showRight ? C.good : showWrong ? C.bad : C.line}` }}>
              {o}
            </button>
          );
        })}
      </div>
      {picked !== undefined && (
        <p style={{ margin: 0, fontSize: 15, padding: '10px 14px', borderRadius: 8, background: right ? C.goodBg : C.badBg }}>
          {right ? `Right. ${c.explain}` : 'Not quite. Try another answer.'}
        </p>
      )}
    </div>
  );
}

function PocketCard({ course }: { course: Course }) {
  return (
    <div style={{ background: C.forest, color: '#fff', borderRadius: 14, padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px 24px' }}>
      {course.pocketCard.map(sec => {
        const L = sec.ordered ? 'ol' : 'ul';
        return (
          <div key={sec.title}>
            <div style={{ fontFamily: display, fontWeight: 700, fontSize: 17, marginBottom: 6 }}>{sec.title}</div>
            <L style={{ margin: 0, paddingLeft: 20, fontSize: 15 }}>{sec.items.map((t, i) => <li key={i} style={{ marginBottom: 4 }}>{t}</li>)}</L>
          </div>
        );
      })}
    </div>
  );
}

function fmtDate(ts: string | null | undefined) {
  if (!ts) return '';
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function Training() {
  const { courseId, moduleId } = useParams();
  const [progress, setProgress] = useState<Record<string, CourseProgress> | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [picks, setPicks] = useState<Record<string, number>>({});

  useEffect(() => {
    getTrainingProgress().then(r => setProgress(r.courses)).catch(e => setLoadErr(String(e.message || e)));
  }, []);
  useEffect(() => { window.scrollTo({ top: 0 }); setSaveErr(''); }, [courseId, moduleId]);

  const course = findCourse(courseId);
  const mod = course?.modules.find(m => m.id === moduleId);
  const doneSet = useMemo(() => new Set(course && progress ? progress[course.id]?.done || [] : []), [course, progress]);

  async function complete(c: Course, m: Module) {
    setSaving(true); setSaveErr('');
    try {
      const r = await completeTrainingModule(c.id, m.id);
      setProgress(p => ({ ...(p || {}), [c.id]: r }));
    } catch (e: any) {
      setSaveErr(`Couldn't save: ${e.message || e}. Check your connection and try again.`);
    } finally { setSaving(false); }
  }

  const loading = !progress && !loadErr;
  const errorBox = loadErr && <div style={{ ...card, background: C.badBg, border: 'none' }}>Couldn't load your progress: {loadErr}</div>;

  // ── Course list ──
  if (!course) {
    if (courseId) return <Navigate to="/training" replace />;
    return (
      <div style={page}><Header />
        <main style={wrap}>
          <div style={eyebrow}>Training</div>
          <h1 style={h1}>Your courses</h1>
          <p style={lede}>Short courses with videos and quick checks. Your progress saves as you go.</p>
          <div style={stack}>
            {errorBox}
            {COURSES.map(c => {
              const p = progress?.[c.id]; const n = p?.done.length || 0; const total = c.modules.length;
              return (
                <Link key={c.id} to={`/training/${c.id}`} style={{ ...card, textDecoration: 'none', color: C.fg, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: display, fontWeight: 800, fontSize: 21 }}>{c.title}</span>
                    <span style={{ fontSize: 14, color: p?.finished_at ? C.good : C.muted, fontWeight: 600 }}>
                      {loading ? '…' : p?.finished_at ? '✓ Complete' : n ? `${n} of ${total} modules` : 'Not started'}
                    </span>
                  </div>
                  <span style={{ fontSize: 15, color: C.muted }}>{c.summary} About {c.modules.reduce((s, m) => s + m.mins, 0)} minutes.</span>
                  <Bar value={n} total={total} />
                </Link>
              );
            })}
          </div>
        </main>
      </div>
    );
  }

  const total = course.modules.length;
  const n = doneSet.size;
  const finishedAt = progress?.[course.id]?.finished_at;

  // ── Module ──
  if (moduleId) {
    if (!mod) return <Navigate to={`/training/${course.id}`} replace />;
    const idx = course.modules.indexOf(mod);
    const next = course.modules[idx + 1];
    const done = doneSet.has(mod.id);
    const allRight = mod.checks.every((c, i) => picks[`${mod.id}:${i}`] === c.correct);
    return (
      <div style={page}><Header />
        <main style={wrap}>
          <Link to={`/training/${course.id}`} style={{ fontSize: 14, color: C.forest }}>← {course.title}</Link>
          <div style={{ ...eyebrow, marginTop: 14 }}>Module {idx + 1} of {total} · {mod.mins} min</div>
          <h1 style={h1}>{mod.title}</h1>
          <p style={lede}>{mod.lede}</p>
          <div style={stack}>
            {mod.blocks.map((b, i) => <BlockView key={i} b={b} />)}
            {mod.checks.map((c, i) => (
              <CheckView key={i} c={c} picked={picks[`${mod.id}:${i}`]} solved={done}
                label={mod.checks.length > 1 ? `Check ${i + 1} of ${mod.checks.length}` : 'Quick check'}
                onPick={j => setPicks(p => ({ ...p, [`${mod.id}:${i}`]: j }))} />
            ))}
            {saveErr && <div style={{ ...card, background: C.badBg, border: 'none' }}>{saveErr}</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, borderTop: `1px solid ${C.line}` }}>
              <span style={{ fontSize: 15, color: C.muted }}>
                {done ? '✓ Module complete.' : allRight ? 'Nice work. Mark this module complete to save your progress.' : 'Answer the check correctly to finish this module.'}
              </span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {!done && (
                  <button type="button" style={{ ...btn, opacity: allRight && !saving ? 1 : 0.45, cursor: allRight && !saving ? 'pointer' : 'not-allowed' }}
                    disabled={!allRight || saving || !!loadErr} onClick={() => complete(course, mod)}>
                    {saving ? 'Saving…' : 'Mark complete'}
                  </button>
                )}
                <Link to={next ? `/training/${course.id}/${next.id}` : `/training/${course.id}`} style={done ? btn : ghost}>
                  {next ? `Next: ${next.title}` : 'Finish'}
                </Link>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ── Course start page ──
  const nextMod = course.modules.find(m => !doneSet.has(m.id));
  return (
    <div style={page}><Header />
      <main style={wrap}>
        <Link to="/training" style={{ fontSize: 14, color: C.forest }}>← All courses</Link>
        <div style={{ ...eyebrow, marginTop: 14 }}>{finishedAt ? 'Course complete' : `For ${course.audience.toLowerCase()}`}</div>
        <h1 style={h1}>{course.title}</h1>
        <p style={lede}>{finishedAt ? `You finished this course on ${fmtDate(finishedAt)}. Keep the pocket card in mind on every job.` : course.summary}</p>
        <div style={stack}>
          {errorBox}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: C.muted, marginBottom: 6 }}>
              <span>Your progress</span><b style={{ color: C.fg }}>{loading ? '…' : `${n} of ${total} modules`}</b>
            </div>
            <Bar value={n} total={total} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {course.modules.map((m, i) => {
              const d = doneSet.has(m.id);
              return (
                <Link key={m.id} to={`/training/${course.id}/${m.id}`} style={{ ...card, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: C.fg }}>
                  <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: display, fontWeight: 700, fontSize: 13, flexShrink: 0,
                    background: d ? C.forest : 'transparent', color: d ? '#fff' : C.muted, border: `1.5px solid ${d ? C.forest : C.line}` }}>{d ? '✓' : i + 1}</span>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: 500 }}>{m.title}</span>
                  <span style={{ fontSize: 13, color: C.muted }}>{m.mins} min</span>
                </Link>
              );
            })}
          </div>
          <div>
            {nextMod
              ? <Link to={`/training/${course.id}/${nextMod.id}`} style={btn}>{n ? 'Continue' : 'Start'}: {nextMod.title}</Link>
              : <Link to={`/training/${course.id}/${course.modules[0].id}`} style={ghost}>Review from the start</Link>}
          </div>
          <div><h3 style={h3}>Pocket card</h3><PocketCard course={course} /></div>
        </div>
      </main>
    </div>
  );
}
