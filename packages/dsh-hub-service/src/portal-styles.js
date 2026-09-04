export const portalStyles = String.raw`
  :root { color-scheme: dark; --bg:#0b1020; --panel:#12192b; --soft:#172033; --line:#253044; --text:#e7edf7; --muted:#8ea0b8; --accent:#6ea8fe; --good:#35d07f; --warn:#f6c85f; --bad:#ff7676; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 22px; border-bottom:1px solid var(--line); background:rgba(11,16,32,.96); position:sticky; top:0; z-index:3; }
  header h1 { font-size:17px; margin:0; letter-spacing:.2px; }
  .subtitle, .muted, .hint { color:var(--muted); }
  .subtitle { font-weight:400; font-size:13px; margin-left:8px; }
  .user { color:var(--muted); font-size:12px; }
  .layout { min-height:calc(100vh - 56px); display:grid; grid-template-columns:232px minmax(0, 1fr); }
  nav { border-right:1px solid var(--line); padding:18px 12px; background:#0d1424; }
  nav button { width:100%; display:block; margin:0 0 6px; padding:9px 10px; color:var(--muted); background:transparent; border:0; border-radius:8px; text-align:left; cursor:pointer; font-size:13px; }
  nav button.active { color:var(--text); background:var(--soft); }
  nav a { display:block; margin:14px 10px; color:var(--muted); font-size:12px; text-decoration:none; }
  main { width:100%; max-width:1320px; padding:24px; }
  section.hidden, .hidden { display:none !important; }
  .surface { border:1px solid var(--line); background:var(--panel); border-radius:14px; margin-bottom:18px; overflow:hidden; }
  .surface-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:16px 18px; border-bottom:1px solid var(--line); }
  .surface-head h2 { margin:0; font-size:15px; color:#cfe0ff; }
  .surface-head p { margin:4px 0 0; color:var(--muted); font-size:12px; }
  .surface-body { padding:16px 18px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:end; margin-bottom:14px; }
  label { display:block; margin:0 0 5px; color:var(--muted); font-size:11px; }
  input, select, textarea { background:#0b1222; border:1px solid var(--line); color:var(--text); border-radius:8px; padding:7px 9px; font-size:13px; min-height:34px; }
  textarea { min-width:320px; min-height:70px; resize:vertical; }
  button { background:#2d6cdf; color:white; border:0; border-radius:8px; padding:7px 11px; font-size:12px; cursor:pointer; }
  button.secondary { background:#283449; color:#d8e3f3; }
  button.danger { background:#9b2c2c; }
  button.ghost { background:transparent; color:#b7c6db; border:1px solid var(--line); }
  button:disabled { opacity:.48; cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; text-align:left; }
  th { color:var(--muted); font-weight:600; }
  tr:hover td { background:rgba(255,255,255,.02); }
  .badge { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:600; border:1px solid var(--line); color:#cbd8eb; background:#111a2c; white-space:nowrap; }
  .badge.online, .badge.active { color:#8ef0b8; background:#072a1a; border-color:#145c39; }
  .badge.offline, .badge.revoked, .badge.disabled { color:#ffaaa8; background:#351111; border-color:#7b2525; }
  .badge.warn { color:#ffe29b; background:#34280e; border-color:#7a5c16; }
  .mono, .key { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break:break-all; }
  .key { color:#f8d477; }
  .actions { display:flex; flex-wrap:wrap; gap:6px; }
  .empty { color:var(--muted); font-size:13px; padding:14px 0; }
  .grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; }
  .metric { padding:12px 0; border-bottom:1px solid var(--line); }
  .metric strong { display:block; font-size:22px; }
  .metric span { color:var(--muted); font-size:12px; }
  .pager { display:flex; align-items:center; gap:8px; justify-content:flex-end; margin-top:12px; color:var(--muted); font-size:12px; }
  .detail-grid { display:grid; grid-template-columns:minmax(280px, 360px) minmax(0, 1fr); gap:18px; align-items:start; }
  .stack { display:flex; flex-direction:column; gap:10px; }
  .notice { padding:10px 12px; border:1px solid #6b561f; background:#211b0d; color:#ffe4a1; border-radius:10px; font-size:12px; }
  #diagnosticsPanel pre { white-space:pre-wrap; word-break:break-word; background:#050914; border:1px solid var(--line); border-radius:10px; padding:12px; color:#cbd5e1; font-size:12px; }
  .recommendations { margin:10px 0 0; padding-left:18px; color:#cbd5e1; }
  #modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.64); z-index:10; }
  #modal.open { display:block; }
  #modal .frame { position:absolute; inset:4% 6%; background:#fff; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }
  #modal iframe { flex:1; width:100%; border:0; background:#fff; }
  #modal .bar { display:flex; align-items:center; justify-content:space-between; background:#12192b; padding:9px 14px; color:#e2e8f0; font-size:13px; }
  @media (max-width: 880px) {
    .layout { grid-template-columns:1fr; }
    nav { display:flex; overflow:auto; border-right:0; border-bottom:1px solid var(--line); }
    nav button { width:auto; white-space:nowrap; margin-right:6px; }
    main { padding:16px; }
    .grid, .detail-grid { grid-template-columns:1fr; }
  }
`;
