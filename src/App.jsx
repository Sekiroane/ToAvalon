import { useState, useCallback, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = "https://oqsxhlxxtyauwueoiaoi.supabase.co";
const SUPABASE_KEY  = "sb_publishable_SVzWas_UkQ7CI9hgpAW8Jg_uROCt9eu";
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

const FF   = "-apple-system,'SF Pro Display','SF Pro Text','Helvetica Neue',sans-serif";
const fmt  = (v) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(v||0);
const fmtCompact = (v) => {
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v/1e6).toFixed(2)+"M";
  if (abs >= 1e3) return (v/1e3).toFixed(1)+"K";
  return fmt(v);
};
const parseNum = (s) => parseFloat(String(s).replace(/[^0-9.-]/g,""))||0;
const mkId     = () => Math.random().toString(36).slice(2,10);

const GOLD  = "#c8a050";
const GOLD2 = "#8b6520";
const TIP_URL = "https://paypal.me/toavalon";

// ─── Supabase data helpers ────────────────────────────────────────────────────
async function dbLoad(userId) {
  const { data, error } = await supabase
    .from("portfolios")
    .select("data")
    .eq("user_id", userId)
    .single();
  if (error || !data) return null;
  return data.data;
}

async function dbSave(userId, portfolio) {
  await supabase
    .from("portfolios")
    .upsert({ user_id: userId, data: portfolio, updated_at: new Date().toISOString() },
             { onConflict: "user_id" });
}

const ASSET_CATS = ["Cash & Savings","Stocks / ETFs","Crypto","Real Estate","Vehicles","Retirement","Business","Other"];
const DEBT_CATS  = ["Mortgage","Auto Loan","Student Loan","Credit Card","Personal Loan","Business Debt","Other"];
const blankItem  = (type) => ({id:mkId(),label:"",value:"",qty:"",rate:"",holdings:[],category:type==="asset"?ASSET_CATS[0]:DEBT_CATS[0],liveStatus:"idle",liveNote:""});
const stripLive  = (items) => items.map(i=>({...i,liveStatus:"idle",liveNote:""}));

const EXPENSE_CATS = ["Housing","Transport","Food","Utilities","Insurance","Subscriptions","Healthcare","Personal","Savings / Invest","Other"];
const blankIncome  = () => ({id:mkId(), label:"", amount:""});
const blankExpense = () => ({id:mkId(), label:"", amount:"", category:"Housing"});
const blankWallet  = () => ({id:mkId(), label:"", address:"", holdings:[], value:"", liveStatus:"idle", liveNote:""});
const blankWalletHolding = () => ({id:mkId(), ticker:"", qty:"", price:"", value:""});

// Categories that display a rate field and their label
const RATE_LABEL = {
  "Cash & Savings": "APY",
  "Mortgage":       "APR",
  "Auto Loan":      "APR",
  "Student Loan":   "APR",
  "Credit Card":    "APR",
  "Personal Loan":  "APR",
  "Business Debt":  "APR",
};

// ─── API helpers ──────────────────────────────────────────────────────────────
async function fetchLive(label,category,qty) {
  const q = qty&&parseFloat(qty)>0?` (quantity: ${qty})`:"";
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user",content:`Portfolio asset value lookup:
Label: "${label}"${q}, Category: "${category}"
- Stock/ETF ticker → current price × qty; Crypto → USD price × qty
- Real estate address → Zillow/Redfin estimate; Vehicle → KBB value
Reply ONLY with valid JSON no markdown: {"value":<number>,"source":"<src>","note":"<one line>","asOf":"<date>"}`}],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message||"API error");
  const text = (data.content||[]).map(b=>b.type==="text"?b.text:"").join("").trim();
  const m = text.replace(/```json|```/gi,"").match(/\{[\s\S]*?\}/);
  if (!m) throw new Error("Could not parse price data");
  return JSON.parse(m[0]);
}

async function fetchWallet(input) {
  const q       = input.trim();
  const isENS   = /\.eth$/i.test(q);

  const prompt  = `You are a blockchain data assistant. Look up this wallet using web search: "${q}"

Tasks:
${isENS ? `1. Search etherscan.io to resolve ENS name "${q}" to an Ethereum 0x address.` : `1. The input is already an Ethereum address: ${q}`}
2. Search etherscan.io for the ETH balance (search "site:etherscan.io ${q}").
3. Search etherscan.io/tokenholdings for the top ERC-20 token holdings by USD value (up to 8 tokens).
4. Note major NFT collections if visible.

IMPORTANT: Your FINAL message must contain ONLY a raw JSON object — no prose, no markdown fences, no explanation. Start your final message with { and end with }.

JSON schema (use exact field names, numbers not strings for numeric values):
{"address":"0x...","ens":${isENS?`"${q}"`:"null"},"ethBalance":0.0,"ethUsd":0.0,"tokens":[{"symbol":"USDC","name":"USD Coin","balance":100.0,"usdValue":100.0}],"nfts":[{"collection":"CryptoPunks","count":1}],"source":"etherscan.io","asOf":"2026-02-21"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:2500,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:[{role:"user", content:prompt}],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "API error");

  // web_search returns a mix of text / tool_use / tool_result blocks.
  // The model's final answer is always in the LAST text block.
  const textBlocks = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text.trim())
    .filter(Boolean);

  if (!textBlocks.length) throw new Error("No response received from API.");

  // Walk from last block to first — find the one containing valid wallet JSON
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const raw   = textBlocks[i].replace(/```json|```/gi, "");
    const start = raw.indexOf("{");
    const end   = raw.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed.address || parsed.ethBalance !== undefined || parsed.tokens) {
        return parsed;
      }
    } catch { /* malformed — try next */ }
  }

  throw new Error("Could not extract wallet data from response. Try again or check the address is valid.");
}

// ─── Brand ────────────────────────────────────────────────────────────────────
function AppleMark({size=28,glow=false}) {
  return (
    <svg width={size} height={size*32/28} viewBox="0 0 28 32" fill="none"
         style={glow?{filter:`drop-shadow(0 0 10px ${GOLD}55)`}:{}}>
      <path d="M14 8 Q17 3.5 20 3" stroke={GOLD} strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M14 8 C9 6,1 10,1 18 C1 26,6.5 32,14 32 C21.5 32,27 26,27 18 C27 10,19 6,14 8 Z"
        stroke={GOLD} strokeWidth="1.4" fill="rgba(200,160,80,0.09)" strokeLinejoin="round"/>
      <path d="M10.5 9.5 Q14 7.5 17.5 9.5"
        stroke="rgba(200,160,80,0.45)" strokeWidth="1.1" strokeLinecap="round" fill="none"/>
    </svg>
  );
}
function Wordmark({size="md"}) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:size==="lg"?10:7}}>
      <AppleMark size={size==="lg"?38:24} glow={size==="lg"}/>
      <span style={{fontSize:size==="lg"?30:18,fontWeight:700,letterSpacing:"-.04em",
        background:`linear-gradient(135deg,#e8c878 0%,${GOLD} 50%,#a07030 100%)`,
        WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text",
      }}>ToAvalon</span>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ic = {
  Spin:    ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{animation:"spin .9s linear infinite",display:"block"}}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>,
  Check:   ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
  Warn:    ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  Mag:     ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Trash:   ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>,
  Plus:    ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Chev:    ()=><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>,
  X:       ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  EyeOn:   ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  EyeOff:  ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  Desktop: ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
  Mobile:  ()=><svg width="13" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18" strokeWidth="2.5" strokeLinecap="round"/></svg>,
  // Bottom nav icons
  Home:    ()=><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12l9-9 9 9"/><path d="M9 21V12h6v9"/><path d="M5 10v11h14V10"/></svg>,
  Wallet:  ()=><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 14a1 1 0 1 0 2 0 1 1 0 0 0-2 0z" fill="currentColor"/><path d="M2 10h20"/><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/></svg>,
  Cog:     ()=><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  Grip:    ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="9" y1="6" x2="9" y2="6"/><line x1="15" y1="6" x2="15" y2="6"/><line x1="9" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="15" y2="12"/><line x1="9" y1="18" x2="9" y2="18"/><line x1="15" y1="18" x2="15" y2="18"/></svg>,
  Chain:   ()=><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
};

// ─── View Toggle ─────────────────────────────────────────────────────────────
// Lives in nav bar — exactly where Figma, Chrome DevTools, Vercel put view switchers
function ViewToggle({isMobile, onToggle}) {
  return (
    <div style={{display:"flex",background:"rgba(255,255,255,.06)",borderRadius:8,padding:3,gap:2}}>
      {[
        [false, <Ic.Desktop/>, "Desktop"],
        [true,  <Ic.Mobile/>,  "Mobile"],
      ].map(([val, icon, label]) => (
        <div key={label} onClick={()=>onToggle(val)}
          title={label}
          style={{
            width:30,height:28,display:"flex",alignItems:"center",justifyContent:"center",
            borderRadius:6,cursor:"pointer",userSelect:"none",transition:"all .18s",
            background: isMobile===val ? "rgba(200,160,80,.18)" : "transparent",
            color: isMobile===val ? GOLD : "#48484a",
          }}
          onMouseEnter={e=>{ if(isMobile!==val) e.currentTarget.style.color="#888"; }}
          onMouseLeave={e=>{ if(isMobile!==val) e.currentTarget.style.color="#48484a"; }}>
          {icon}
        </div>
      ))}
    </div>
  );
}

// ─── Shared Modals ────────────────────────────────────────────────────────────

function ExportModal({jsonStr, filename, onClose}) {
  const [copied,       setCopied]       = useState(false);
  const [openedWindow, setOpenedWindow] = useState(false);

  // window.open with a data URI — opens a new tab showing raw JSON.
  // User can Ctrl+S / Cmd+S to save it as a .json file.
  const openInNewTab = () => {
    const uri = "data:application/json;charset=utf-8," + encodeURIComponent(jsonStr);
    const win = window.open(uri, "_blank");
    if (win) {
      setOpenedWindow(true);
    } else {
      // Pop-up was blocked — fall through to clipboard
      alert("Pop-up blocked. Use the Copy button below instead.");
    }
  };

  const copyToClipboard = () => {
    const ta = document.getElementById("tav-export-ta");
    // Try modern API first, fall back to execCommand
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(jsonStr).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 2500);
      }).catch(() => {
        if (ta) { ta.select(); document.execCommand("copy"); }
        setCopied(true); setTimeout(() => setCopied(false), 2500);
      });
    } else {
      if (ta) { ta.select(); document.execCommand("copy"); }
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.75)",backdropFilter:"blur(14px)"}} onClick={onClose}/>
      <div style={{position:"relative",width:"100%",maxWidth:480,zIndex:1,animation:"modalIn .25s ease both"}}>
        <div onClick={onClose}
          style={{position:"absolute",top:-14,right:-14,width:32,height:32,borderRadius:"50%",background:"rgba(30,26,22,.95)",border:"1px solid rgba(200,160,80,.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#6b6050",zIndex:2}}
          onMouseEnter={e=>e.currentTarget.style.color=GOLD} onMouseLeave={e=>e.currentTarget.style.color="#6b6050"}>
          <Ic.X/>
        </div>
        <div style={{background:"rgba(18,16,14,.98)",border:"1px solid rgba(200,160,80,.18)",borderRadius:20,padding:24,display:"flex",flexDirection:"column",gap:14}}>

          <div>
            <div style={{fontSize:17,fontWeight:700,color:"#f0ece4",marginBottom:4}}>Export Portfolio</div>
            <div style={{fontSize:13,color:"#6b6050",lineHeight:1.5}}>
              Save your data so you can restore it any time.
            </div>
          </div>

          {/* Primary — open JSON in new tab, Ctrl+S to save */}
          <div onClick={openInNewTab}
            style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,
              background:openedWindow?`rgba(48,209,88,.15)`:`linear-gradient(135deg,${GOLD2},${GOLD})`,
              border:openedWindow?"1px solid rgba(48,209,88,.35)":"none",
              borderRadius:12,color:openedWindow?"#30d158":"#1a1208",fontSize:15,fontWeight:700,
              fontFamily:FF,padding:"13px",cursor:"pointer",
              transition:"all .2s",userSelect:"none"}}
            onMouseDown={e=>{e.currentTarget.style.opacity=".85";e.currentTarget.style.transform="scale(.98)"}}
            onMouseUp={e=>{e.currentTarget.style.opacity="1";e.currentTarget.style.transform="scale(1)"}}
            onMouseLeave={e=>{e.currentTarget.style.opacity="1";e.currentTarget.style.transform="scale(1)"}}>
            {openedWindow ? "✓ Opened in new tab" : "⬇ Download " + filename}
          </div>

          {/* Instruction shown after opening */}
          {openedWindow && (
            <div style={{background:"rgba(48,209,88,.07)",border:"1px solid rgba(48,209,88,.15)",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#4aaa6a",lineHeight:1.6,textAlign:"center"}}>
              In the new tab: press <strong>Ctrl+S</strong> (Windows) or <strong>⌘+S</strong> (Mac) to save the file.
            </div>
          )}

          {/* Divider */}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{flex:1,height:1,background:"rgba(200,160,80,.1)"}}/>
            <span style={{fontSize:11,color:"#48484a"}}>or copy to clipboard</span>
            <div style={{flex:1,height:1,background:"rgba(200,160,80,.1)"}}/>
          </div>

          {/* Copyable textarea */}
          <textarea
            id="tav-export-ta"
            readOnly
            value={jsonStr}
            style={{width:"100%",height:110,background:"rgba(255,255,255,.04)",
              border:"1px solid rgba(200,160,80,.15)",borderRadius:10,
              color:"#6b6050",fontSize:11,fontFamily:"monospace",
              padding:"10px 12px",resize:"none",outline:"none",
              boxSizing:"border-box",lineHeight:1.5}}
            onFocus={e=>e.target.select()}
          />

          <div onClick={copyToClipboard}
            style={{background:copied?"rgba(48,209,88,.12)":"rgba(200,160,80,.1)",
              border:`1px solid ${copied?"rgba(48,209,88,.3)":"rgba(200,160,80,.2)"}`,
              borderRadius:10,color:copied?"#30d158":GOLD,
              fontSize:14,fontWeight:600,fontFamily:FF,
              padding:"11px",cursor:"pointer",textAlign:"center",
              userSelect:"none",transition:"all .2s"}}>
            {copied ? "✓ Copied! Paste into a .txt file and rename to .json" : "Copy to Clipboard"}
          </div>

        </div>
      </div>
    </div>
  );
}


