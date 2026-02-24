const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--headless=new', '--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Fetch several tiles and analyze unique colors
  const result = await page.evaluate(async () => {
    const tiles = [
      { z: 15, x: 9649, y: 12315 },
      { z: 15, x: 9650, y: 12315 },
      { z: 15, x: 9651, y: 12315 },
      { z: 15, x: 9649, y: 12316 },
      { z: 15, x: 9650, y: 12316 },
      { z: 15, x: 9651, y: 12316 },
      { z: 15, x: 9652, y: 12316 },
      { z: 15, x: 9650, y: 12317 },
      { z: 15, x: 9651, y: 12317 },
    ];

    const colorMap = {};

    for (const tile of tiles) {
      try {
        const resp = await fetch(`http://localhost:8080/api/highlight?layerName=VISITED&z=${tile.z}&x=${tile.x}&y=${tile.y}&t=1`);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);

        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
          if (a === 0) continue; // skip transparent
          const key = `rgb(${r},${g},${b})`;
          if (!colorMap[key]) {
            colorMap[key] = { r, g, b, a, count: 0, hex: '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('') };
          }
          colorMap[key].count++;
        }
      } catch(e) {
        // skip failed tiles
      }
    }

    // Sort by count, return top colors
    return Object.values(colorMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map(c => ({ hex: c.hex, r: c.r, g: c.g, b: c.b, a: c.a, count: c.count }));
  });

  console.log('Top tile colors (from NYC plow activity tiles):');
  result.forEach((c, i) => {
    console.log(`  ${i+1}. ${c.hex} (r=${c.r}, g=${c.g}, b=${c.b}, a=${c.a}) - ${c.count} pixels`);
  });

  await browser.close();
})();
