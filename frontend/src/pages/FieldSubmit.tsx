/**
 * FieldSubmit.tsx — Mobile receipt submission for field crews.
 * Accessible at /field on the frontend.
 * Works on any phone browser — no app install required.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadInvoice, validatePO, listEmployees, type POValidationResult } from '../lib/api';

type DocType = 'vendor' | 'mastercard' | 'expense' | null;
type CostType = 'job' | 'overhead';
type Step = 1 | 2 | 3 | 4 | 5;

const FALLBACK_EMPLOYEES = ['Marcus Torres','Jake Willms','Devon Hicks','Priya Sandhu','Cole Beaumont'];

export default function FieldSubmit() {
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [docType, setDocType] = useState<DocType>(null);
  const [employee, setEmployee] = useState('');
  const [employees, setEmployees] = useState<string[]>(FALLBACK_EMPLOYEES);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    listEmployees().then(names => { if (names.length > 0) setEmployees(names); }).catch(() => {});
  }, []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [costType, setCostType] = useState<CostType>('job');
  const [po, setPo] = useState('');
  const [poResult, setPoResult] = useState<POValidationResult | null>(null);
  const [poValidating, setPoValidating] = useState(false);
  const [notes, setNotes] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const canProceed = () => {
    if (step === 1) return !!docType && (docType !== 'expense' || !!employee);
    if (step === 2) return !!file;
    if (step === 3) return costType === 'overhead' || !!poResult?.valid;
    if (step === 4) return true;
    return false;
  };

  const compressImage = (f: File): Promise<File> => {
    return new Promise((resolve) => {
      if (f.type === 'application/pdf' || f.size < 1.5 * 1024 * 1024) {
        resolve(f);
        return;
      }
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const MAX = 1600;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(new File([blob], f.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
          else resolve(f);
        }, 'image/jpeg', 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(f); };
      img.src = url;
    });
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const compressed = await compressImage(f);
    setFile(compressed);
    setPreviewUrl(compressed.type.startsWith('image/') ? URL.createObjectURL(compressed) : null);
  };

  const retake = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null); setPreviewUrl(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleValidatePO = useCallback(async () => {
    if (!po.trim()) return;
    setPoValidating(true); setPoResult(null);
    const result = await validatePO(po.trim());
    setPoValidating(false); setPoResult(result);
  }, [po]);

  const handleSubmit = async () => {
    if (!file) return;
    setSubmitting(true); setSubmitError(null);
    try {
      const res = await uploadInvoice(
        file, docType!, costType,
        costType === 'job' ? po : undefined,
        docType === 'expense' ? employee : undefined,
        notes || undefined,
      );
      setReferenceId(`AP-${res.invoice_id}-${Date.now().toString(36).toUpperCase()}`);
      setStep(5);
    } catch (e: unknown) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const next = () => { if (step === 4) { handleSubmit(); return; } setStep(s => (s + 1) as Step); };
  const back = () => setStep(s => (s - 1) as Step);

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setStep(1); setDocType(null); setEmployee(''); setFile(null); setPreviewUrl(null);
    setCostType('job'); setPo(''); setPoResult(null); setPoValidating(false);
    setNotes(''); setReferenceId(null); setSubmitError(null);
  };

  const stepLabels = ['Document type','Photo / upload','Job or overhead','Review & submit'];

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <span style={S.h1}>Submit Receipt</span>
          <span style={S.chip}>{employee || 'Field crew'}</span>
        </div>
        <div style={S.hsub}>Dario's Landscape Services</div>
      </div>

      {/* Progress */}
      {step < 5 && (
        <div style={S.progress}>
          <div style={S.psteps}>
            {[1,2,3,4].map(i => (
              <div key={i} style={{...S.pstep, background: i < step ? '#2563eb' : i === step ? 'rgba(37,99,235,.45)' : '#e2e6ed'}}/>
            ))}
          </div>
          <div style={S.plabel}>Step {Math.min(step,3)} of 3 — {stepLabels[step-1]}</div>
        </div>
      )}

      <div style={S.content}>

        {/* Step 1 */}
        {step === 1 && <>
          <div style={S.card}>
            <div style={S.ctitle}>What are you submitting?</div>
            <div style={S.docgrid}>
              {([
                {t:'vendor',icon:'🧾',label:'Vendor Invoice',sub:'Bill from supplier'},
                {t:'mastercard',icon:'💳',label:'MC Receipt',sub:'Company card purchase'},
                {t:'expense',icon:'🧑',label:'My Expense',sub:'Personal card / cash'},
              ] as {t:DocType,icon:string,label:string,sub:string}[]).map(o => (
                <button key={o.t} style={{...S.dt,...(docType===o.t?S.dtsel:{})}} onClick={()=>{setDocType(o.t);setEmployee('');}}>
                  <span style={{fontSize:28,display:'block',marginBottom:6}}>{o.icon}</span>
                  <div style={S.dlabel}>{o.label}</div>
                  <div style={S.dsub}>{o.sub}</div>
                </button>
              ))}
            </div>
          </div>
          {docType === 'expense' && (
            <div style={S.card}>
              <div style={S.ctitle}>Your name</div>
              <select style={S.sel} value={employee} onChange={e=>setEmployee(e.target.value)}>
                <option value="">Select your name...</option>
                {employees.map(e=><option key={e}>{e}</option>)}
              </select>
            </div>
          )}
        </>}

        {/* Step 2 */}
        {step === 2 && <>
          <div style={S.card}>
            <div style={S.ctitle}>Take a photo or upload</div>
            {!file ? (
              <div style={S.uparea} onClick={()=>fileRef.current?.click()}>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" onChange={handleFile} style={{display:'none'}}/>
                <span style={{fontSize:40,display:'block',marginBottom:8}}>📷</span>
                <div style={S.uptitle}>Tap to take photo</div>
                <div style={S.upsub}>or upload from gallery · PDF or image</div>
              </div>
            ) : (
              <div style={S.updone}>
                {previewUrl && <img src={previewUrl} alt="Receipt" style={S.preview}/>}
                <div style={{fontSize:13,color:'#059669',fontWeight:600,marginBottom:4}}>✓ {file.name}</div>
                <div style={{fontSize:12,color:'#6b7280'}}>{(file.size/1024).toFixed(0)} KB</div>
                <button style={S.retake} onClick={retake}>Retake photo</button>
              </div>
            )}
          </div>
          <div style={S.tip}><strong>Tips:</strong> lay the receipt flat, ensure all text is visible, avoid shadows.</div>
        </>}

        {/* Step 3 */}
        {step === 3 && <>
          <div style={S.card}>
            <div style={S.ctitle}>Is this for a job or overhead?</div>
            <div style={S.toggle}>
              <button style={{...S.topt,...(costType==='job'?S.tactive:{})}} onClick={()=>{setCostType('job');setPoResult(null);}}>
                <span style={{fontSize:18,display:'block',marginBottom:2}}>🏗️</span>Job cost
              </button>
              <button style={{...S.topt,...(costType==='overhead'?S.tactive:{})}} onClick={()=>{setCostType('overhead');setPoResult(null);}}>
                <span style={{fontSize:18,display:'block',marginBottom:2}}>🏢</span>Overhead
              </button>
            </div>

            {costType === 'job' && <>
              <div style={S.porow}>
                <input
                  style={{...S.poinput, borderColor: poResult?.valid ? '#059669' : poResult?.valid===false ? '#dc2626' : '#e2e6ed'}}
                  placeholder="e.g. PO-2024-801"
                  value={po}
                  onChange={e=>{setPo(e.target.value.toUpperCase());setPoResult(null);}}
                  onKeyDown={e=>e.key==='Enter'&&handleValidatePO()}
                />
                <button style={{...S.lookup, opacity: po.length<4||poValidating?.5:1}} onClick={handleValidatePO} disabled={po.length<4||poValidating}>
                  {poValidating?'Looking...':'Look up'}
                </button>
              </div>
              <div style={{fontSize:11,color:'#6b7280',marginTop:6}}>Type your PO number then tap Look up</div>
              {poValidating && <div style={{...S.jobres,background:'#fffbeb',borderColor:'#fcd34d',marginTop:10}}><div style={{fontSize:13,color:'#92400e'}}>Checking Aspire...</div></div>}
              {poResult && !poValidating && (
                <div style={{...S.jobres, background:poResult.valid?'#ecfdf5':'#fef2f2', borderColor:poResult.valid?'#6ee7b7':'#fca5a5', marginTop:10}}>
                  <div style={{float:'right',fontSize:18}}>{poResult.valid?'✅':'❌'}</div>
                  {poResult.valid ? <>
                    <div style={{fontSize:15,fontWeight:600,marginBottom:4}}>{poResult.job_name||po}</div>
                    <div style={{fontSize:12,color:'#6b7280',lineHeight:1.7}}>
                      {poResult.job_address && <span style={{display:'block'}}>{poResult.job_address}</span>}
                      <span style={{color:'#059669',fontWeight:500}}>PO {po} — Open</span>
                    </div>
                  </> : <>
                    <div style={{fontSize:15,fontWeight:600,color:'#dc2626',marginBottom:4}}>PO not found</div>
                    <div style={{fontSize:12,color:'#6b7280'}}>{poResult.error||'Check the number and try again.'}</div>
                  </>}
                </div>
              )}
            </>}

            {costType === 'overhead' && (
              <div style={S.ohinfo}>
                <div style={{fontSize:13,fontWeight:600,color:'#92400e',marginBottom:4}}>Overhead purchase</div>
                <div style={{fontSize:12,color:'#92400e',lineHeight:1.6}}>No PO needed. The AP team will assign the correct account and post to QBO.</div>
              </div>
            )}
          </div>

          <div style={S.card}>
            <div style={S.flabel}>Notes (optional)</div>
            <input style={S.tinput} placeholder="e.g. emergency repair, office supplies" value={notes} onChange={e=>setNotes(e.target.value)}/>
          </div>
        </>}

        {/* Step 4 */}
        {step === 4 && <>
          <div style={S.card}>
            <div style={S.ctitle}>Review before submitting</div>
            {previewUrl && <img src={previewUrl} alt="Receipt" style={{...S.preview,marginBottom:12}}/>}
            <RR label="Type" value={{vendor:'Vendor Invoice',mastercard:'MasterCard Receipt',expense:'Employee Expense'}[docType!]||'—'}/>
            {docType==='expense'&&employee && <RR label="Employee" value={employee}/>}
            <RR label="Document" value={file?.name||'—'} color="#059669"/>
            <RR label="Coding" value={costType==='overhead'?'Overhead — AP team will code':'Job cost'} color={costType==='overhead'?'#d97706':'#059669'}/>
            {costType==='job' && <RR label="PO / Job" value={poResult?.job_name?`${poResult.job_name} (${po})`:po} color="#059669"/>}
            <RR label="Notes" value={notes||'—'}/>
          </div>
          {costType==='overhead' && <div style={S.tip}>The AP team will assign the correct GL account and post this to QBO.</div>}
          <div style={{...S.tip,background:'#eff6ff',borderColor:'#bfdbfe',color:'#1e40af'}}>Claude will extract the vendor, amount, and tax automatically.</div>
          {submitError && <div style={{...S.tip,background:'#fef2f2',borderColor:'#fca5a5',color:'#dc2626'}}>{submitError}</div>}
        </>}

        {/* Step 5 */}
        {step === 5 && (
          <div style={S.success}>
            <span style={{fontSize:64,display:'block',marginBottom:16}}>✅</span>
            <div style={S.stitle}>Receipt submitted!</div>
            <div style={S.ssub}>
              {costType==='overhead'
                ?'Sent to the AP queue as overhead. The team will assign the GL account and post to QBO.'
                :'Sent to the AP queue. Your PO has been confirmed and the team will post to Aspire.'}
            </div>
            {referenceId && <div style={S.ref}>{referenceId}</div>}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={S.bar}>
        {step===5 ? (
          <button style={S.bsuccess} onClick={reset}>Submit another receipt</button>
        ) : <>
          <button style={{...S.bprimary,opacity:canProceed()&&!submitting?1:.4}} onClick={next} disabled={!canProceed()||submitting}>
            {submitting?'Submitting...':step===4?'Submit receipt':'Continue'}
          </button>
          {step>1 && <button style={S.bback} onClick={back}>← Back</button>}
        </>}
      </div>
    </div>
  );
}

