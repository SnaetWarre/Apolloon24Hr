/**
 * The small window that shows as soon as Apolloon is opened, while the local server
 * opens the database and the main window loads. Without it nothing appears for a few
 * seconds, and people click the icon again.
 *
 * The page is self-contained (a data: URL with the logo and font inlined), because the
 * local server that serves everything else is not running yet.
 */
export const SPLASH_SIZE = { width: 420, height: 260 };

/** Background of the splash window and page; matches --bg in src/styles/tokens.css. */
export function splashBackground(dark: boolean): string {
  return dark ? '#1A1A1A' : '#F7F7F8';
}

export function splashHtml({
  dark,
  version,
  logoDataUrl,
  fontDataUrl,
}: {
  dark: boolean;
  version: string;
  logoDataUrl: string | null;
  fontDataUrl: string | null;
}): string {
  const ink = dark ? '#ECECEC' : '#18181B';
  const ink3 = dark ? '#8C8C8C' : '#71717A';
  const line = dark ? '#2E2E2E' : '#E4E4E7';
  const brand = dark ? '#5AA9F0' : '#0D78D3';
  const font = fontDataUrl
    ? `@font-face{font-family:"Geist";font-weight:100 900;src:url(${fontDataUrl}) format("woff2");}`
    : '';
  const mark = logoDataUrl
    ? `<div class="mark" role="img" aria-label="Apolloon"></div>`
    : `<div class="wordmark">Apolloon</div>`;
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Apolloon Telsysteem</title>
<style>
${font}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{display:grid;place-items:center;background:${splashBackground(dark)};color:${ink};
  font:14px/1.5 "Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  border:1px solid ${line};-webkit-app-region:drag;user-select:none;cursor:default;overflow:hidden}
main{display:grid;justify-items:center;gap:14px;padding:24px;text-align:center}
.mark{width:180px;height:54px;background:${ink};
  -webkit-mask:url(${logoDataUrl ?? ''}) center/contain no-repeat;mask:url(${logoDataUrl ?? ''}) center/contain no-repeat;
  animation:breathe 1.8s cubic-bezier(.4,0,.2,1) infinite}
.wordmark{font-size:28px;font-weight:700;letter-spacing:-.02em;animation:breathe 1.8s cubic-bezier(.4,0,.2,1) infinite}
.bar{position:relative;width:160px;height:3px;border-radius:3px;background:${line};overflow:hidden}
.bar::after{content:"";position:absolute;inset:0;width:40%;border-radius:3px;background:${brand};
  animation:slide 1.2s cubic-bezier(.4,0,.2,1) infinite}
#status{font-weight:500}
#slow{max-width:300px;color:${ink3};font-size:12.5px;opacity:0;transition:opacity .36s}
#slow.shown{opacity:1}
footer{position:fixed;bottom:12px;color:${ink3};font-size:12px;font-variant-numeric:tabular-nums}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.mark,.wordmark,.bar::after{animation:none}}
</style>
</head>
<body>
<main>
${mark}
<div class="bar" aria-hidden="true"></div>
<p id="status" role="status" aria-live="polite">Apolloon starten…</p>
<p id="slow">Dit duurt langer dan gewoonlijk. Een grote databank of een virusscanner kan het opstarten vertragen.</p>
</main>
<footer>Apolloon Telsysteem ${escapeHtml(version)}</footer>
<script>
window.setStatus = (text) => { document.getElementById('status').textContent = text; };
setTimeout(() => document.getElementById('slow').classList.add('shown'), 8000);
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