function TipModal({onClose}) {
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=120e0a&color=c8a050&qzone=2&data=${encodeURIComponent(TIP_URL)}`;
  return (
    <div style={{position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.75)",backdropFilter:"blur(14px)"}} onClick={onClose}/>
      <div style={{position:"relative",width:"100%",maxWidth:320,zIndex:1,animation:"modalIn .25s ease both"}}>
        <div onClick={onClose} style={{position:"absolute",top:-14,right:-14,width:32,height:32,borderRadius:"50%",background:"rgba(30,26,22,.95)",border:"1px solid rgba(200,160,80,.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#6b6050",zIndex:2}} onMouseEnter={e=>e.currentTarget.style.color=GOLD} onMouseLeave={e=>e.currentTarget.style.color="#6b6050"}><Ic.X/></div>
        <div style={{background:"rgba(18,16,14,.98)",border:"1px solid rgba(200,160,80,.2)",borderRadius:20,padding:"28px 24px 24px",display:"flex",flexDirection:"column",alignItems:"center",gap:20}}>
          <div style={{textAlign:"center"}}><div style={{fontSize:22,marginBottom:6}}>🍎</div><div style={{fontSize:18,fontWeight:700,color:"#f0ece4",letterSpacing:"-.02em"}}>Leave a tip</div><div style={{fontSize:13,color:"#6b6050",marginTop:4,lineHeight:1.5}}>If ToAvalon has been useful,<br/>a small tip keeps the isle alive.</div></div>
          <div style={{background:"#120e0a",border:"1px solid rgba(200,160,80,.15)",borderRadius:14,padding:12}}><img src={qrSrc} alt="Tip QR" width={180} height={180} style={{display:"block",borderRadius:6}}/></div>
          <div style={{fontSize:12,color:"#5a5040",textAlign:"center"}}>Scan with your phone camera</div>
          <div style={{width:"100%",background:"rgba(200,160,80,.08)",border:"1px solid rgba(200,160,80,.15)",borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
            <span style={{fontSize:12,color:"#8a7040",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{TIP_URL}</span>
            <div onClick={()=>{try{navigator.clipboard.writeText(TIP_URL);}catch{}}} style={{fontSize:11,color:GOLD,cursor:"pointer",flexShrink:0,userSelect:"none"}} onMouseEnter={e=>e.currentTarget.style.opacity=".7"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>Copy</div>
          </div>
          <div onClick={()=>{try{window.open(TIP_URL,"_blank");}catch{}}} style={{width:"100%",boxSizing:"border-box",background:`linear-gradient(135deg,${GOLD2},${GOLD})`,borderRadius:12,color:"#1a1208",fontSize:15,fontWeight:700,fontFamily:FF,padding:13,cursor:"pointer",textAlign:"center",userSelect:"none"}} onMouseDown={e=>{e.currentTarget.style.opacity=".85";e.currentTarget.style.transform="scale(.98)"}} onMouseUp={e=>{e.currentTarget.style.opacity="1";e.currentTarget.style.transform="scale(1)"}} onMouseLeave={e=>{e.currentTarget.style.opacity="1";e.currentTarget.style.transform="scale(1)"}}>Open Tip Page ↗</div>
        </div>
      </div>
    </div>
  );
}

// ─── Wallets Panel ────────────────────────────────────────────────────────────
function WalletsPanel({wallets, onAdd, onUpdate, onRemove, onReorder, mobile=false}) {
  const p = mobile ? 16 : 24;
  const dragIdx = useRef(null);
  const [overIdx, setOverIdx] = useState(null);

  const handleDragStart = (i) => { dragIdx.current = i; };
  const handleDragEnter = (i) => { if (i !== dragIdx.current) setOverIdx(i); };
  const handleDragEnd   = ()  => {
    if (dragIdx.current !== null && overIdx !== null && dragIdx.current !== overIdx)
      onReorder(dragIdx.current, overIdx);
    dragIdx.current = null; setOverIdx(null);
  };

  const totalAll = wallets.reduce((s,w)=>s+parseNum(w.value),0);

  return (
    <div style={{marginBottom:16}}>
      {/* Header bar */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div>
          <div style={{fontSize:16,fontWeight:600,color:"#f0ece4",letterSpacing:"-.01em"}}>Wallets</div>
          <div style={{fontSize:11,color:"#4a4040",marginTop:2}}>{wallets.length} wallet{wallets.length!==1?"s":""} · drag ⠿ to reorder</div>
        </div>
        {totalAll>0&&<div style={{fontSize:18,fontWeight:700,color:"#bf5af2",letterSpacing:"-.02em"}}>{fmt(totalAll)}</div>}
      </div>

      {/* Wallet cards */}
      {wallets.map((w,i)=>(
        <WalletCard key={w.id} wallet={w} index={i}
          onUpdate={onUpdate} onRemove={onRemove}
          onDragStart={()=>handleDragStart(i)}
          onDragEnter={()=>handleDragEnter(i)}
          onDragEnd={handleDragEnd}
          isDragOver={overIdx===i}
          mobile={mobile}
        />
      ))}

      {/* Add wallet */}
      <div onClick={onAdd}
        style={{display:"flex",alignItems:"center",gap:9,color:GOLD,fontSize:14,fontFamily:FF,
                padding:"14px 0",cursor:"pointer",userSelect:"none",transition:"opacity .15s"}}
        onMouseEnter={e=>e.currentTarget.style.opacity=".7"}
        onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <div style={{width:20,height:20,borderRadius:"50%",background:"rgba(200,160,80,.12)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic.Plus/></div>
        Add Wallet
      </div>
    </div>
  );
}

function WalletCard({wallet, index, onUpdate, onRemove, onDragStart, onDragEnter, onDragEnd, isDragOver, mobile=false}) {
  const [open, setOpen] = useState(()=>(wallet.holdings||[]).length>0||!!wallet.address);
  const holdings = wallet.holdings || [];
  const p = mobile ? 0 : 0;

  // Holdings CRUD
  const updateHolding = (hid, field, val) => {
    const next = holdings.map(h => {
      if (h.id !== hid) return h;
      const updated = {...h, [field]: val};
      const q = parseFloat(field==="qty"?val:updated.qty)||0;
      const pr = parseFloat(field==="price"?val:updated.price)||0;
      if (q>0 && pr>0) updated.value = String(Math.round(q*pr));
      return updated;
    });
    // Rollup total
    const sum = next.reduce((s,h)=>{
      const q = parseFloat(h.qty)||0;
      const pr = parseFloat(h.price)||0;
      return s + (q>0&&pr>0 ? q*pr : parseNum(h.value));
    },0);
    onUpdate(wallet.id, "holdings", next);
    if (sum>0) onUpdate(wallet.id, "value", String(Math.round(sum)));
  };
  const addHolding    = () => onUpdate(wallet.id, "holdings", [...holdings, blankWalletHolding()]);
  const removeHolding = (hid) => {
    const next = holdings.filter(h=>h.id!==hid);
    onUpdate(wallet.id, "holdings", next);
    const sum = next.reduce((s,h)=>{
      const q=parseFloat(h.qty)||0, pr=parseFloat(h.price)||0;
      return s+(q>0&&pr>0?q*pr:parseNum(h.value));
    },0);
    if (next.length===0) onUpdate(wallet.id,"value","");
    else if (sum>0) onUpdate(wallet.id,"value",String(Math.round(sum)));
  };

  const iStyle = (color="#f0ece4",w="100%") => ({
    background:"rgba(255,255,255,.05)",border:"none",
    borderBottom:"1px solid rgba(200,160,80,.12)",outline:"none",
    color,fontSize:12,fontFamily:FF,padding:"5px 8px",
    borderRadius:"4px 4px 0 0",width:w,transition:"border-color .2s",
  });
  const fg = e=>e.target.style.borderBottomColor="rgba(200,160,80,.4)";
  const fb = e=>e.target.style.borderBottomColor="rgba(200,160,80,.12)";

  const isRolledUp = holdings.length>0 && parseNum(wallet.value)>0;
  const gap = 8;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={e=>e.preventDefault()}
      style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.1)",
              borderRadius:16,overflow:"hidden",marginBottom:10,
              borderTop:isDragOver?`2px solid ${GOLD}`:"2px solid transparent",
              transition:"border-color .1s",position:"relative"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:2,
                   background:"linear-gradient(90deg,#bf5af288,#bf5af222)"}}/>

      {/* Card header row */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"14px 16px 12px",paddingTop:16}}>
        {/* Drag handle */}
        <div style={{color:"#3a3530",cursor:"grab",display:"flex",alignItems:"center",flexShrink:0,transition:"color .15s"}}
          onMouseEnter={e=>e.currentTarget.style.color="#6b6050"}
          onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
          <Ic.Grip/>
        </div>
        {/* Wallet name */}
        <input value={wallet.label} onChange={e=>onUpdate(wallet.id,"label",e.target.value)}
          placeholder="Wallet name (e.g. MetaMask, Ledger)…"
          style={{flex:1,background:"transparent",border:"none",outline:"none",
                  color:"#f0ece4",fontSize:15,fontFamily:FF,minWidth:0,fontWeight:500}}/>
        {/* Chevron toggle */}
        <div onClick={()=>setOpen(p=>!p)}
          style={{flexShrink:0,color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",
                  padding:"2px 4px",borderRadius:4,transition:"color .15s, transform .2s",
                  transform:open?"rotate(180deg)":"rotate(0deg)"}}
          onMouseEnter={e=>e.currentTarget.style.color=GOLD}
          onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
          <Ic.Chev/>
        </div>
        {/* Total value */}
        <div style={{position:"relative",flexShrink:0}}>
          <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
          <input value={wallet.value}
            onChange={e=>{ if(!isRolledUp) onUpdate(wallet.id,"value",e.target.value); }}
            readOnly={isRolledUp}
            placeholder="0" type="text" inputMode="numeric"
            title={isRolledUp?"Sum of holdings — edit positions below":""}
            style={{width:130,background:isRolledUp?"rgba(191,90,242,.08)":"rgba(255,255,255,.06)",
                    border:"none",outline:"none",borderRadius:8,
                    color:"#bf5af2",fontSize:14,fontFamily:FF,
                    padding:"7px 8px 7px 20px",textAlign:"right",
                    cursor:isRolledUp?"default":"text"}}/>
          {isRolledUp&&<span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#bf5af255",pointerEvents:"none"}}>Σ</span>}
        </div>
        {/* Delete */}
        <div onClick={()=>onRemove(wallet.id)}
          style={{color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",
                  padding:4,borderRadius:6,transition:"color .15s",flexShrink:0}}
          onMouseEnter={e=>e.currentTarget.style.color="#ff6b6b"}
          onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
          <Ic.Trash/>
        </div>
      </div>

      {/* Collapsible details */}
      {open&&(
        <div style={{padding:"0 16px 14px"}}>
          {/* Address field */}
          <input value={wallet.address}
            onChange={e=>onUpdate(wallet.id,"address",e.target.value)}
            placeholder="0x address or ENS name (optional)…"
            autoComplete="off" autoCapitalize="off" spellCheck={false}
            style={{width:"100%",background:"rgba(255,255,255,.03)",border:"none",
                    borderBottom:"1px solid rgba(200,160,80,.1)",outline:"none",
                    color:"#6b6050",fontSize:11,fontFamily:"monospace",
                    padding:"5px 4px",marginBottom:12,transition:"border-color .2s"}}
            onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.35)"}
            onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.1)"}/>

          {/* Holdings header */}
          {holdings.length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 60px 80px 90px 18px",gap,alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase"}}>Ticker</span>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"center"}}>Units</span>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"right"}}>Price</span>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"right"}}>Value</span>
              <span/>
            </div>
          )}

          {/* Holding rows */}
          {holdings.map(h=>{
            const calcVal = (parseFloat(h.qty)||0)*(parseFloat(h.price)||0);
            const show = calcVal>0;
            return (
              <div key={h.id} style={{display:"grid",gridTemplateColumns:"1fr 60px 80px 90px 18px",gap,alignItems:"center",marginBottom:4}}>
                <input value={h.ticker} onChange={e=>updateHolding(h.id,"ticker",e.target.value)}
                  placeholder="BTC, ETH…"
                  style={{...iStyle("#d4b870"),textTransform:"uppercase"}}
                  onFocus={fg} onBlur={fb}/>
                <input value={h.qty} onChange={e=>updateHolding(h.id,"qty",e.target.value)}
                  placeholder="0" type="text" inputMode="decimal"
                  style={{...iStyle("#98989f"),textAlign:"center"}}
                  onFocus={fg} onBlur={fb}/>
                <div style={{position:"relative"}}>
                  <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
                  <input value={h.price||""} onChange={e=>updateHolding(h.id,"price",e.target.value)}
                    placeholder="0.00" type="text" inputMode="decimal"
                    style={{...iStyle("#98989f"),paddingLeft:18,textAlign:"right"}}
                    onFocus={fg} onBlur={fb}/>
                </div>
                <div style={{position:"relative"}}>
                  <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
                  <input value={show?String(Math.round(calcVal)):h.value}
                    onChange={e=>{ if(!show) updateHolding(h.id,"value",e.target.value); }}
                    placeholder="0" type="text" inputMode="numeric" readOnly={show}
                    style={{...iStyle("#bf5af2"),paddingLeft:18,textAlign:"right",
                            background:show?"rgba(191,90,242,.06)":"rgba(255,255,255,.05)",
                            cursor:show?"default":"text"}}
                    onFocus={fg} onBlur={fb}/>
                </div>
                <div onClick={()=>removeHolding(h.id)}
                  style={{color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"color .15s"}}
                  onMouseEnter={e=>e.currentTarget.style.color="#ff6b6b"}
                  onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
                  <Ic.X/>
                </div>
              </div>
            );
          })}

          {/* Add token */}
          <div onClick={addHolding}
            style={{display:"flex",alignItems:"center",gap:5,marginTop:holdings.length>0?6:0,
                    color:"#4a4030",cursor:"pointer",userSelect:"none",transition:"color .15s",width:"fit-content"}}
            onMouseEnter={e=>e.currentTarget.style.color=GOLD}
            onMouseLeave={e=>e.currentTarget.style.color="#4a4030"}>
            <div style={{width:14,height:14,borderRadius:"50%",background:"rgba(200,160,80,.1)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic.Plus/></div>
            <span style={{fontSize:11,fontFamily:FF,letterSpacing:".02em"}}>Add token</span>
          </div>
        </div>
      )}
    </div>
  );
}



// ─── Holdings rows — multiple tickers under a Stocks/ETFs item ───────────────
function HoldingsRows({item, onUpdate, compact=false}) {
  const holdings = item.holdings || [];
  const mkHolding = () => ({id:mkId(), ticker:"", qty:"", price:"", value:""});

  const updateHolding = (hid, field, val) => {
    onUpdate(item.id, "holdings", holdings.map(h => h.id===hid ? {...h, [field]:val} : h));
  };
  const removeHolding = (hid) => {
    onUpdate(item.id, "holdings", holdings.filter(h => h.id!==hid));
  };
  const addHolding = () => {
    onUpdate(item.id, "holdings", [...holdings, mkHolding()]);
  };

  const pl  = compact ? "6px 8px" : "5px 8px";
  const fs  = compact ? 12 : 13;
  const gap = compact ? 6 : 8;
  const pad = compact ? 18 : 26;

  // Auto-calc holding value from qty × price
  const handleHoldingChange = (hid, field, val) => {
    const h     = holdings.find(h=>h.id===hid);
    const next  = {...h, [field]:val};
    const q     = parseFloat(next.qty)||0;
    const p     = parseFloat(next.price)||0;
    if (q>0 && p>0) next.value = String(Math.round(q*p));
    onUpdate(item.id, "holdings", holdings.map(h=>h.id===hid?next:h));
  };

  const iStyle = (color="#f0ece4") => ({
    background:"rgba(255,255,255,.05)",border:"none",
    borderBottom:"1px solid rgba(200,160,80,.12)",outline:"none",
    color,fontSize:fs,fontFamily:FF,padding:pl,
    borderRadius:"4px 4px 0 0",width:"100%",
    transition:"border-color .2s",
  });
  const fg = e=>e.target.style.borderBottomColor="rgba(200,160,80,.4)";
  const fb = e=>e.target.style.borderBottomColor="rgba(200,160,80,.12)";

  return (
    <div style={{paddingLeft:pad, marginTop:6}}>
      {/* Column headers */}
      {holdings.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 60px 80px 90px 18px",gap,alignItems:"center",marginBottom:3}}>
          <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase"}}>Ticker / Name</span>
          <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"center"}}>Shares</span>
          <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"right"}}>Price</span>
          <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"right"}}>Value</span>
          <span/>
        </div>
      )}

      {/* Holding rows */}
      {holdings.map(h=>{
        const calcVal = (parseFloat(h.qty)||0)*(parseFloat(h.price)||0);
        const showCalc = calcVal>0;
        return (
        <div key={h.id} style={{display:"grid",gridTemplateColumns:"1fr 60px 80px 90px 18px",gap,alignItems:"center",marginBottom:4}}>
          {/* Ticker */}
          <input value={h.ticker} onChange={e=>handleHoldingChange(h.id,"ticker",e.target.value)}
            placeholder="AAPL, VOO…"
            style={{...iStyle("#d4b870"),textTransform:"uppercase"}}
            onFocus={fg} onBlur={fb}/>
          {/* Shares */}
          <input value={h.qty} onChange={e=>handleHoldingChange(h.id,"qty",e.target.value)}
            placeholder="0" type="text" inputMode="decimal"
            style={{...iStyle("#98989f"),textAlign:"center"}}
            onFocus={fg} onBlur={fb}/>
          {/* Price per share */}
          <div style={{position:"relative"}}>
            <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
            <input value={h.price||""} onChange={e=>handleHoldingChange(h.id,"price",e.target.value)}
              placeholder="0.00" type="text" inputMode="decimal"
              style={{...iStyle("#98989f"),paddingLeft:18,textAlign:"right"}}
              onFocus={fg} onBlur={fb}/>
          </div>
          {/* Calculated value */}
          <div style={{position:"relative"}}>
            <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
            <input value={showCalc?String(Math.round(calcVal)):h.value}
              onChange={e=>{ if(!showCalc) handleHoldingChange(h.id,"value",e.target.value); }}
              placeholder="0" type="text" inputMode="numeric" readOnly={showCalc}
              style={{...iStyle(showCalc?"#30d158":"#30d158"),paddingLeft:18,textAlign:"right",
                      opacity:showCalc?1:.7,cursor:showCalc?"default":"text",
                      background:showCalc?"rgba(48,209,88,.06)":"rgba(255,255,255,.05)"}}
              onFocus={fg} onBlur={fb}/>
          </div>
          <div onClick={()=>removeHolding(h.id)}
            style={{color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"color .15s"}}
            onMouseEnter={e=>e.currentTarget.style.color="#ff6b6b"}
            onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
            <Ic.X/>
          </div>
        </div>
        );
      })}

      {/* Add ticker button */}
      <div onClick={addHolding}
        style={{display:"flex",alignItems:"center",gap:5,marginTop:holdings.length>0?4:0,
          color:"#4a4030",cursor:"pointer",userSelect:"none",transition:"color .15s",width:"fit-content"}}
        onMouseEnter={e=>e.currentTarget.style.color=GOLD}
        onMouseLeave={e=>e.currentTarget.style.color="#4a4030"}>
        <div style={{width:14,height:14,borderRadius:"50%",background:"rgba(200,160,80,.1)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <Ic.Plus/>
        </div>
        <span style={{fontSize:11,fontFamily:FF,letterSpacing:".02em"}}>Add ticker</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DESKTOP LAYOUT
// ═══════════════════════════════════════════════════════════════════════════════

function DesktopItemRow({item,type,categories,onUpdate,onRemove,onLookup,onDragStart,onDragEnter,onDragEnd,isDragOver}) {
  const isAsset      = type==="asset";
  const showHoldings = isAsset&&["Stocks / ETFs","Retirement"].includes(item.category);
  const isCrypto     = isAsset&&item.category==="Crypto";
  const hasRate      = RATE_LABEL[item.category]!==undefined;
  const hasDetails   = showHoldings||hasRate||isCrypto;
  const btnCol       = item.liveStatus==="done"?"#30d158":item.liveStatus==="error"?"#ff453a":"#48484a";
  const [open, setOpen] = useState(()=>!!item.rate||(item.holdings||[]).length>0||!!(item.qty&&item.price));

  // Auto-calc crypto value when qty or price changes
  const handleCryptoField = (field, val) => {
    const next = {...item, [field]:val};
    const q = parseFloat(next.qty)||0;
    const p = parseFloat(next.price)||0;
    if (q>0 && p>0) onUpdate(item.id, "value", String(Math.round(q*p)));
    onUpdate(item.id, field, val);
  };

  return (
    <div
      className="item-row"
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={e=>e.preventDefault()}
      style={{padding:"10px 0",borderRadius:10,transition:"background .15s, opacity .15s",
              borderTop: isDragOver ? `2px solid ${GOLD}` : "2px solid transparent",
              cursor:"default"}}>
      <div style={{display:"grid",gridTemplateColumns:"18px 1fr 138px 130px 26px",gap:8,alignItems:"center"}}>
        {/* Drag handle */}
        <div className="drag-handle"
          style={{color:"#3a3530",cursor:"grab",display:"flex",alignItems:"center",justifyContent:"center",padding:"4px 0",transition:"color .15s"}}
          onMouseEnter={e=>e.currentTarget.style.color="#6b6050"}
          onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
          <Ic.Grip/>
        </div>
        {/* Label + optional expand chevron */}
        <div style={{display:"flex",alignItems:"center",gap:4,minWidth:0}}>
          <input value={item.label} onChange={e=>onUpdate(item.id,"label",e.target.value)}
            placeholder={item.category==="Real Estate"?"Property address…":item.category==="Stocks / ETFs"?"Account / institution name…":item.category==="Retirement"?"Account / institution name…":item.category==="Crypto"?"Wallet address or label…":item.category==="Vehicles"?"Year, make, model…":isAsset?"Asset description…":"Liability name…"}
            style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#f0ece4",fontSize:15,fontFamily:FF,minWidth:0}}/>
          {hasDetails&&(
            <div onClick={e=>{e.stopPropagation();setOpen(p=>!p);}}
              style={{flexShrink:0,color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",padding:"2px 4px",borderRadius:4,transition:"color .15s, transform .2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}
              onMouseEnter={e=>e.currentTarget.style.color=GOLD}
              onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}
              title={open?"Collapse details":"Expand details"}>
              <Ic.Chev/>
            </div>
          )}
        </div>
        <select value={item.category} onChange={e=>onUpdate(item.id,"category",e.target.value)} style={{background:"rgba(255,255,255,.06)",border:"none",outline:"none",borderRadius:8,color:"#98989f",fontSize:12,fontFamily:FF,padding:"7px 8px",cursor:"pointer",width:"100%",appearance:"none"}}>
          {categories.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
        <div style={{display:"flex",gap:5,alignItems:"center"}}>
          {(() => {
            const isRolledUp = showHoldings&&(item.holdings||[]).length>0&&parseNum(item.value)>0;
            return (
              <div style={{position:"relative",flex:1}}>
                <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:13,pointerEvents:"none"}}>$</span>
                <input value={item.value} onChange={e=>{ if(!isRolledUp) onUpdate(item.id,"value",e.target.value); }}
                  placeholder="0" type="text" inputMode="numeric" readOnly={isRolledUp}
                  title={isRolledUp?"Sum of holdings — edit individual positions below":""}
                  style={{background:isRolledUp?"rgba(48,209,88,.06)":"rgba(255,255,255,.06)",border:"none",outline:"none",
                    borderRadius:8,color:isAsset?"#30d158":"#ff453a",fontSize:14,fontFamily:FF,
                    padding:"7px 8px 7px 20px",width:"100%",textAlign:"right",
                    cursor:isRolledUp?"default":"text"}}/>
                {isRolledUp&&<span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#30d15888",pointerEvents:"none"}}>Σ</span>}
              </div>
            );
          })()}
          {isAsset&&<div onClick={()=>item.label&&item.liveStatus!=="loading"&&onLookup(item)} style={{background:item.liveStatus==="done"?"rgba(48,209,88,.14)":item.liveStatus==="error"?"rgba(255,69,58,.1)":"rgba(255,255,255,.07)",borderRadius:8,color:btnCol,cursor:item.label&&item.liveStatus!=="loading"?"pointer":"not-allowed",padding:7,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,width:30,height:30,transition:"all .18s"}}>
            {item.liveStatus==="loading"?<Ic.Spin/>:item.liveStatus==="done"?<Ic.Check/>:item.liveStatus==="error"?<Ic.Warn/>:<Ic.Mag/>}
          </div>}
        </div>
        <div className="del-btn" onClick={()=>onRemove(item.id)} style={{color:"#48484a",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",borderRadius:6,padding:4,opacity:0,transition:"opacity .15s"}}><Ic.Trash/></div>
      </div>
      {/* Collapsible details */}
      {open&&(
        <>
          {hasRate&&(
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:5,paddingLeft:26}}>
              <span style={{fontSize:11,color:"#4a4030",fontWeight:500,letterSpacing:".04em",textTransform:"uppercase",userSelect:"none"}}>{RATE_LABEL[item.category]}</span>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <input
                  value={item.rate||""}
                  onChange={e=>onUpdate(item.id,"rate",e.target.value)}
                  placeholder="0.00"
                  type="text" inputMode="decimal"
                  style={{width:64,background:"transparent",border:"none",borderBottom:"1px solid rgba(200,160,80,.15)",outline:"none",
                    color:RATE_LABEL[item.category]==="APY"?"#30d158":"#e8a040",
                    fontSize:12,fontFamily:FF,padding:"2px 18px 2px 0",textAlign:"right",transition:"border-color .2s"}}
                  onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.5)"}
                  onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.15)"}
                />
                <span style={{position:"absolute",right:0,fontSize:12,color:"#4a4030",pointerEvents:"none"}}>%</span>
              </div>
              {item.rate&&parseFloat(item.rate)>0&&(
                <span style={{fontSize:11,color:"#4a4030"}}>
                  · {RATE_LABEL[item.category]==="APY"?"earns":"costs"} ~{fmt(parseNum(item.value)*(parseFloat(item.rate)/100))}/yr
                </span>
              )}
            </div>
          )}
          {showHoldings&&<HoldingsRows item={item} onUpdate={onUpdate}/>}
          {isCrypto&&(
            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6,paddingLeft:26,flexWrap:"wrap"}}>
              {/* Units */}
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:11,color:"#4a4030",fontWeight:500,letterSpacing:".04em",textTransform:"uppercase",userSelect:"none"}}>Units</span>
                <input value={item.qty||""} onChange={e=>handleCryptoField("qty",e.target.value)}
                  placeholder="0.00" type="text" inputMode="decimal"
                  style={{width:90,background:"transparent",border:"none",borderBottom:"1px solid rgba(200,160,80,.15)",outline:"none",
                    color:"#98989f",fontSize:12,fontFamily:FF,padding:"2px 4px",textAlign:"right",transition:"border-color .2s"}}
                  onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.5)"}
                  onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.15)"}/>
              </div>
              <span style={{color:"#3a3530",fontSize:12}}>×</span>
              {/* Price per unit */}
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:11,color:"#4a4030",fontWeight:500,letterSpacing:".04em",textTransform:"uppercase",userSelect:"none"}}>Price</span>
                <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                  <span style={{position:"absolute",left:0,fontSize:12,color:"#4a4030",pointerEvents:"none"}}>$</span>
                  <input value={item.price||""} onChange={e=>handleCryptoField("price",e.target.value)}
                    placeholder="0.00" type="text" inputMode="decimal"
                    style={{width:100,background:"transparent",border:"none",borderBottom:"1px solid rgba(200,160,80,.15)",outline:"none",
                      color:"#98989f",fontSize:12,fontFamily:FF,padding:"2px 4px 2px 14px",textAlign:"right",transition:"border-color .2s"}}
                    onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.5)"}
                    onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.15)"}/>
                </div>
              </div>
              {(parseFloat(item.qty)||0)>0&&(parseFloat(item.price)||0)>0&&(
                <span style={{fontSize:11,color:"#30d158",fontWeight:500}}>
                  = {fmt((parseFloat(item.qty)||0)*(parseFloat(item.price)||0))}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {item.liveNote&&<div style={{marginTop:4,fontSize:11.5,color:item.liveStatus==="error"?"#ff6b6b":"#48484a",lineHeight:1.4}}>{item.liveNote}</div>}
    </div>
  );
}

function DesktopSection({title,color,total,items,type,categories,onUpdate,onRemove,onAdd,onLookup,onReorder}) {
  const dragIdx = useRef(null);
  const [overIdx, setOverIdx] = useState(null);

  const handleDragStart = (i) => { dragIdx.current = i; };
  const handleDragEnter = (i) => { if (i !== dragIdx.current) setOverIdx(i); };
  const handleDragEnd   = ()  => {
    if (dragIdx.current !== null && overIdx !== null && dragIdx.current !== overIdx) {
      onReorder(type, dragIdx.current, overIdx);
    }
    dragIdx.current = null;
    setOverIdx(null);
  };

  return (
    <div style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.1)",borderRadius:18,overflow:"hidden",marginBottom:0,position:"relative"}}>
      {/* Coloured top accent */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${color}99,${color}22)`}}/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"20px 24px 16px",paddingTop:22}}>
        <div>
          <div style={{fontSize:16,fontWeight:600,color:"#f0ece4",letterSpacing:"-.01em"}}>{title}</div>
          <div style={{fontSize:11,color:"#4a4040",marginTop:2}}>{items.length} {items.length===1?"item":"items"} · drag ⠿ to reorder</div>
        </div>
        <div style={{fontSize:20,fontWeight:700,color,letterSpacing:"-.03em"}}>{fmt(total)}</div>
      </div>
      <div style={{height:1,background:"rgba(200,160,80,.08)",margin:"0 24px"}}/>
      <div style={{padding:"8px 0"}}>
        {items.map((item,i)=>(
          <div key={item.id}>
            <div style={{padding:"2px 24px"}}>
              <DesktopItemRow
                item={item} type={type} categories={categories}
                onUpdate={(id,f,v)=>onUpdate(type,id,f,v)}
                onRemove={id=>onRemove(type,id)}
                onLookup={it=>onLookup(type,it)}
                onDragStart={()=>handleDragStart(i)}
                onDragEnter={()=>handleDragEnter(i)}
                onDragEnd={handleDragEnd}
                isDragOver={overIdx===i}
              />
            </div>
            {i<items.length-1&&<div style={{height:1,background:"rgba(255,255,255,.04)",margin:"0 24px"}}/>}
          </div>
        ))}
      </div>
      <div style={{height:1,background:"rgba(200,160,80,.08)",margin:"0 24px"}}/>
      <div onClick={()=>onAdd(type)} className="add-btn" style={{display:"flex",alignItems:"center",gap:9,color:GOLD,fontSize:15,fontFamily:FF,padding:"15px 24px",cursor:"pointer",boxSizing:"border-box",transition:"opacity .15s"}}>
        <div style={{width:20,height:20,borderRadius:"50%",background:"rgba(200,160,80,.12)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic.Plus/></div>
        Add {type==="asset"?"Asset":"Liability"}
      </div>
    </div>
  );
}

