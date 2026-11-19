const fonts = ['100px "Bebas Neue"', '100px "Racing Sans One"', 'bold 100px "League Spartan 2014"'];
await Promise.all(fonts.map((font) => document.fonts.load(font, document.body.textContent)));
await document.fonts.ready;
for (const node of document.querySelectorAll('text[data-fit]')) {
  const width = node.getComputedTextLength();
  const fit = Number(node.dataset.fit);
  if (width > fit) node.setAttribute('font-size', String((Number(node.getAttribute('font-size')) * fit) / width));
}
document.documentElement.dataset.wrappedReady = 'card';
