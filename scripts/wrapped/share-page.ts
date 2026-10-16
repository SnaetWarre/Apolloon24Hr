/**
 * The page behind the button in the mail: the runner's card and one button that opens the
 * phone's share menu with the image, where Instagram offers "Story". Instagram has no link
 * that posts a picture into a story; the share menu (Web Share API) is the one-tap way, and
 * it only works on an https page.
 */
export const SHARE_IMAGE_FILE = 'apolloon-24u-wrapped.png';

export function sharePageHtml({ name, year }: { name: string; year: number }): string {
  const title = `24u Wrapped ${year} van ${escapeHtml(name)}`;
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  body {
    margin: 0;
    min-height: 100svh;
    display: grid;
    align-content: start;
    justify-items: center;
    gap: 20px;
    padding: 24px 16px 40px;
    background: #162033;
    color: #ffffff;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    text-align: center;
  }
  img { width: min(100%, 360px); height: auto; border-radius: 16px; }
  /* Stays in view at the bottom of the screen, so the tap is there without scrolling past the card. */
  button {
    position: sticky;
    bottom: 20px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
    width: min(100%, 360px);
    padding: 16px 24px;
    border: 0;
    border-radius: 999px;
    background: #0d78d3;
    color: #ffffff;
    font-family: inherit;
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; }
  p { max-width: 360px; margin: 0; font-size: 15px; line-height: 1.4; color: #c9d4e3; }
  a { color: #9bd2fa; }
</style>
</head>
<body>
<img src="${SHARE_IMAGE_FILE}" alt="${title}" width="1080" height="1920">
<button id="share" type="button" disabled>Zet in je Instagram-story</button>
<p id="fallback" hidden>Hou je kaart ingedrukt om hem op te slaan, of <a href="${SHARE_IMAGE_FILE}" download>download hem hier</a>.</p>
<script>
  const button = document.getElementById('share');
  const fallback = document.getElementById('fallback');
  let file = null;
  // Fetched before the tap: Safari only opens the share menu right after a tap, not after a download.
  fetch('${SHARE_IMAGE_FILE}')
    .then((response) => response.blob())
    .then((blob) => {
      file = new File([blob], '${SHARE_IMAGE_FILE}', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) button.disabled = false;
      else {
        button.hidden = true;
        fallback.hidden = false;
      }
    })
    .catch(() => {
      button.hidden = true;
      fallback.hidden = false;
    });
  button.addEventListener('click', () => {
    // Only the image: with a text next to it, Instagram is left out of the menu on some phones.
    navigator.share({ files: [file] }).catch((error) => {
      if (error.name !== 'AbortError') fallback.hidden = false;
    });
  });
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