function StatCell({label,value,color,border}) {
  return (
    <div style={{flex:1,padding:"16px 20px",borderRight:border?"1px solid rgba(200,160,80,.1)":"none",textAlign:"center"}}>
      <div style={{fontSize:12,color:"#636366",fontWeight:500,marginBottom:4}}>{label}</div>
      <div style={{fontSize:20,fontWeight:700,color,letterSpacing:"-.03em"}}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOBILE LAYOUT
// ═══════════════════════════════════════════════════════════════════════════════

function MobileItemRow({item,type,categories,onUpdate,onRemove,onLookup,onDragStart,onDragEnter,onDragEnd,isDragOver}) {
  const isAsset      = type==="asset";
  const showHoldings = isAsset&&["Stocks / ETFs","Retirement"].includes(item.category);
  const isCrypto     = isAsset&&item.category==="Crypto";
  const hasRate      = RATE_LABEL[item.category]!==undefined;
  const hasDetails   = showHoldings||hasRate||isCrypto;
  const btnCol       = item.liveStatus==="done"?"#30d158":item.liveStatus==="error"?"#ff453a":"#48484a";
  const [open, setOpen] = useState(()=>!!item.rate||(item.holdings||[]).length>0||!!(item.qty&&item.price));

  const handleCryptoField = (field, val) => {
    const next = {...item, [field]:val};
    const q = parseFloat(next.qty)||0;
    const p = parseFloat(next.price)||0;
    if (q>0 && p>0) onUpdate(item.id, "value", String(Math.round(q*p)));
    onUpdate(item.id, field, val);
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={e=>e.preventDefault()}
      style={{padding:"12px 0",borderTop:isDragOver?`2px solid ${GOLD}`:"2px solid transparent",transition:"border-color .1s"}}>
      {/* Row 1: grip + label + expand chevron + delete */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <div style={{color:"#3a3530",cursor:"grab",display:"flex",alignItems:"center",flexShrink:0,padding:"4px 2px",touchAction:"none"}}
          onMouseEnter={e=>e.currentTarget.style.color="#6b6050"}
          onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
          <Ic.Grip/>
        </div>
        <input value={item.label} onChange={e=>onUpdate(item.id,"label",e.target.value)}
          placeholder={item.category==="Real Estate"?"Property address…":item.category==="Stocks / ETFs"?"Account / institution name…":item.category==="Retirement"?"Account / institution name…":item.category==="Crypto"?"Wallet address or label…":item.category==="Vehicles"?"Year, make, model…":isAsset?"Asset description…":"Liability name…"}
          style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#f0ece4",fontSize:15,fontFamily:FF,minWidth:0}}/>
        {hasDetails&&(
          <div onClick={e=>{e.stopPropagation();setOpen(p=>!p);}}
            style={{flexShrink:0,color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",padding:"4px",borderRadius:4,transition:"color .15s, transform .2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}
            onMouseEnter={e=>e.currentTarget.style.color=GOLD}
            onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
            <Ic.Chev/>
          </div>
        )}
        <div onClick={()=>onRemove(item.id)} style={{color:"#48484a",cursor:"pointer",padding:6,display:"flex",alignItems:"center",flexShrink:0}}><Ic.Trash/></div>
      </div>
      {/* Row 2: category + value + lookup */}
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <select value={item.category} onChange={e=>onUpdate(item.id,"category",e.target.value)}
          style={{flex:1,background:"rgba(255,255,255,.07)",border:"none",outline:"none",borderRadius:9,color:"#98989f",fontSize:12,fontFamily:FF,padding:"8px 10px",cursor:"pointer",appearance:"none",minWidth:0}}>
          {categories.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
        {(()=>{
          const isRolledUp = showHoldings&&(item.holdings||[]).length>0&&parseNum(item.value)>0;
          return (
            <div style={{position:"relative",flexShrink:0}}>
              <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:13,pointerEvents:"none"}}>$</span>
              <input value={item.value} onChange={e=>{ if(!isRolledUp) onUpdate(item.id,"value",e.target.value); }}
                placeholder="0" type="text" inputMode="numeric" readOnly={isRolledUp}
                style={{width:120,background:isRolledUp?"rgba(48,209,88,.06)":"rgba(255,255,255,.07)",border:"none",outline:"none",
                  borderRadius:9,color:isAsset?"#30d158":"#ff453a",fontSize:14,fontFamily:FF,
                  padding:"8px 8px 8px 18px",textAlign:"right",cursor:isRolledUp?"default":"text"}}/>
              {isRolledUp&&<span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#30d15888",pointerEvents:"none"}}>Σ</span>}
            </div>
          );
        })()}
        {isAsset&&<div onClick={()=>item.label&&item.liveStatus!=="loading"&&onLookup(item)}
          style={{width:36,height:36,background:item.liveStatus==="done"?"rgba(48,209,88,.14)":item.liveStatus==="error"?"rgba(255,69,58,.1)":"rgba(255,255,255,.07)",borderRadius:9,color:btnCol,cursor:item.label&&item.liveStatus!=="loading"?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .18s"}}>
          {item.liveStatus==="loading"?<Ic.Spin/>:item.liveStatus==="done"?<Ic.Check/>:item.liveStatus==="error"?<Ic.Warn/>:<Ic.Mag/>}
        </div>}
      </div>
      {/* Collapsible details */}
      {open&&(
        <>
          {hasRate&&(
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6,paddingLeft:22}}>
              <span style={{fontSize:11,color:"#4a4030",fontWeight:500,letterSpacing:".04em",textTransform:"uppercase",userSelect:"none"}}>{RATE_LABEL[item.category]}</span>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <input
                  value={item.rate||""}
                  onChange={e=>onUpdate(item.id,"rate",e.target.value)}
                  placeholder="0.00"
                  type="text" inputMode="decimal"
                  style={{width:60,background:"transparent",border:"none",borderBottom:"1px solid rgba(200,160,80,.15)",outline:"none",
                    color:RATE_LABEL[item.category]==="APY"?"#30d158":"#e8a040",
                    fontSize:12,fontFamily:FF,padding:"2px 16px 2px 0",textAlign:"right",transition:"border-color .2s"}}
                  onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.5)"}
                  onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.15)"}
                />
                <span style={{position:"absolute",right:0,fontSize:12,color:"#4a4030",pointerEvents:"none"}}>%</span>
              </div>
              {item.rate&&parseFloat(item.rate)>0&&(
                <span style={{fontSize:11,color:"#4a4030"}}>
                  · ~{fmt(parseNum(item.value)*(parseFloat(item.rate)/100))}/yr
                </span>
              )}
            </div>
          )}
          {showHoldings&&<HoldingsRows item={item} onUpdate={onUpdate} compact={true}/>}
          {isCrypto&&(
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,paddingLeft:22,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:10,color:"#4a4030",textTransform:"uppercase",letterSpacing:".04em"}}>Units</span>
                <input value={item.qty||""} onChange={e=>handleCryptoField("qty",e.target.value)}
                  placeholder="0.00" type="text" inputMode="decimal"
                  style={{width:80,background:"transparent",border:"none",borderBottom:"1px solid rgba(200,160,80,.15)",outline:"none",
                    color:"#98989f",fontSize:12,fontFamily:FF,padding:"2px 4px",textAlign:"right"}}
                  onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.5)"}
                  onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.15)"}/>
              </div>
              <span style={{color:"#3a3530",fontSize:12}}>×</span>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:10,color:"#4a4030",textTransform:"uppercase",letterSpacing:".04em"}}>Price $</span>
                <input value={item.price||""} onChange={e=>handleCryptoField("price",e.target.value)}
                  placeholder="0.00" type="text" inputMode="decimal"
                  style={{width:90,background:"transparent",border:"none",borderBottom:"1px solid rgba(200,160,80,.15)",outline:"none",
                    color:"#98989f",fontSize:12,fontFamily:FF,padding:"2px 4px",textAlign:"right"}}
                  onFocus={e=>e.target.style.borderBottomColor="rgba(200,160,80,.5)"}
                  onBlur={e=>e.target.style.borderBottomColor="rgba(200,160,80,.15)"}/>
              </div>
              {(parseFloat(item.qty)||0)>0&&(parseFloat(item.price)||0)>0&&(
                <span style={{fontSize:11,color:"#30d158",fontWeight:500}}>
                  = {fmt((parseFloat(item.qty)||0)*(parseFloat(item.price)||0))}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {item.liveNote&&<div style={{marginTop:6,fontSize:11.5,color:item.liveStatus==="error"?"#ff6b6b":"#48484a",lineHeight:1.4}}>{item.liveNote}</div>}
    </div>
  );
}

function MobileSection({title,color,total,items,type,categories,onUpdate,onRemove,onAdd,onLookup,onReorder}) {
  const [open,setOpen] = useState(true);
  const dragIdx = useRef(null);
  const [overIdx, setOverIdx] = useState(null);

  const handleDragStart = (i) => { dragIdx.current = i; };
  const handleDragEnter = (i) => { if (i !== dragIdx.current) setOverIdx(i); };
  const handleDragEnd   = ()  => {
    if (dragIdx.current !== null && overIdx !== null && dragIdx.current !== overIdx) {
      onReorder(type, dragIdx.current, overIdx);
    }
    dragIdx.current = null;
    setOverIdx(null);
  };

  return (
    <div style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.1)",borderRadius:16,overflow:"hidden",marginBottom:12}}>
      {/* Collapsible header */}
      <div onClick={()=>setOpen(p=>!p)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px",cursor:"pointer",userSelect:"none"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:color,flexShrink:0}}/>
          <div style={{fontSize:16,fontWeight:600,color:"#f0ece4"}}>{title}</div>
          <div style={{fontSize:12,color:"#636366"}}>({items.length})</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:17,fontWeight:700,color,letterSpacing:"-.02em"}}>{fmtCompact(total)}</div>
          <div style={{color:"#48484a",transform:open?"rotate(180deg)":"rotate(0deg)",transition:"transform .2s",display:"flex"}}><Ic.Chev/></div>
        </div>
      </div>
      {open&&(
        <>
          <div style={{height:1,background:"rgba(200,160,80,.08)",margin:"0 16px"}}/>
          <div style={{padding:"4px 16px 0"}}>
            {items.map((item,i)=>(
              <div key={item.id}>
                <MobileItemRow
                  item={item} type={type} categories={categories}
                  onUpdate={(id,f,v)=>onUpdate(type,id,f,v)}
                  onRemove={id=>onRemove(type,id)}
                  onLookup={it=>onLookup(type,it)}
                  onDragStart={()=>handleDragStart(i)}
                  onDragEnter={()=>handleDragEnter(i)}
                  onDragEnd={handleDragEnd}
                  isDragOver={overIdx===i}
                />
                {i<items.length-1&&<div style={{height:1,background:"rgba(255,255,255,.04)"}}/>}
              </div>
            ))}
          </div>
          <div style={{height:1,background:"rgba(200,160,80,.08)",margin:"0 16px"}}/>
          <div onClick={()=>onAdd(type)} style={{display:"flex",alignItems:"center",gap:8,color:GOLD,fontSize:14,fontFamily:FF,padding:"13px 16px",cursor:"pointer"}}>
            <div style={{width:18,height:18,borderRadius:"50%",background:"rgba(200,160,80,.12)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic.Plus/></div>
            Add {type==="asset"?"Asset":"Liability"}
          </div>
        </>
      )}
    </div>
  );
}

// Mobile bottom nav tab bar
function MobileBottomNav({tab, onTab, onSettings}) {
  const tabs = [
    {id:"all",      icon:<Ic.Home/>,   label:"Overview"},
    {id:"assets",   icon:<Ic.Wallet/>, label:"Assets"},
    {id:"debts",    icon:null,         label:"Debts", customIcon:<span style={{fontSize:18,lineHeight:1}}>📉</span>},
    {id:"cashflow", icon:null,         label:"Cash Flow", customIcon:<span style={{fontSize:16,lineHeight:1}}>$</span>},
    {id:"wallet",   icon:<Ic.Chain/>,  label:"Wallets"},
    {id:"settings", icon:<Ic.Cog/>,    label:"Data"},
  ];
  return (
    <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:300,background:"rgba(6,5,4,.96)",backdropFilter:"blur(20px)",borderTop:"1px solid rgba(200,160,80,.1)",display:"flex",alignItems:"stretch",paddingBottom:"env(safe-area-inset-bottom, 0px)"}}>
      {tabs.map(t=>{
        const active = t.id!=="settings" && tab===t.id;
        return (
          <div key={t.id}
            onClick={()=>{ if(t.id==="settings") onSettings(); else onTab(t.id); }}
            style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,padding:"10px 4px 8px",cursor:"pointer",userSelect:"none",color:active?GOLD:"#48484a",transition:"color .15s",position:"relative"}}>
            <div style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center"}}>
              {t.customIcon || t.icon}
            </div>
            <span style={{fontSize:10,fontWeight:active?600:400,letterSpacing:".02em"}}>{t.label}</span>
            {active&&<div style={{width:16,height:2,background:GOLD,borderRadius:1,position:"absolute",bottom:0,marginBottom:"env(safe-area-inset-bottom, 0px)"}}/>}
          </div>
        );
      })}
    </div>
  );
}