function RR({label,value,color}:{label:string,value:string,color?:string}) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderBottom:'1px solid #e2e6ed'}}>
      <span style={{fontSize:12,color:'#6b7280',fontWeight:500,flexShrink:0}}>{label}</span>
      <span style={{fontSize:13,fontWeight:500,textAlign:'right',maxWidth:220,color:color||'#1a1d23'}}>{value}</span>
    </div>
  );
}

const S: Record<string,React.CSSProperties> = {
  phone:{maxWidth:430,margin:'0 auto',minHeight:'100vh',background:'#f4f6f9',display:'flex',flexDirection:'column',fontFamily:"'DM Sans',sans-serif"},
  header:{background:'#2563eb',color:'#fff',padding:'16px 20px 20px',flexShrink:0},
  headerTop:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4},
  h1:{fontSize:20,fontWeight:600},hsub:{fontSize:13,opacity:.8},
  chip:{background:'rgba(255,255,255,.2)',borderRadius:20,padding:'4px 12px',fontSize:12,fontWeight:500},
  progress:{padding:'16px 20px 0',flexShrink:0},
  psteps:{display:'flex',gap:6,marginBottom:6},
  pstep:{flex:1,height:4,borderRadius:2,transition:'background .3s'},
  plabel:{fontSize:12,color:'#6b7280',fontWeight:500},
  content:{flex:1,padding:'16px 20px',overflowY:'auto'},
  card:{background:'#fff',border:'1px solid #e2e6ed',borderRadius:12,padding:16,marginBottom:12},
  ctitle:{fontSize:13,fontWeight:600,color:'#6b7280',textTransform:'uppercase',letterSpacing:'.04em',marginBottom:12},
  docgrid:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8},
  dt:{border:'2px solid #e2e6ed',borderRadius:10,padding:'14px 10px',textAlign:'center',cursor:'pointer',background:'#fff',transition:'all .15s'},
  dtsel:{borderColor:'#2563eb',background:'#eff6ff'},
  dlabel:{fontSize:12,fontWeight:600,color:'#1a1d23'},dsub:{fontSize:11,color:'#6b7280',marginTop:2},
  sel:{width:'100%',padding:12,border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:14,color:'#1a1d23',background:'#fff',outline:'none',fontFamily:'inherit'},
  uparea:{border:'2px dashed #e2e6ed',borderRadius:12,padding:'32px 20px',textAlign:'center',cursor:'pointer',background:'#f4f6f9'},
  uptitle:{fontSize:15,fontWeight:600,color:'#1a1d23',marginBottom:4},upsub:{fontSize:12,color:'#6b7280'},
  updone:{background:'#ecfdf5',border:'1.5px solid #6ee7b7',borderRadius:10,padding:14,textAlign:'center'},
  preview:{width:'100%',borderRadius:8,maxHeight:200,objectFit:'cover',display:'block'},
  retake:{marginTop:8,fontSize:12,color:'#2563eb',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:500},
  tip:{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:10,padding:12,fontSize:12,color:'#92400e',lineHeight:1.6,marginBottom:12},
  toggle:{display:'flex',background:'#f4f6f9',border:'1.5px solid #e2e6ed',borderRadius:10,padding:4,marginBottom:16},
  topt:{flex:1,padding:'10px 8px',textAlign:'center',borderRadius:7,cursor:'pointer',fontSize:13,fontWeight:500,color:'#6b7280',background:'transparent',border:'none',fontFamily:'inherit',transition:'all .2s'},
  tactive:{background:'#2563eb',color:'#fff'},
  porow:{display:'flex',gap:8},
  poinput:{flex:1,padding:'12px 14px',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:16,color:'#1a1d23',outline:'none',fontFamily:'inherit',letterSpacing:'.05em',background:'#fff'},
  lookup:{padding:'12px 16px',background:'#2563eb',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap',fontFamily:'inherit'},
  jobres:{borderRadius:10,padding:14,border:'1.5px solid',overflow:'hidden'},
  ohinfo:{background:'#fffbeb',border:'1.5px solid #fde68a',borderRadius:10,padding:14},
  flabel:{fontSize:12,fontWeight:600,color:'#6b7280',marginBottom:6,textTransform:'uppercase',letterSpacing:'.04em'},
  tinput:{width:'100%',padding:'12px 14px',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:15,color:'#1a1d23',outline:'none',fontFamily:'inherit',background:'#fff',boxSizing:'border-box'},
  success:{textAlign:'center',padding:'40px 20px'},
  stitle:{fontSize:22,fontWeight:600,marginBottom:8},
  ssub:{fontSize:14,color:'#6b7280',lineHeight:1.6,marginBottom:24},
  ref:{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:12,fontSize:13,color:'#2563eb',fontWeight:500,marginBottom:24},
  bar:{padding:'16px 20px',background:'#fff',borderTop:'1px solid #e2e6ed',flexShrink:0},
  bprimary:{width:'100%',padding:16,background:'#2563eb',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'block'},
  bback:{width:'100%',padding:12,background:'none',border:'none',fontSize:14,color:'#6b7280',cursor:'pointer',marginTop:8,fontFamily:'inherit'},
  bsuccess:{width:'100%',padding:16,background:'#059669',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
};
