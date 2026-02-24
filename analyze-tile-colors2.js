const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--headless=new', '--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // First, load the page and zoom in to where we can see plow data
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Zoom into midtown Manhattan where we saw plow data in the screenshots
  await page.evaluate(() => map.flyTo({ center: [-73.985, 40.748], zoom: 14, duration: 0 }));
  await page.waitForTimeout(5000);

  // Get the current map bounds and calculate which tiles are in view
  const tileInfo = await page.evaluate(() => {
    const zoom = Math.floor(map.getZoom());
    const bounds = map.getBounds();

    function lng2tile(lng, zoom) { return Math.floor((lng + 180) / 360 * Math.pow(2, zoom)); }
    function lat2tile(lat, zoom) { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)); }

    const minX = lng2tile(bounds.getWest(), zoom);
    const maxX = lng2tile(bounds.getEast(), zoom);
    const minY = lat2tile(bounds.getNorth(), zoom);
    const maxY = lat2tile(bounds.getSouth(), zoom);

    return { zoom, minX, maxX, minY, maxY };
  });

  console.log('Tile info:', JSON.stringify(tileInfo));

  // Try a range of tiles at zoom 14
  const result = await page.evaluate(async (tileInfo) => {
    const colorMap = {};
    let tilesWithData = 0;
    let tilesEmpty = 0;

    for (let x = tileInfo.minX; x <= tileInfo.maxX; x++) {
      for (let y = tileInfo.minY; y <= tileInfo.maxY; y++) {
        try {
          const resp = await fetch(`/api/highlight?layerName=VISITED&z=${tileInfo.zoom}&x=${x}&y=${y}&t=1`);
          if (!resp.ok) { tilesEmpty++; continue; }
          const blob = await resp.blob();
          if (blob.size < 100) { tilesEmpty++; continue; }
          const bmp = await createImageBitmap(blob);

          const canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;

          let hasPixels = false;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            if (a === 0) continue;
            hasPixels = true;
            const key = `${r},${g},${b}`;
            if (!colorMap[key]) {
              colorMap[key] = { r, g, b, a, count: 0, hex: '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('') };
            }
            colorMap[key].count++;
          }
          if (hasPixels) tilesWithData++;
          else tilesEmpty++;
        } catch(e) {
          tilesEmpty++;
        }
      }
    }

    const sorted = Object.values(colorMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    return { tilesWithData, tilesEmpty, colors: sorted };
  }, tileInfo);

  console.log(`Tiles with data: ${result.tilesWithData}, empty: ${result.tilesEmpty}`);
  console.log('\nTop tile colors (from NYC plow activity tiles):');
  result.colors.forEach((c, i) => {
    console.log(`  ${i+1}. ${c.hex} (r=${c.r}, g=${c.g}, b=${c.b}, a=${c.a}) - ${c.count} pixels`);
  });

  await browser.close();
})();