// ─── Budget / Cash Flow Panel ─────────────────────────────────────────────────
function BudgetPanel({income, expenses, onAddIncome, onUpdateIncome, onRemoveIncome,
                      onAddExpense, onUpdateExpense, onRemoveExpense,
                      onReorderIncome, onReorderExpense, mobile=false}) {
  const totalIn  = income.reduce((s,r)=>s+parseNum(r.amount),0);
  const totalOut = expenses.reduce((s,r)=>s+parseNum(r.amount),0);
  const net      = totalIn - totalOut;
  const savRate  = totalIn>0 ? ((totalIn-totalOut)/totalIn)*100 : 0;
  const netColor = net>=0?"#30d158":"#ff453a";
  const p = mobile ? 16 : 24;

  // Drag state — separate refs for each list
  const incDragIdx = useRef(null);
  const expDragIdx = useRef(null);
  const [incOver, setIncOver] = useState(null);
  const [expOver, setExpOver] = useState(null);

  const makeDrag = (dragRef, setOver, onReorder) => ({
    start: (i) => { dragRef.current = i; },
    enter: (i) => { if (i !== dragRef.current) setOver(i); },
    end:   ()  => {
      if (dragRef.current !== null && dragRef.current !== null) onReorder(dragRef.current, incOver ?? expOver);
      dragRef.current = null; setOver(null);
    },
  });

  // Simpler inline handlers per list
  const incDrag = { idx: incDragIdx, over: incOver, setOver: setIncOver };
  const expDrag = { idx: expDragIdx, over: expOver, setOver: setExpOver };

  const inputStyle = (color="#f0ece4") => ({
    background:"rgba(255,255,255,.05)",border:"none",
    borderBottom:"1px solid rgba(200,160,80,.12)",outline:"none",
    color,fontSize:13,fontFamily:FF,padding:"5px 8px",
    borderRadius:"4px 4px 0 0",transition:"border-color .2s",
  });
  const focusGold = e => e.target.style.borderBottomColor="rgba(200,160,80,.4)";
  const blurGold  = e => e.target.style.borderBottomColor="rgba(200,160,80,.12)";

  const gripStyle = {color:"#3a3530",cursor:"grab",display:"flex",alignItems:"center",
                     flexShrink:0,padding:"0 2px",transition:"color .15s"};

  const SectionHead = ({label, total, color}) => (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",
                 marginBottom:10,paddingBottom:8,borderBottom:`1px solid ${color}22`}}>
      <span style={{fontSize:12,fontWeight:600,color,letterSpacing:".06em",textTransform:"uppercase"}}>{label}</span>
      <span style={{fontSize:15,fontWeight:700,color}}>{fmt(total)}<span style={{fontSize:10,color:"#5a5040",fontWeight:400}}>/mo</span></span>
    </div>
  );

  return (
    <div style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.12)",
                 borderRadius:18,overflow:"hidden",marginBottom:16,position:"relative"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:2,
                   background:"linear-gradient(90deg,#64d2ff88,#64d2ff22)"}}/>

      {/* Header */}
      <div style={{padding:`18px ${p}px 14px`,borderBottom:"1px solid rgba(200,160,80,.08)",
                   display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:16,fontWeight:600,color:"#f0ece4",letterSpacing:"-.01em"}}>Cash Flow</div>
          <div style={{fontSize:12,color:"#636366",marginTop:2}}>Monthly income &amp; expenses</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[["In",fmt(totalIn),"#30d158"],["Out",fmt(totalOut),"#ff453a"],["Net",fmt(net),netColor]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,.04)",border:`1px solid ${c}22`,borderRadius:10,padding:"6px 12px",textAlign:"center"}}>
              <div style={{fontSize:9,color:"#6b6050",letterSpacing:".08em",marginBottom:2}}>{l}</div>
              <div style={{fontSize:13,fontWeight:700,color:c}}>{v}</div>
            </div>
          ))}
          {totalIn>0&&(
            <div style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(200,160,80,.15)",borderRadius:10,padding:"6px 12px",textAlign:"center"}}>
              <div style={{fontSize:9,color:"#6b6050",letterSpacing:".08em",marginBottom:2}}>SAVE RATE</div>
              <div style={{fontSize:13,fontWeight:700,color:savRate>=20?"#30d158":savRate>=10?"#ffd60a":"#ff453a"}}>{savRate.toFixed(1)}%</div>
            </div>
          )}
        </div>
      </div>

      {/* Two-column body */}
      <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"1fr 1fr",gap:0}}>

        {/* ── INCOME ── */}
        <div style={{padding:`16px ${p}px`,borderRight:mobile?"none":"1px solid rgba(200,160,80,.06)"}}>
          <SectionHead label="Income" total={totalIn} color="#30d158"/>
          {income.length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"14px 1fr 110px 16px",gap:8,marginBottom:4}}>
              <span/>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase"}}>Source</span>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"right"}}>Monthly</span>
              <span/>
            </div>
          )}
          {income.map((r,i)=>(
            <div key={r.id}
              draggable
              onDragStart={()=>{ incDrag.idx.current=i; }}
              onDragEnter={()=>{ if(i!==incDrag.idx.current) incDrag.setOver(i); }}
              onDragEnd={()=>{ if(incDrag.idx.current!==null&&incDrag.over!==null&&incDrag.idx.current!==incDrag.over) onReorderIncome(incDrag.idx.current,incDrag.over); incDrag.idx.current=null; incDrag.setOver(null); }}
              onDragOver={e=>e.preventDefault()}
              style={{display:"grid",gridTemplateColumns:"14px 1fr 110px 16px",gap:8,alignItems:"center",marginBottom:6,
                      borderTop:incOver===i?`2px solid #30d158`:"2px solid transparent",transition:"border-color .1s"}}>
              <div style={gripStyle}
                onMouseEnter={e=>e.currentTarget.style.color="#6b6050"}
                onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
                <Ic.Grip/>
              </div>
              <input value={r.label} onChange={e=>onUpdateIncome(r.id,"label",e.target.value)}
                placeholder="Salary, freelance…"
                style={{...inputStyle(),width:"100%"}}
                onFocus={focusGold} onBlur={blurGold}/>
              <div style={{position:"relative"}}>
                <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
                <input value={r.amount} onChange={e=>onUpdateIncome(r.id,"amount",e.target.value)}
                  placeholder="0" type="text" inputMode="numeric"
                  style={{...inputStyle("#30d158"),width:"100%",paddingLeft:18,textAlign:"right"}}
                  onFocus={focusGold} onBlur={blurGold}/>
              </div>
              <div onClick={()=>onRemoveIncome(r.id)}
                style={{color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",transition:"color .15s"}}
                onMouseEnter={e=>e.currentTarget.style.color="#ff6b6b"}
                onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
                <Ic.X/>
              </div>
            </div>
          ))}
          <div onClick={onAddIncome}
            style={{display:"flex",alignItems:"center",gap:5,marginTop:income.length>0?6:0,
                    color:"#4a4030",cursor:"pointer",userSelect:"none",transition:"color .15s",width:"fit-content"}}
            onMouseEnter={e=>e.currentTarget.style.color=GOLD}
            onMouseLeave={e=>e.currentTarget.style.color="#4a4030"}>
            <div style={{width:14,height:14,borderRadius:"50%",background:"rgba(200,160,80,.1)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic.Plus/></div>
            <span style={{fontSize:11,fontFamily:FF,letterSpacing:".02em"}}>Add income source</span>
          </div>
        </div>

        {/* ── EXPENSES ── */}
        <div style={{padding:`16px ${p}px`}}>
          <SectionHead label="Expenses" total={totalOut} color="#ff453a"/>
          {expenses.length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"14px 1fr 100px 80px 16px",gap:8,marginBottom:4}}>
              <span/>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase"}}>Name</span>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase",textAlign:"right"}}>Monthly</span>
              <span style={{fontSize:10,color:"#3a3530",letterSpacing:".06em",textTransform:"uppercase"}}>Category</span>
              <span/>
            </div>
          )}
          {expenses.map((r,i)=>(
            <div key={r.id}
              draggable
              onDragStart={()=>{ expDrag.idx.current=i; }}
              onDragEnter={()=>{ if(i!==expDrag.idx.current) expDrag.setOver(i); }}
              onDragEnd={()=>{ if(expDrag.idx.current!==null&&expDrag.over!==null&&expDrag.idx.current!==expDrag.over) onReorderExpense(expDrag.idx.current,expDrag.over); expDrag.idx.current=null; expDrag.setOver(null); }}
              onDragOver={e=>e.preventDefault()}
              style={{display:"grid",gridTemplateColumns:"14px 1fr 100px 80px 16px",gap:8,alignItems:"center",marginBottom:6,
                      borderTop:expOver===i?`2px solid #ff453a`:"2px solid transparent",transition:"border-color .1s"}}>
              <div style={gripStyle}
                onMouseEnter={e=>e.currentTarget.style.color="#6b6050"}
                onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
                <Ic.Grip/>
              </div>
              <input value={r.label} onChange={e=>onUpdateExpense(r.id,"label",e.target.value)}
                placeholder="Rent, Netflix…"
                style={{...inputStyle(),width:"100%"}}
                onFocus={focusGold} onBlur={blurGold}/>
              <div style={{position:"relative"}}>
                <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#48484a",fontSize:12,pointerEvents:"none"}}>$</span>
                <input value={r.amount} onChange={e=>onUpdateExpense(r.id,"amount",e.target.value)}
                  placeholder="0" type="text" inputMode="numeric"
                  style={{...inputStyle("#ff453a"),width:"100%",paddingLeft:18,textAlign:"right"}}
                  onFocus={focusGold} onBlur={blurGold}/>
              </div>
              <select value={r.category} onChange={e=>onUpdateExpense(r.id,"category",e.target.value)}
                style={{background:"rgba(255,255,255,.06)",border:"none",outline:"none",borderRadius:6,
                        color:"#6a6050",fontSize:11,fontFamily:FF,padding:"5px 6px",
                        cursor:"pointer",appearance:"none",width:"100%"}}>
                {EXPENSE_CATS.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              <div onClick={()=>onRemoveExpense(r.id)}
                style={{color:"#3a3530",cursor:"pointer",display:"flex",alignItems:"center",transition:"color .15s"}}
                onMouseEnter={e=>e.currentTarget.style.color="#ff6b6b"}
                onMouseLeave={e=>e.currentTarget.style.color="#3a3530"}>
                <Ic.X/>
              </div>
            </div>
          ))}
          <div onClick={onAddExpense}
            style={{display:"flex",alignItems:"center",gap:5,marginTop:expenses.length>0?6:0,
                    color:"#4a4030",cursor:"pointer",userSelect:"none",transition:"color .15s",width:"fit-content"}}
            onMouseEnter={e=>e.currentTarget.style.color=GOLD}
            onMouseLeave={e=>e.currentTarget.style.color="#4a4030"}>
            <div style={{width:14,height:14,borderRadius:"50%",background:"rgba(200,160,80,.1)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic.Plus/></div>
            <span style={{fontSize:11,fontFamily:FF,letterSpacing:".02em"}}>Add expense</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Sheet — export / import, no auth ────────────────────────────────
function SettingsSheet({onClose, getExportData, onImport, onSignOut, userEmail}) {
  const fileRef = useRef(null);
  const [showExport, setShowExport] = useState(false);
  const [exportData, setExportData] = useState(null);
  const [importMsg,  setImportMsg]  = useState("");

  const handleExportClick = () => {
    setExportData(getExportData());
    setShowExport(true);
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.assets || !data.debts) throw new Error("bad format");
        onImport(data);
        setImportMsg("✓ Portfolio imported successfully");
        setTimeout(() => { setImportMsg(""); onClose(); }, 1400);
      } catch { setImportMsg("⚠ Invalid file — use a ToAvalon export."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const btnRow = (label, fn, color="#f0ece4", border=true) => (
    <div onClick={fn}
      style={{color,fontSize:15,fontFamily:FF,padding:"15px 18px",cursor:"pointer",
              transition:"opacity .15s",borderBottom:border?"1px solid rgba(200,160,80,.06)":"none"}}
      onMouseEnter={e=>e.currentTarget.style.opacity=".7"}
      onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
      {label}
    </div>
  );

  return (
    <>
      <div style={{position:"fixed",inset:0,zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.65)",backdropFilter:"blur(10px)"}} onClick={onClose}/>
        <div style={{position:"relative",width:"100%",maxWidth:520,background:"#161412",border:"1px solid rgba(200,160,80,.15)",borderRadius:"20px 20px 0 0",padding:"12px 24px 48px",fontFamily:FF,animation:"slideUp .28s cubic-bezier(.4,0,.2,1)",zIndex:1}}>
          <div style={{width:34,height:4,background:"rgba(200,160,80,.25)",borderRadius:2,margin:"0 auto 24px"}}/>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
            <div>
            <div style={{fontSize:17,fontWeight:700,color:"#f0ece4"}}>Data & Backup</div>
            {userEmail&&<div style={{fontSize:11,color:"#5a5040",marginTop:2}}>{userEmail}</div>}
          </div>
            <div onClick={onClose} style={{background:"rgba(255,255,255,.07)",borderRadius:"50%",width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#636366"}}><Ic.X/></div>
          </div>

          <div style={{background:"rgba(255,255,255,.03)",borderRadius:14,border:"1px solid rgba(200,160,80,.07)",overflow:"hidden",marginBottom:12}}>
            {btnRow("⬇  Export Portfolio (.json)", handleExportClick, "#f0ece4", true)}
            {btnRow("⬆  Import Portfolio (.json)", ()=>fileRef.current?.click(), "#f0ece4", false)}
          </div>

          {importMsg && (
            <div style={{borderRadius:10,padding:"10px 14px",fontSize:13,textAlign:"center",marginBottom:10,
              background:importMsg.startsWith("✓")?"rgba(48,209,88,.1)":"rgba(255,69,58,.1)",
              color:importMsg.startsWith("✓")?"#30d158":"#ff6b6b",
              border:importMsg.startsWith("✓")?"1px solid rgba(48,209,88,.2)":"1px solid rgba(255,69,58,.2)"}}>
              {importMsg}
            </div>
          )}

          <div style={{fontSize:12,color:"#3a3530",textAlign:"center",lineHeight:1.6}}>
            Your portfolio saves automatically to the cloud.<br/>
            Export regularly to keep a local backup.
          </div>

          {onSignOut&&(
            <div onClick={onSignOut}
              style={{background:"rgba(255,69,58,.08)",border:"1px solid rgba(255,69,58,.15)",borderRadius:10,
                      color:"#ff6b6b",fontSize:14,fontWeight:600,fontFamily:FF,
                      padding:"12px",cursor:"pointer",textAlign:"center",userSelect:"none",transition:"all .2s"}}
              onMouseEnter={e=>e.currentTarget.style.background="rgba(255,69,58,.15)"}
              onMouseLeave={e=>e.currentTarget.style.background="rgba(255,69,58,.08)"}>
              Sign Out
            </div>
          )}

          <input ref={fileRef} type="file" accept=".json,application/json" style={{display:"none"}} onChange={handleFile}/>
        </div>
      </div>

      {showExport && exportData && (
        <ExportModal jsonStr={exportData.jsonStr} filename={exportData.filename} onClose={()=>setShowExport(false)}/>
      )}
    </>
  );
}


// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({onAuth}) {
  const [mode,     setMode]     = useState("login"); // "login" | "signup"
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [info,     setInfo]     = useState("");

  const handle = async () => {
    if (!email || !password) { setError("Please enter your email and password."); return; }
    setLoading(true); setError(""); setInfo("");
    if (mode === "login") {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else onAuth(data.user);
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else if (data.user && !data.user.confirmed_at) {
        setInfo("Check your email for a confirmation link, then sign in.");
        setMode("login");
      } else if (data.user) onAuth(data.user);
    }
    setLoading(false);
  };

  const inputStyle = {
    width:"100%",background:"rgba(255,255,255,.06)",border:"1px solid rgba(200,160,80,.2)",
    borderRadius:10,color:"#f0ece4",fontSize:15,fontFamily:FF,padding:"12px 14px",
    outline:"none",boxSizing:"border-box",transition:"border-color .2s",
  };

  return (
    <div style={{minHeight:"100vh",background:"#060504",display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:FF}}>
      <div style={{position:"fixed",top:0,left:0,right:0,height:320,background:"radial-gradient(ellipse at 50% -20%, rgba(200,160,80,.07) 0%, transparent 65%)",pointerEvents:"none"}}/>
      <div style={{width:"100%",maxWidth:380,position:"relative",zIndex:1}}>
        {/* Brand */}
        <div style={{textAlign:"center",marginBottom:36}}>
          <Wordmark size="lg"/>
          <div style={{fontSize:13,color:"#5a5040",marginTop:10}}>Personal Finance Dashboard</div>
        </div>
        {/* Card */}
        <div style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.15)",borderRadius:20,padding:28,position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${GOLD}88,${GOLD}22)`}}/>
          <div style={{fontSize:18,fontWeight:700,color:"#f0ece4",marginBottom:20,letterSpacing:"-.02em"}}>
            {mode==="login"?"Welcome back":"Create account"}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <input value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="Email" type="email" autoComplete="email"
              style={inputStyle}
              onFocus={e=>e.target.style.borderColor="rgba(200,160,80,.5)"}
              onBlur={e=>e.target.style.borderColor="rgba(200,160,80,.2)"}
              onKeyDown={e=>e.key==="Enter"&&handle()}/>
            <input value={password} onChange={e=>setPassword(e.target.value)}
              placeholder="Password" type="password" autoComplete={mode==="login"?"current-password":"new-password"}
              style={inputStyle}
              onFocus={e=>e.target.style.borderColor="rgba(200,160,80,.5)"}
              onBlur={e=>e.target.style.borderColor="rgba(200,160,80,.2)"}
              onKeyDown={e=>e.key==="Enter"&&handle()}/>
            {error&&<div style={{fontSize:12,color:"#ff6b6b",padding:"8px 12px",background:"rgba(255,69,58,.08)",borderRadius:8,border:"1px solid rgba(255,69,58,.15)"}}>{error}</div>}
            {info&&<div style={{fontSize:12,color:"#30d158",padding:"8px 12px",background:"rgba(48,209,88,.08)",borderRadius:8,border:"1px solid rgba(48,209,88,.15)"}}>{info}</div>}
            <div onClick={handle}
              style={{background:loading?"rgba(200,160,80,.3)":`linear-gradient(135deg,${GOLD2},${GOLD})`,
                borderRadius:12,color:"#1a1208",fontSize:15,fontWeight:700,fontFamily:FF,
                padding:"13px",cursor:loading?"not-allowed":"pointer",textAlign:"center",
                userSelect:"none",transition:"all .2s",marginTop:4}}>
              {loading?"…":mode==="login"?"Sign In":"Create Account"}
            </div>
          </div>
          <div style={{textAlign:"center",marginTop:18,fontSize:13,color:"#5a5040"}}>
            {mode==="login"?"Don't have an account? ":"Already have an account? "}
            <span onClick={()=>{setMode(m=>m==="login"?"signup":"login");setError("");setInfo("");}}
              style={{color:GOLD,cursor:"pointer",userSelect:"none"}}>
              {mode==="login"?"Sign up":"Sign in"}
            </span>
          </div>
        </div>
        <div style={{textAlign:"center",marginTop:16,fontSize:11,color:"#3a3530"}}>
          Your portfolio is encrypted and stored securely.
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [user,       setUser]       = useState(null);
  const [authReady,  setAuthReady]  = useState(false);
  const [isMobile,   setIsMobile]   = useState(false);
  const [showTip,    setShowTip]    = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [assets,     setAssets]     = useState([blankItem("asset")]);
  const [debts,      setDebts]      = useState([blankItem("debt")]);
  const [income,     setIncome]     = useState([blankIncome()]);
  const [expenses,   setExpenses]   = useState([blankExpense()]);
  const [wallets,    setWallets]    = useState([blankWallet()]);
  const [tab,        setTab]        = useState("all");
  const [savedAt,    setSavedAt]    = useState(null);
  const saveTimer = useRef(null);

  // ── Auth: restore session on mount ──────────────────────────────────────────
  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{
      setUser(session?.user ?? null);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session)=>{
      setUser(session?.user ?? null);
    });
    return ()=>listener.subscription.unsubscribe();
  },[]);

  // ── Load portfolio when user logs in ────────────────────────────────────────
  useEffect(()=>{
    if (!user) return;
    dbLoad(user.id).then(data=>{
      if(data){
        setAssets(stripLive(data.assets||[blankItem("asset")]));
        setDebts(stripLive(data.debts||[blankItem("debt")]));
        if(data.income)   setIncome(data.income);
        if(data.expenses) setExpenses(data.expenses);
        if(data.wallets)  setWallets(data.wallets);
      }
    });
  },[user?.id]);

  // ── Auto-save on every change ────────────────────────────────────────────────
  useEffect(()=>{
    if (!user) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(()=>{
      dbSave(user.id, {assets,debts,income,expenses,wallets});
      setSavedAt(new Date());
    },1200);
    return ()=>clearTimeout(saveTimer.current);
  },[assets,debts,income,expenses,wallets,user?.id]);

  const totalAssets = assets.reduce((s,a)=>s+parseNum(a.value),0);
  const totalDebts  = debts.reduce((s,d)=>s+parseNum(d.value),0);
  const netWorth    = totalAssets-totalDebts;
  const daRatio     = totalAssets>0?totalDebts/totalAssets:0;
  const netColor    = netWorth>=0?"#30d158":"#ff453a";
  const netPct      = totalAssets>0?Math.max(0,Math.min(100,(netWorth/totalAssets)*100)):0;

  const addItem    = (type)=>{if(type==="asset")setAssets(p=>[...p,blankItem("asset")]);else setDebts(p=>[...p,blankItem("debt")]);};
  const updateItem = (type, id, f, v) => {
    const setter = type==="asset" ? setAssets : setDebts;
    setter(prev => prev.map(item => {
      if (item.id !== id) return item;
      const updated = {...item, [f]: v};
      // Auto-rollup: when holdings array changes, recompute institution total
      if (f === "holdings" && Array.isArray(v)) {
        const sum = v.reduce((s, h) => {
          const q = parseFloat(h.qty)||0;
          const p = parseFloat(h.price)||0;
          const computed = q>0 && p>0 ? q*p : parseNum(h.value);
          return s + computed;
        }, 0);
        if (sum > 0) updated.value = String(Math.round(sum));
      }
      return updated;
    }));
  };
  const removeItem  = (type,id)=>{const s=type==="asset"?setAssets:setDebts;s(p=>p.filter(i=>i.id!==id));};
  const reorderItems = (type,fromIdx,toIdx)=>{
    const setter = type==="asset"?setAssets:setDebts;
    setter(prev=>{
      const next = [...prev];
      const [moved] = next.splice(fromIdx,1);
      next.splice(toIdx,0,moved);
      return next;
    });
  };
  // Cash flow totals
  const totalIncome   = income.reduce((s,r)=>s+parseNum(r.amount),0);
  const totalExpenses = expenses.reduce((s,r)=>s+parseNum(r.amount),0);
  const monthlyCF     = totalIncome - totalExpenses;
  const savingsRate   = totalIncome>0?((totalIncome-totalExpenses)/totalIncome)*100:0;

  // Income CRUD
  const addIncome    = ()           => setIncome(p=>[...p,blankIncome()]);
  const updateIncome = (id,f,v)    => setIncome(p=>p.map(r=>r.id===id?{...r,[f]:v}:r));
  const removeIncome = (id)        => setIncome(p=>p.filter(r=>r.id!==id));

  // Expense CRUD
  const addExpense    = ()          => setExpenses(p=>[...p,blankExpense()]);
  const updateExpense = (id,f,v)   => setExpenses(p=>p.map(r=>r.id===id?{...r,[f]:v}:r));
  const removeExpense = (id)       => setExpenses(p=>p.filter(r=>r.id!==id));

  const reorderIncome = (from, to) => {
    if (to===null||to===undefined||from===to) return;
    setIncome(prev=>{ const next=[...prev]; const [m]=next.splice(from,1); next.splice(to,0,m); return next; });
  };
  const reorderExpense = (from, to) => {
    if (to===null||to===undefined||from===to) return;
    setExpenses(prev=>{ const next=[...prev]; const [m]=next.splice(from,1); next.splice(to,0,m); return next; });
  };

  const handleLookup = useCallback(async(type,item)=>{
    const set=type==="asset"?setAssets:setDebts;
    set(p=>p.map(i=>i.id===item.id?{...i,liveStatus:"loading",liveNote:""}:i));
    try {
      const r=await fetchLive(item.label,item.category,item.qty);
      set(p=>p.map(i=>i.id===item.id?{...i,value:String(Math.round(r.value)),liveStatus:"done",liveNote:[r.note,r.source,r.asOf].filter(Boolean).join(" · ")}:i));
    } catch(e) {
      set(p=>p.map(i=>i.id===item.id?{...i,liveStatus:"error",liveNote:e.message||"Lookup failed"}:i));
    }
  },[]);

  // Wallet CRUD
  const addWallet    = ()        => setWallets(p=>[...p, blankWallet()]);
  const removeWallet = (id)      => setWallets(p=>p.filter(w=>w.id!==id));
  const updateWallet = (id,f,v)  => setWallets(p=>p.map(w=>w.id===id?{...w,[f]:v}:w));
  const reorderWallets = (from, to) => {
    if (to===null||to===undefined||from===to) return;
    setWallets(prev=>{ const next=[...prev]; const [m]=next.splice(from,1); next.splice(to,0,m); return next; });
  };

  // Wallet-item import (from wallet tab → assets list)
  const handleImport = ({label,category,value,qty})=>{ setAssets(p=>[...p,{...blankItem("asset"),label,category,value,qty}]); setTab("assets"); };

  // Export: builds payload object for ExportModal
  const getExportData = () => {
    const jsonStr  = JSON.stringify({
      version:1, exportedAt:new Date().toISOString(),
      assets:stripLive(assets), debts:stripLive(debts), income, expenses, wallets,
    }, null, 2);
    const filename = `toavalon-portfolio-${new Date().toISOString().slice(0,10)}.json`;
    return { jsonStr, filename };
  };

  // Import: load portfolio from a JSON backup file
  const handleImportPortfolio = ({assets:a, debts:d, income:inc, expenses:exp, wallets:wal}) => {
    setAssets(stripLive(a||[blankItem("asset")]));
    setDebts(stripLive(d||[blankItem("debt")]));
    if(inc) setIncome(inc);
    if(exp) setExpenses(exp);
    if(wal) setWallets(wal);
    setSavedAt(null);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setAssets([blankItem("asset")]);
    setDebts([blankItem("debt")]);
    setIncome([blankIncome()]);
    setExpenses([blankExpense()]);
    setWallets([blankWallet()]);
    setSavedAt(null);
  };

  // Show nothing while checking auth
  if (!authReady) return (
    <div style={{minHeight:"100vh",background:"#060504",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#5a5040",fontFamily:FF,fontSize:14}}>Loading…</div>
    </div>
  );

  // Show login screen if not authenticated
  if (!user) return <LoginScreen onAuth={setUser}/>;

  const GLOBAL_STYLES = `
    @keyframes spin    { to { transform:rotate(360deg); } }
    @keyframes slideUp { from { transform:translateY(100%); } to { transform:translateY(0); } }
    @keyframes modalIn { from { opacity:0; transform:translateY(12px) scale(.98); } to { opacity:1; transform:none; } }
    * { box-sizing:border-box; }
    input, select { outline:none; }
    input::placeholder { color:#2a2520; }
    select option { background:#161412; color:#f0ece4; }
    .item-row:hover { background:rgba(200,160,80,.03)!important; }
    .item-row:hover .del-btn { opacity:1!important; }
    .add-btn:hover { opacity:.7; }
    ::-webkit-scrollbar { width:4px; }
    ::-webkit-scrollbar-thumb { background:#2a2520; border-radius:2px; }
  `;

  // ── SHARED NAV ──────────────────────────────────────────────────────────────
  const Nav = (
    <div style={{position:"sticky",top:0,zIndex:200,background:"rgba(6,5,4,.9)",backdropFilter:"blur(20px)",borderBottom:"1px solid rgba(200,160,80,.1)"}}>
      <div style={{maxWidth:isMobile?undefined:780,margin:"0 auto",padding:isMobile?"11px 16px":"12px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <Wordmark size="sm"/>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:12}}>
          <ViewToggle isMobile={isMobile} onToggle={setIsMobile}/>
          {!isMobile&&savedAt&&<span style={{fontSize:11,color:"#3a3530"}}>Saved {savedAt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
          {/* Settings button — export / import */}
          {!isMobile&&(
            <div onClick={()=>setShowSettings(true)}
              style={{background:"rgba(200,160,80,.1)",border:"1px solid rgba(200,160,80,.2)",borderRadius:20,color:GOLD,fontSize:13,fontWeight:600,fontFamily:FF,padding:"7px 16px",cursor:"pointer",userSelect:"none",transition:"all .18s"}}
              onMouseEnter={e=>e.currentTarget.style.background="rgba(200,160,80,.2)"}
              onMouseLeave={e=>e.currentTarget.style.background="rgba(200,160,80,.1)"}>
              ⚙ Data
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ── SHARED MODALS ───────────────────────────────────────────────────────────
  const Modals = <>
    {showSettings&&<SettingsSheet onClose={()=>setShowSettings(false)} getExportData={getExportData} onImport={handleImportPortfolio} onSignOut={handleSignOut} userEmail={user?.email}/>}
    {showTip&&<TipModal onClose={()=>setShowTip(false)}/>}
  </>;

  // ── MOBILE VIEW ─────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div style={{minHeight:"100vh",background:"#060504",color:"#f0ece4",fontFamily:FF,paddingBottom:80}}>
        <style>{GLOBAL_STYLES}</style>
        <div style={{position:"fixed",top:0,left:0,right:0,height:200,background:"radial-gradient(ellipse at 50% -10%, rgba(200,160,80,.06) 0%, transparent 70%)",pointerEvents:"none",zIndex:0}}/>
        {Nav}

        <div style={{padding:"0 16px 16px",position:"relative",zIndex:1}}>

          {/* Mobile Hero — compact */}
          <div style={{textAlign:"center",padding:"28px 0 22px"}}>
            <div style={{fontSize:11,color:"#6b6050",letterSpacing:".1em",textTransform:"uppercase",fontWeight:500,marginBottom:6}}>Net Worth</div>
            <div style={{fontSize:"clamp(40px,12vw,56px)",fontWeight:700,color:netColor,letterSpacing:"-.04em",lineHeight:1,transition:"color .4s"}}>
              {fmt(netWorth)}
            </div>
            {/* Progress bar */}
            <div style={{maxWidth:200,margin:"16px auto 0",height:3,background:"rgba(200,160,80,.1)",borderRadius:2,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${netPct}%`,background:`linear-gradient(90deg,${netColor},${netColor}88)`,borderRadius:2,transition:"width .6s cubic-bezier(.4,0,.2,1)"}}/>
            </div>
            {/* Compact stats row */}
            <div style={{display:"flex",justifyContent:"center",margin:"14px 0 0",gap:0,background:"rgba(22,20,18,.9)",borderRadius:14,border:"1px solid rgba(200,160,80,.1)",overflow:"hidden",maxWidth:320,marginLeft:"auto",marginRight:"auto"}}>
              <div style={{flex:1,padding:"12px 8px",textAlign:"center",borderRight:"1px solid rgba(200,160,80,.1)"}}>
                <div style={{fontSize:10,color:"#636366",marginBottom:3}}>Assets</div>
                <div style={{fontSize:14,fontWeight:700,color:"#30d158"}}>{fmtCompact(totalAssets)}</div>
              </div>
              <div style={{flex:1,padding:"12px 8px",textAlign:"center",borderRight:totalAssets>0?"1px solid rgba(200,160,80,.1)":"none"}}>
                <div style={{fontSize:10,color:"#636366",marginBottom:3}}>Liabilities</div>
                <div style={{fontSize:14,fontWeight:700,color:"#ff453a"}}>{fmtCompact(totalDebts)}</div>
              </div>
              {totalAssets>0&&<div style={{flex:1,padding:"12px 8px",textAlign:"center"}}>
                <div style={{fontSize:10,color:"#636366",marginBottom:3}}>D/A</div>
                <div style={{fontSize:14,fontWeight:700,color:daRatio<.4?"#30d158":daRatio<.7?"#ffd60a":"#ff453a"}}>{(daRatio*100).toFixed(0)}%</div>
              </div>}
            </div>
          </div>

          {/* Tab content */}
          {(tab==="all"||tab==="assets")&&<MobileSection title="Assets" color="#30d158" total={totalAssets} items={assets} type="asset" categories={ASSET_CATS} onUpdate={updateItem} onRemove={removeItem} onAdd={addItem} onLookup={handleLookup} onReorder={reorderItems}/>}
          {(tab==="all"||tab==="debts") &&<MobileSection title="Liabilities" color="#ff453a" total={totalDebts} items={debts} type="debt" categories={DEBT_CATS} onUpdate={updateItem} onRemove={removeItem} onAdd={addItem} onLookup={handleLookup} onReorder={reorderItems}/>}
          {tab==="cashflow"&&<BudgetPanel mobile={true}
            income={income} expenses={expenses}
            onAddIncome={addIncome} onUpdateIncome={updateIncome} onRemoveIncome={removeIncome}
            onAddExpense={addExpense} onUpdateExpense={updateExpense} onRemoveExpense={removeExpense}
            onReorderIncome={reorderIncome} onReorderExpense={reorderExpense}
          />}
          {tab==="wallet"&&<WalletsPanel mobile={true} wallets={wallets} onAdd={addWallet} onUpdate={updateWallet} onRemove={removeWallet} onReorder={reorderWallets}/>}

          {/* Tip link at bottom */}
          <div onClick={()=>setShowTip(true)} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"14px",marginTop:8,cursor:"pointer"}}>
            <span style={{fontSize:12,color:"#5a5040"}}>🍎 Support ToAvalon</span>
          </div>
        </div>

        {/* Mobile bottom tab nav */}
        <MobileBottomNav tab={tab} onTab={setTab} onSettings={()=>setShowSettings(true)}/>
        {Modals}
      </div>
    );
  }

  // ── Allocation breakdown by asset category ──────────────────────────────────
  const allocationData = (() => {
    const CAT_COLOR = {
      "Cash & Savings":"#64d2ff","Stocks / ETFs":"#30d158","Crypto":"#bf5af2",
      "Real Estate":GOLD,"Retirement":"#34c759","Vehicles":"#ff9f0a",
      "Business":"#ff6b6b","Other":"#636366",
    };
    const groups = {};
    assets.forEach(a=>{
      if(!groups[a.category]) groups[a.category]={val:0,color:CAT_COLOR[a.category]||"#636366"};
      groups[a.category].val += parseNum(a.value);
    });
    return Object.entries(groups)
      .map(([cat,{val,color}])=>({cat,val,color,pct:totalAssets>0?(val/totalAssets)*100:0}))
      .sort((a,b)=>b.val-a.val);
  })();

  // ── DESKTOP VIEW — The Vault ─────────────────────────────────────────────────
  return (
    <div style={{minHeight:"100vh",background:"#060504",color:"#f0ece4",fontFamily:FF,paddingBottom:48}}>
      <style>{GLOBAL_STYLES + `
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
        .vault-card { animation: fadeUp .35s ease both; }
        .kpi-tile:hover { border-color:rgba(200,160,80,.3)!important; background:rgba(22,20,18,1)!important; }
        .chain-btn:hover { background:rgba(200,160,80,.18)!important; }
      `}</style>

      {/* Ambient glow */}
      <div style={{position:"fixed",top:0,left:0,right:0,height:320,background:"radial-gradient(ellipse at 50% -20%, rgba(200,160,80,.07) 0%, transparent 65%)",pointerEvents:"none",zIndex:0}}/>

      {/* ── NAV ── */}
      <div style={{position:"sticky",top:0,zIndex:200,background:"rgba(6,5,4,.92)",backdropFilter:"blur(24px)",borderBottom:"1px solid rgba(200,160,80,.1)"}}>
        <div style={{maxWidth:1120,margin:"0 auto",padding:"11px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <Wordmark size="sm"/>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <ViewToggle isMobile={isMobile} onToggle={setIsMobile}/>
            {savedAt&&<span style={{fontSize:11,color:"#3a3530"}}>Saved {savedAt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
            {/* Cash Flow toggle */}
            <div className="chain-btn" onClick={()=>setTab(t=>t==="cashflow"?"all":"cashflow")}
              style={{background:tab==="cashflow"?"rgba(100,210,255,.15)":"rgba(200,160,80,.08)",border:`1px solid ${tab==="cashflow"?"#64d2ff":"rgba(200,160,80,.2)"}`,borderRadius:20,color:tab==="cashflow"?"#64d2ff":"#8a7040",fontSize:13,fontWeight:600,fontFamily:FF,padding:"6px 14px",cursor:"pointer",userSelect:"none",transition:"all .18s",display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:12}}>$</span> Cash Flow
            </div>
            {/* Wallets toggle */}
            <div className="chain-btn" onClick={()=>setTab(t=>t==="wallet"?"all":"wallet")}
              style={{background:tab==="wallet"?"rgba(191,90,242,.18)":"rgba(200,160,80,.08)",border:`1px solid ${tab==="wallet"?"#bf5af2":"rgba(200,160,80,.2)"}`,borderRadius:20,color:tab==="wallet"?"#bf5af2":"#8a7040",fontSize:13,fontWeight:600,fontFamily:FF,padding:"6px 14px",cursor:"pointer",userSelect:"none",transition:"all .18s",display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:12}}>◈</span> Wallets
            </div>
            <div onClick={()=>setShowSettings(true)}
              style={{background:"rgba(200,160,80,.08)",border:"1px solid rgba(200,160,80,.2)",borderRadius:20,color:"#8a7040",fontSize:13,fontWeight:600,fontFamily:FF,padding:"6px 14px",cursor:"pointer",userSelect:"none",transition:"all .18s"}}
              onMouseEnter={e=>e.currentTarget.style.background="rgba(200,160,80,.18)"}
              onMouseLeave={e=>e.currentTarget.style.background="rgba(200,160,80,.08)"}>
              ⚙ Data
            </div>
            <div onClick={handleSignOut}
              style={{background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.1)",borderRadius:20,color:"#636366",fontSize:13,fontWeight:600,fontFamily:FF,padding:"6px 14px",cursor:"pointer",userSelect:"none",transition:"all .18s"}}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(255,69,58,.1)";e.currentTarget.style.color="#ff453a";e.currentTarget.style.borderColor="rgba(255,69,58,.2)";}}
              onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,.05)";e.currentTarget.style.color="#636366";e.currentTarget.style.borderColor="rgba(255,255,255,.1)";}}>
              Sign Out
            </div>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1120,margin:"0 auto",padding:"0 28px",position:"relative",zIndex:1}}>

        {/* ── KPI ROW ── */}
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:12,padding:"24px 0 20px"}}>
          {/* Net Worth — hero tile */}
          <div className="kpi-tile" style={{background:"rgba(22,20,18,.95)",border:`1px solid rgba(200,160,80,.15)`,borderRadius:16,padding:"20px 24px",transition:"all .2s",cursor:"default",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${GOLD}88,${GOLD}22)`}}/>
            <div style={{fontSize:10,color:"#6b6050",letterSpacing:".1em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Net Worth</div>
            <div style={{fontSize:"clamp(28px,3.5vw,40px)",fontWeight:700,color:netColor,letterSpacing:"-.03em",lineHeight:1,transition:"color .4s"}}>{fmt(netWorth)}</div>
            {/* progress bar */}
            <div style={{height:2,background:"rgba(200,160,80,.1)",borderRadius:1,overflow:"hidden",marginTop:14}}>
              <div style={{height:"100%",width:`${netPct}%`,background:`linear-gradient(90deg,${netColor}cc,${netColor}55)`,borderRadius:1,transition:"width .8s cubic-bezier(.4,0,.2,1)"}}/>
            </div>
          </div>

          {/* Assets */}
          <div className="kpi-tile" style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(48,209,88,.12)",borderRadius:16,padding:"20px 20px",transition:"all .2s",cursor:"default",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,#30d15888,#30d15822)"}}/>
            <div style={{fontSize:10,color:"#3a6a44",letterSpacing:".1em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Total Assets</div>
            <div style={{fontSize:"clamp(20px,2.5vw,28px)",fontWeight:700,color:"#30d158",letterSpacing:"-.02em"}}>{fmt(totalAssets)}</div>
            <div style={{fontSize:11,color:"#3a5a40",marginTop:8}}>{assets.filter(a=>parseNum(a.value)>0).length} positions</div>
          </div>

          {/* Liabilities */}
          <div className="kpi-tile" style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(255,69,58,.12)",borderRadius:16,padding:"20px 20px",transition:"all .2s",cursor:"default",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,#ff453a88,#ff453a22)"}}/>
            <div style={{fontSize:10,color:"#6a3a34",letterSpacing:".1em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Total Debt</div>
            <div style={{fontSize:"clamp(20px,2.5vw,28px)",fontWeight:700,color:"#ff453a",letterSpacing:"-.02em"}}>{fmt(totalDebts)}</div>
            <div style={{fontSize:11,color:"#5a3a36",marginTop:8}}>{debts.filter(d=>parseNum(d.value)>0).length} liabilities</div>
          </div>

          {/* D/A Ratio */}
          <div className="kpi-tile" style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.12)",borderRadius:16,padding:"20px 20px",transition:"all .2s",cursor:"default",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${GOLD}88,${GOLD}22)`}}/>
            <div style={{fontSize:10,color:"#5a4a30",letterSpacing:".1em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>D/A Ratio</div>
            <div style={{fontSize:"clamp(20px,2.5vw,28px)",fontWeight:700,color:daRatio<.4?"#30d158":daRatio<.7?"#ffd60a":"#ff453a",letterSpacing:"-.02em"}}>{totalAssets>0?`${(daRatio*100).toFixed(1)}%`:"—"}</div>
            <div style={{fontSize:11,color:"#4a3a24",marginTop:8}}>{daRatio<.4?"Healthy leverage":daRatio<.7?"Moderate":"High leverage"}</div>
          </div>
        </div>

        {/* ── CASH FLOW PANEL ── */}
        {tab==="cashflow"&&(
          <BudgetPanel
            income={income} expenses={expenses}
            onAddIncome={addIncome} onUpdateIncome={updateIncome} onRemoveIncome={removeIncome}
            onAddExpense={addExpense} onUpdateExpense={updateExpense} onRemoveExpense={removeExpense}
            onReorderIncome={reorderIncome} onReorderExpense={reorderExpense}
          />
        )}

        {/* ── WALLETS PANEL (full-width when active) ── */}
        {tab==="wallet"&&(
          <div className="vault-card" style={{background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.12)",borderRadius:18,padding:"20px 28px",marginBottom:16}}>
            <WalletsPanel wallets={wallets} onAdd={addWallet} onUpdate={updateWallet} onRemove={removeWallet} onReorder={reorderWallets}/>
          </div>
        )}

        {/* ── MAIN GRID ── */}
        {tab!=="wallet"&&tab!=="cashflow"&&(
          <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:16,alignItems:"start"}}>

            {/* ── LEFT: Assets card ── */}
            <div className="vault-card" style={{animationDelay:".05s"}}>
              <DesktopSection title="Assets" color="#30d158" total={totalAssets} items={assets} type="asset" categories={ASSET_CATS} onUpdate={updateItem} onRemove={removeItem} onAdd={addItem} onLookup={handleLookup} onReorder={reorderItems}/>
            </div>

            {/* ── RIGHT COLUMN ── */}
            <div style={{display:"flex",flexDirection:"column",gap:16}}>

              {/* Liabilities card */}
              <div className="vault-card" style={{animationDelay:".1s"}}>
                <DesktopSection title="Liabilities" color="#ff453a" total={totalDebts} items={debts} type="debt" categories={DEBT_CATS} onUpdate={updateItem} onRemove={removeItem} onAdd={addItem} onLookup={handleLookup} onReorder={reorderItems}/>
              </div>

              {/* Allocation card */}
              {allocationData.length>0&&(
                <div className="vault-card" style={{animationDelay:".15s",background:"rgba(22,20,18,.95)",border:"1px solid rgba(200,160,80,.1)",borderRadius:18,padding:"20px 24px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                    <div style={{fontSize:14,fontWeight:600,color:"#f0ece4",letterSpacing:"-.01em"}}>Allocation</div>
                    <div style={{fontSize:12,color:"#636366"}}>{fmt(totalAssets)}</div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    {allocationData.map(({cat,val,color,pct})=>(
                      <div key={cat}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <div style={{width:7,height:7,borderRadius:"50%",background:color,flexShrink:0}}/>
                            <span style={{fontSize:12,color:"#c0b8a8"}}>{cat}</span>
                          </div>
                          <div style={{display:"flex",gap:12,alignItems:"baseline"}}>
                            <span style={{fontSize:11,color:"#6b6050"}}>{pct.toFixed(1)}%</span>
                            <span style={{fontSize:12,color,fontWeight:600,minWidth:80,textAlign:"right"}}>{fmt(val)}</span>
                          </div>
                        </div>
                        <div style={{height:4,background:"rgba(255,255,255,.06)",borderRadius:2,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:2,opacity:.75,transition:"width .6s cubic-bezier(.4,0,.2,1)"}}/>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Cash Flow summary card — only if income entered */}
              {totalIncome>0&&(
                <div className="vault-card" style={{animationDelay:".2s",background:"rgba(22,20,18,.95)",border:"1px solid rgba(100,210,255,.12)",borderRadius:18,padding:"20px 24px",position:"relative",overflow:"hidden"}}>
                  <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,#64d2ff88,#64d2ff22)"}}/>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                    <div style={{fontSize:14,fontWeight:600,color:"#f0ece4",letterSpacing:"-.01em"}}>Cash Flow</div>
                    <div onClick={()=>setTab("cashflow")}
                      style={{fontSize:11,color:"#64d2ff",cursor:"pointer",userSelect:"none",opacity:.8}}
                      onMouseEnter={e=>e.currentTarget.style.opacity=1}
                      onMouseLeave={e=>e.currentTarget.style.opacity=.8}>Edit →</div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                    {[["Monthly In",totalIncome,"#30d158"],["Monthly Out",totalExpenses,"#ff453a"]].map(([l,v,c])=>(
                      <div key={l}>
                        <div style={{fontSize:10,color:"#5a5040",letterSpacing:".06em",textTransform:"uppercase",marginBottom:3}}>{l}</div>
                        <div style={{fontSize:16,fontWeight:700,color:c}}>{fmt(v)}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{height:1,background:"rgba(200,160,80,.08)",marginBottom:12}}/>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                    <div>
                      <div style={{fontSize:10,color:"#5a5040",letterSpacing:".06em",textTransform:"uppercase",marginBottom:2}}>Monthly Net</div>
                      <div style={{fontSize:20,fontWeight:700,color:monthlyCF>=0?"#30d158":"#ff453a",letterSpacing:"-.02em"}}>{fmt(monthlyCF)}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:10,color:"#5a5040",letterSpacing:".06em",textTransform:"uppercase",marginBottom:2}}>Savings Rate</div>
                      <div style={{fontSize:20,fontWeight:700,letterSpacing:"-.02em",color:savingsRate>=20?"#30d158":savingsRate>=10?"#ffd60a":"#ff453a"}}>{savingsRate.toFixed(1)}%</div>
                    </div>
                  </div>
                  {/* Savings bar */}
                  <div style={{height:3,background:"rgba(255,255,255,.06)",borderRadius:2,overflow:"hidden",marginTop:10}}>
                    <div style={{height:"100%",width:`${Math.min(100,Math.max(0,savingsRate))}%`,borderRadius:2,
                                 background:savingsRate>=20?"#30d158":savingsRate>=10?"#ffd60a":"#ff453a",
                                 transition:"width .6s cubic-bezier(.4,0,.2,1)"}}/>
                  </div>
                </div>
              )}

              {/* Footnote */}
              <p style={{fontSize:11,color:"#3a3530",textAlign:"center",margin:0}}>Prices via live web search · Not financial advice</p>
            </div>
          </div>
        )}
      </div>

      {/* Floating tip */}
      <div onClick={()=>setShowTip(true)} style={{position:"fixed",bottom:24,right:24,zIndex:300,display:"flex",alignItems:"center",gap:8,background:`linear-gradient(135deg,${GOLD2},${GOLD})`,borderRadius:50,padding:"10px 18px 10px 14px",cursor:"pointer",userSelect:"none",boxShadow:"0 4px 24px rgba(200,160,80,.25)",transition:"transform .15s,box-shadow .15s"}} onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.05)";e.currentTarget.style.boxShadow="0 6px 32px rgba(200,160,80,.4)";}} onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.boxShadow="0 4px 24px rgba(200,160,80,.25)";}}>
        <span style={{fontSize:16,lineHeight:1}}>🍎</span>
        <span style={{fontSize:13,fontWeight:700,color:"#1a1208",fontFamily:FF,letterSpacing:".01em"}}>Tip</span>
      </div>

      {Modals}
    </div>
  );
}
